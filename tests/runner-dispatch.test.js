import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.ts';
import { provisionRunner } from '../src/control/runner-registry.ts';
import { now } from '../src/util.ts';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const origin = 'https://mcp.test';
const runtimeKey = 'R'.repeat(48);
const migrations = [
  '0001_init.sql', '0002_refresh_token_rotation.sql', '0003_resource_tool_policy.sql',
  '0003_runner_registry_leases.sql', '0004_runner_dispatch.sql', '0005_admin_totp.sql',
];

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) {
    sqlite.exec(readFileSync(new URL('../migrations/' + migration, import.meta.url), 'utf8'));
  }

  function statement(query, args = []) {
    return {
      query, args,
      bind(...next) { return statement(query, next); },
      async first() { return sqlite.prepare(query).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...args) }; },
      async run() { sqlite.prepare(query).run(...args); return { success: true }; },
    };
  }

  const db = {
    prepare(query) { return statement(query); },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map(({ query, args }) => {
          const prepared = sqlite.prepare(query);
          const results = prepared.reader ? prepared.all(...args) : (prepared.run(...args), []);
          return { success: true, results };
        });
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const messages = [];
  const env = {
    MCP_DB: db,
    MCP_RUNTIME_KEY: runtimeKey,
    MCP_DISPATCH_QUEUE: {
      async send(body) { messages.push(body); },
      async sendBatch(batch) { messages.push(...batch.map(item => item.body)); },
    },
  };
  return { env, sqlite, messages };
}

function request(path, body, bearer, method = 'POST') {
  return new Request(origin + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const call = (env, path, body, bearer) => worker.fetch(request(path, body, bearer), env);
const get = (env, path, bearer) => worker.fetch(request(path, undefined, bearer, 'GET'), env);
const dispatchBody = (key = 'runtime-attempt-00000001') => ({
  protocolVersion: 'v1',
  idempotencyKey: key,
  taskRef: 'runtime-task-42',
  resourceKey: 'workspace:project-a',
  requiredCapabilities: ['coding.patch', 'coding.test'],
  priority: 50,
  quotaKey: 'provider.codex',
  leaseSeconds: 300,
});

async function readyRunner(env, name = 'Runner 1') {
  const runner = await provisionRunner(env, {
    displayName: name,
    allowedCapabilities: ['coding.patch', 'coding.test'],
    maxConcurrency: 2,
  });
  const registration = await call(env, '/runner/register', {
    protocolVersion: 'v1', displayName: name,
    capabilities: ['coding.patch', 'coding.test'], maxConcurrency: 2,
  }, runner.token);
  assert.equal(registration.status, 200, await registration.clone().text());
  const heartbeat = await call(env, '/runner/heartbeat', {
    protocolVersion: 'v1', sequence: 1, activeConcurrency: 0,
  }, runner.token);
  assert.equal(heartbeat.status, 200, await heartbeat.clone().text());
  return runner;
}

async function wake(env, dispatchId) {
  let acknowledged = 0;
  await worker.queue({
    queue: 'mcp-hub-dispatch',
    messages: [{
      body: { dispatchId },
      ack() { acknowledged++; },
      retry() { throw new Error('Valid dispatch must not be retried'); },
    }],
  }, env);
  assert.equal(acknowledged, 1);
}

async function quota(env, token, sequence = 1, remaining = 2) {
  return call(env, '/runner/quota', {
    protocolVersion: 'v1', quotaKey: 'provider.codex', sequence,
    remaining, limit: 10, cooldownSeconds: 0,
  }, token);
}

test('provisioned Runner receives dispatch/quota scopes, while unrelated credentials are denied', async () => {
  const { env, sqlite } = fixture();
  try {
    const runner = await readyRunner(env);
    assert.equal((await quota(env, runner.token)).status, 200,
      'The credential issued by Runner Registry must authorize quota reports');
    assert.equal((await get(env, '/runner/dispatches/next', runner.token)).status, 200,
      'The same credential must authorize dispatch polling');
    assert.equal((await quota(env, 'not-a-runner')).status, 401);
    assert.equal((await get(env, '/runner/dispatches/next', runtimeKey)).status, 401);
    assert.equal((await call(env, '/control/dispatch', dispatchBody(), runner.token)).status, 401,
      'A Runner credential is not a Runtime credential');
    assert.equal((await call(env, '/control/dispatch', dispatchBody())).status, 401);
    assert.equal((await get(env, '/runner/dispatches/next', runner.token).then(r => r.json())).dispatch, null);
  } finally { sqlite.close(); }
});

test('Runtime to Runner dispatch, offer, accept, lease renewal, reconciliation and completion', async () => {
  const { env, sqlite, messages } = fixture();
  try {
    const runner = await readyRunner(env);
    assert.equal((await quota(env, runner.token)).status, 200);
    const created = await call(env, '/control/dispatch', dispatchBody(), runtimeKey);
    assert.equal(created.status, 202, await created.clone().text());
    const { dispatchId, status } = await created.json();
    assert.equal(status, 'queued');
    assert.match(dispatchId, /^dispatch_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(messages, [{ dispatchId }], 'Queue stores only the dispatch reference');
    const repeated = await call(env, '/control/dispatch', dispatchBody(), runtimeKey);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).dispatchId, dispatchId);
    assert.equal(messages.length, 1, 'Repeated idempotency key never republishes a new dispatch');
    assert.equal((await call(env, '/control/dispatch', { ...dispatchBody(), taskRef: 'different' }, runtimeKey)).status, 409);
    await wake(env, dispatchId);
    const polled = await get(env, '/runner/dispatches/next', runner.token);
    assert.equal(polled.status, 200);
    const { action, dispatch } = await polled.json();
    assert.equal(action, 'offer');
    assert.equal(dispatch.dispatchId, dispatchId);
    assert.equal(dispatch.taskRef, 'runtime-task-42');
    assert.deepEqual(dispatch.requiredCapabilities, ['coding.patch', 'coding.test']);
    assert.ok(!JSON.stringify(dispatch).includes('prompt'), 'Hub never transports task contents');
    const accepted = await call(env, '/runner/dispatches/accept', {
      dispatchId, leaseId: dispatch.leaseId,
    }, runner.token);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal((await call(env, '/runner/dispatches/accept', {
      dispatchId, leaseId: dispatch.leaseId,
    }, runner.token)).status, 409);
    const renewed = await call(env, '/runner/dispatches/renew', {
      dispatchId, leaseId: dispatch.leaseId, ttlSeconds: 300,
    }, runner.token);
    assert.equal(renewed.status, 200, await renewed.clone().text());
    const running = await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 1, state: 'running',
    }, runtimeKey);
    assert.equal(running.status, 200, await running.clone().text());
    assert.equal((await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 1, state: 'running',
    }, runtimeKey)).status, 409);
    const completed = await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 2, state: 'completed',
    }, runtimeKey);
    assert.equal(completed.status, 200, await completed.clone().text());
    const statusResponse = await get(env, '/control/dispatch?dispatchId=' + dispatchId, runtimeKey);
    assert.equal(statusResponse.status, 200);
    const saved = await statusResponse.json();
    assert.equal(saved.status, 'closed');
    assert.equal(saved.runtime_state, 'completed');
    assert.equal(sqlite.prepare('SELECT released_at FROM runner_leases WHERE lease_id=?').get(dispatch.leaseId).released_at > 0, true);
    assert.equal((await get(env, '/runner/dispatches/next', runner.token).then(r => r.json())).dispatch, null);
  } finally { sqlite.close(); }
});

test('Runner rejection releases its lease and cancellation cannot replay unsafe work', async () => {
  const { env, sqlite } = fixture();
  try {
    const runner = await readyRunner(env);
    assert.equal((await quota(env, runner.token)).status, 200);
    const created = await call(env, '/control/dispatch', dispatchBody('runtime-attempt-00000002'), runtimeKey);
    assert.equal(created.status, 202);
    const { dispatchId } = await created.json();
    await wake(env, dispatchId);
    const offer = (await get(env, '/runner/dispatches/next', runner.token).then(r => r.json())).dispatch;
    const rejected = await call(env, '/runner/dispatches/reject', {
      dispatchId, leaseId: offer.leaseId, reasonCode: 'busy',
    }, runner.token);
    assert.equal(rejected.status, 200, await rejected.clone().text());
    assert.equal(sqlite.prepare('SELECT status FROM runner_dispatches WHERE dispatch_id=?').get(dispatchId).status, 'queued');
    assert.equal(sqlite.prepare('SELECT released_at FROM runner_leases WHERE lease_id=?').get(offer.leaseId).released_at > 0, true);
    const cancel = await call(env, '/control/dispatch/cancel', { dispatchId }, runtimeKey);
    assert.equal(cancel.status, 200, await cancel.clone().text());
    assert.equal((await cancel.json()).status, 'cancelled');
    await wake(env, dispatchId);
    assert.equal((await get(env, '/runner/dispatches/next', runner.token).then(r => r.json())).dispatch, null);
    assert.equal((await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 1, state: 'running',
    }, runtimeKey)).status, 409);
  } finally { sqlite.close(); }
});

test('expired accepted lease remains held until Runtime explicitly confirms no execution', async () => {
  const { env, sqlite } = fixture();
  try {
    const runner = await readyRunner(env);
    assert.equal((await quota(env, runner.token)).status, 200);
    const created = await call(env, '/control/dispatch', dispatchBody('runtime-attempt-00000003'), runtimeKey);
    assert.equal(created.status, 202);
    const { dispatchId } = await created.json();
    await wake(env, dispatchId);
    const offer = (await get(env, '/runner/dispatches/next', runner.token).then(r => r.json())).dispatch;
    assert.equal((await call(env, '/runner/dispatches/accept', {
      dispatchId, leaseId: offer.leaseId,
    }, runner.token)).status, 200);
    sqlite.prepare('UPDATE runner_leases SET expires_at=? WHERE lease_id=?').run(now() - 1, offer.leaseId);
    await worker.scheduled({ cron: '* * * * *' }, env);
    const held = sqlite.prepare('SELECT status,runtime_state FROM runner_dispatches WHERE dispatch_id=?').get(dispatchId);
    assert.equal(held.status, 'held');
    assert.equal(held.runtime_state, 'side_effects_uncertain');
    assert.equal((await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 1, state: 'side_effects_uncertain',
    }, runtimeKey)).status, 200);
    assert.equal(sqlite.prepare('SELECT status FROM runner_dispatches WHERE dispatch_id=?').get(dispatchId).status, 'held');
    const noStart = await call(env, '/control/dispatch/reconcile', {
      dispatchId, sequence: 2, state: 'not_started',
    }, runtimeKey);
    assert.equal(noStart.status, 200, await noStart.clone().text());
    assert.equal((await noStart.json()).status, 'queued');
    assert.equal(sqlite.prepare('SELECT released_at FROM runner_leases WHERE lease_id=?').get(offer.leaseId).released_at > 0, true);
  } finally { sqlite.close(); }
});
