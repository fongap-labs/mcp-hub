import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeTaskJournal } from '../runtime/sqlite-task-journal.mjs';
import { createAuthorizedTaskProducer, TaskSubmissionError } from '../runtime/authorized-task-producer.mjs';
import { startLoopbackRuntimeTaskService } from '../runtime/authenticated-task-service.mjs';

const REPO = 'fongap-labs/demo';
const SOURCE = 'a'.repeat(40);
const TOKEN = 'github_pat_' + 't'.repeat(48);
const DISPATCH = 'dispatch_' + 'd'.repeat(43);
const REQUEST_ID = 'task-request-000001';
const BODY = { requestId: REQUEST_ID, repository: REPO, sourceSha: SOURCE,
  prompt: 'Fix the failing tests in the authorized repository.' };

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-intake-test-'));
  const journal = new RuntimeTaskJournal({
    databasePath: join(directory, 'task.db'), encryptionKey: Buffer.alloc(32, 42),
  });
  const calls = [], dispatched = [];
  const githubFetch = async (url, config) => {
    assert.equal(config.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(config.redirect, 'error');
    calls.push(url);
    const path = new URL(url).pathname;
    let value;
    if (path === '/user') value = { id: 1001, login: 'authorized-dev', type: 'User' };
    else if (path === '/repos/' + REPO) value = {
      full_name: REPO, default_branch: 'main', permissions: { push: true },
      archived: false, disabled: false,
    };
    else if (path === '/repos/' + REPO + '/commits/main') value = { sha: SOURCE };
    else throw new Error('Unexpected GitHub endpoint ' + path);
    if (typeof options.mutate === 'function') value = options.mutate(path, value);
    return new Response(JSON.stringify(value), { status: 200 });
  };
  let failOnce = options.failOnce ?? false;
  const hub = {
    async create(input) {
      dispatched.push(input);
      if (failOnce) { failOnce = false; throw new Error('Hub dispatch response lost'); }
      return { dispatchId: DISPATCH, status: 'queued' };
    },
    async get() { throw new Error('Hub status not expected in intake'); },
    async reconcile() { throw new Error('Hub reconcile not expected in intake'); },
  };
  const producer = createAuthorizedTaskProducer({
    journal, runtimeClient: hub,
    allowedActors: options.actors ?? [{ id: 1001, login: 'authorized-dev' }],
    allowedRepositories: options.repos ?? [REPO],
    githubFetch,
  });
  const start = async (enabled = true) => {
    const server = await startLoopbackRuntimeTaskService({
      journal, runtimeClient: hub, taskProducer: enabled ? producer : null,
      executor: { async execute() { throw new Error('Never execute from intake'); } },
      runnerCredentials: [{ runnerId: 'runner_' + 'r'.repeat(43), token: 'rtkn_' + 's'.repeat(48) }],
    });
    return { server, url: 'http://127.0.0.1:' + server.address().port,
      stop: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
  };
  return { journal, directory, calls, dispatched, start,
    cleanup: () => { journal.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function submit(url, data = BODY, token = TOKEN) {
  return fetch(url + '/runtime/v1/tasks/submit', {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(data),
  });
}

test('GitHub-verified request is encrypted locally; Hub sees only stable references', async () => {
  const fx = fixture(), app = await fx.start();
  try {
    const response = await submit(app.url);
    assert.equal(response.status, 202, await response.clone().text());
    const result = await response.json();
    assert.equal(result.dispatchId, DISPATCH);
    assert.equal(result.status, 'dispatched');
    assert.equal(result.replayed, false);
    assert.match(result.taskRef, /^task_[a-f0-9]{64}$/);
    assert.equal(fx.dispatched.length, 1);
    assert.deepEqual(fx.dispatched[0], {
      protocolVersion: 'v1', idempotencyKey: result.taskRef,
      taskRef: result.taskRef, resourceKey: 'repo:fongap-labs_demo',
      requiredCapabilities: ['coding.patch'], priority: 50,
      quotaKey: null, leaseSeconds: 300,
    });
    assert.equal(JSON.stringify(fx.dispatched).includes(BODY.prompt), false);
    assert.equal(JSON.stringify(result).includes(BODY.prompt), false);
    assert.equal(JSON.stringify(fx.dispatched).includes(TOKEN), false);
    const disk = readFileSync(join(fx.directory, 'task.db')).toString('utf8');
    assert.equal(disk.includes(BODY.prompt), false);
    const row = fx.journal.inspectSubmission(result.taskRef);
    assert.equal(row.state, 'dispatched');
    assert.equal(row.dispatchId, DISPATCH);
    assert.deepEqual(fx.calls.map(s => new URL(s).pathname), [
      '/user', '/repos/' + REPO, '/repos/' + REPO + '/commits/main',
    ]);
    const repeat = await submit(app.url);
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).replayed, true);
    assert.equal(fx.dispatched.length, 1, 'same request ID cannot create a second dispatch');
  } finally { await app.stop(); fx.cleanup(); }
});

test('same request ID with changed content fails closed, not a second execution', async () => {
  const fx = fixture(), app = await fx.start();
  try {
    assert.equal((await submit(app.url)).status, 202);
    const mismatch = await submit(app.url, { ...BODY, prompt: 'Try a different destructive operation.' });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error, 'task_idempotency_conflict');
    assert.equal(fx.dispatched.length, 1);
  } finally { await app.stop(); fx.cleanup(); }
});

test('GitHub source update and unapproved actor/repository cannot dispatch', async () => {
  for (const overrides of [
    { mutate: (path, data) => path === '/user' ? { ...data, id: 2002 } : data },
    { mutate: (path, data) => path === '/repos/' + REPO ?
      { ...data, permissions: { push: false } } : data },
    { mutate: (path, data) => path.endsWith('/commits/main') ?
      { ...data, sha: 'b'.repeat(40) } : data },
  ]) {
    const fx = fixture({ mutate: overrides.mutate }), app = await fx.start();
    try {
      const reply = await submit(app.url);
      assert.equal(reply.status, overrides.mutate('/repos/' + REPO + '/commits/main', { sha: SOURCE }).sha !== SOURCE ? 409 : 403);
      assert.equal(fx.dispatched.length, 0);
      assert.equal(fx.journal.recoveryPlan().length, 0);
    } finally { await app.stop(); fx.cleanup(); }
  }
});

test('anonymous and invalid payloads are denied; task intake is disabled by default', async () => {
  const fx = fixture(), app = await fx.start();
  const disabled = await fx.start(false);
  try {
    assert.equal((await submit(app.url, BODY, '')).status, 401);
    assert.equal((await submit(app.url, { ...BODY, actorId: 1001 })).status, 400);
    assert.equal((await submit(app.url, { ...BODY, repository: 'outside-org/repo' })).status, 400);
    assert.equal((await submit(app.url, { ...BODY, prompt: 'x'.repeat(20000) })).status, 400);
    assert.equal((await submit(disabled.url)).status, 404);
    assert.equal(fx.dispatched.length, 0);
  } finally { await app.stop(); await disabled.stop(); fx.cleanup(); }
});

test('ambiguous Hub response leaves prepared task for idempotent retry', async () => {
  const fx = fixture({ failOnce: true }), app = await fx.start();
  try {
    const first = await submit(app.url);
    assert.equal(first.status, 503);
    assert.equal((await first.json()).error, 'task_dispatch_pending_retry');
    assert.equal(fx.journal.recoveryPlan().length, 1);
    assert.equal(fx.journal.recoveryPlan()[0].state, 'prepared');
    const second = await submit(app.url);
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.replayed, true);
    assert.equal(fx.dispatched.length, 2);
    assert.equal(fx.dispatched[0].idempotencyKey, fx.dispatched[1].idempotencyKey);
    assert.equal(fx.journal.inspectSubmission(body.taskRef).dispatchId, DISPATCH);
  } finally { await app.stop(); fx.cleanup(); }
});

test('empty actor policy and missing workspace allowlist refuse task producer startup', () => {
  const fx = fixture();
  try {
    assert.throws(() => createAuthorizedTaskProducer({
      journal: fx.journal, runtimeClient: { create() {} },
      allowedActors: [], allowedRepositories: [REPO],
    }), /trusted_github_actors_required/);
    assert.throws(() => createAuthorizedTaskProducer({
      journal: fx.journal, runtimeClient: { create() {} },
      allowedActors: [{ id: 1001, login: 'authorized-dev' }], allowedRepositories: [],
    }), /approved_task_repositories_required/);
  } finally { fx.cleanup(); }
});
