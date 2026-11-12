import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HubBridgeError, RunnerDispatchClient, RuntimeDispatchClient, claimRunnerTask,
} from '../src/control/runner-runtime-client.ts';

const hub = 'https://mcp.example';
const runtimeKey = 'r'.repeat(48);
const runnerToken = 'x'.repeat(48);
const dispatchId = 'dispatch_' + 'a'.repeat(43);
const leaseId = 'lease_' + 'b'.repeat(43);
const offer = {
  dispatchId, leaseId, taskRef: 'runtime-task-42', resourceKey: 'workspace:project-a',
  requiredCapabilities: ['coding.patch', 'coding.test'], priority: 50, quotaKey: null,
  expiresAt: '2026-11-12T10:00:00Z', leaseExpiresAt: '2026-11-12T10:04:00Z',
};
const dispatch = {
  protocolVersion: 'v1', idempotencyKey: 'request-000000000001', taskRef: offer.taskRef,
  resourceKey: offer.resourceKey, requiredCapabilities: offer.requiredCapabilities,
  priority: 50, quotaKey: null, leaseSeconds: 300,
};

function transport(responses) {
  const calls = [];
  const fetchPort = async (url, options) => {
    calls.push({ url, options });
    const reply = responses.shift();
    if (!reply) throw new Error('Unexpected bridge HTTP call');
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchPort };
}

test('Runtime and Runner clients have separate credentials and endpoint sets', async () => {
  const mock = transport([
    { body: { dispatchId, status: 'queued' } },
    { body: { dispatch_id: dispatchId, status: 'accepted' } },
    { body: { ok: true, status: 'cancel_requested' } },
    { body: { ok: true, status: 'closed', runtimeSequence: 1 } },
    { body: { ok: true } },
    { body: { ok: true } },
    { body: { ok: true } },
    { body: { dispatch: null } },
    { body: { ok: true, status: 'accepted' } },
    { body: { ok: true, status: 'queued' } },
    { body: { ok: true, expiresAt: '2026-11-12T10:05:00Z' } },
  ]);
  const runtime = new RuntimeDispatchClient(hub, runtimeKey, mock.fetchPort);
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  await runtime.create(dispatch);
  await runtime.get(dispatchId);
  await runtime.cancel(dispatchId);
  await runtime.reconcile(dispatchId, 1, 'completed');
  await runner.register({ protocolVersion: 'v1', displayName: 'worker',
    capabilities: ['coding.patch'], maxConcurrency: 1 });
  await runner.heartbeat({ protocolVersion: 'v1', sequence: 1, activeConcurrency: 0 });
  await runner.quota({ protocolVersion: 'v1', quotaKey: 'provider.codex',
    sequence: 1, remaining: 1, limit: 10, cooldownSeconds: 0 });
  assert.deepEqual(await runner.next(), { dispatch: null });
  await runner.accept(dispatchId, leaseId);
  await runner.reject(dispatchId, leaseId, 'busy');
  await runner.renew(dispatchId, leaseId, 300);

  assert.deepEqual(mock.calls.map(x => new URL(x.url).pathname), [
    '/control/dispatch', '/control/dispatch', '/control/dispatch/cancel',
    '/control/dispatch/reconcile', '/runner/register', '/runner/heartbeat',
    '/runner/quota', '/runner/dispatches/next', '/runner/dispatches/accept',
    '/runner/dispatches/reject', '/runner/dispatches/renew',
  ]);
  assert.equal(new URL(mock.calls[1].url).searchParams.get('dispatchId'), dispatchId);
  for (const [index, { url, options }] of mock.calls.entries()) {
    assert.equal(new URL(url).origin, hub);
    assert.equal(options.redirect, 'error', 'Refuse cross-origin bearer forwarding');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization,
      'Bearer ' + (index < 4 ? runtimeKey : runnerToken));
    assert.equal(options.method, [1, 7].includes(index) ? 'GET' : 'POST');
  }
  const payloads = mock.calls.map(c => c.options.body ?? '');
  assert.ok(!payloads.some(p => p.includes('prompt') || p.includes('private_code')),
    'Hub must see only references, not coding prompts');
});

test('claim adapter accepts the offer before Runtime task retrieval', async () => {
  const mock = transport([
    { body: { action: 'offer', dispatch: offer } },
    { body: { ok: true, dispatchId, status: 'accepted' } },
  ]);
  const events = [];
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  const result = await claimRunnerTask(runner, {
    async loadAcceptedTask(input) {
      events.push({ phase: 'lookup', input });
      assert.equal(mock.calls.length, 2, 'Cannot load before acceptance');
      return { sourceSha: 'f'.repeat(40), repository: 'fongap-labs/sample' };
    },
    async cancellationRequested() { throw new Error('Not a cancellation'); },
  });
  assert.equal(result.kind, 'accepted');
  assert.equal(result.task.repository, 'fongap-labs/sample');
  assert.deepEqual(events.map(x => x.phase), ['lookup']);
  assert.equal(mock.calls.length, 2);
  assert.ok(!mock.calls[1].options.body.includes('sourceSha'));
});

test('idle or cancellation never obtains task bodies or starts an execution', async () => {
  const mock = transport([
    { body: { dispatch: null } },
    { body: { action: 'cancel', dispatch: offer } },
  ]);
  let loads = 0, cancellations = 0;
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  const runtime = {
    async loadAcceptedTask() { loads++; throw new Error('Unexpected task load'); },
    async cancellationRequested(input) { cancellations++; assert.equal(input.dispatchId, dispatchId); },
  };
  assert.deepEqual(await claimRunnerTask(runner, runtime), { kind: 'idle' });
  assert.deepEqual(await claimRunnerTask(runner, runtime),
    { kind: 'cancel_requested', dispatchId });
  assert.equal(loads, 0);
  assert.equal(cancellations, 1);
  assert.equal(mock.calls.length, 2, 'No accept for idle or cancel');
});

test('failed acceptance fails closed and never invokes Runtime task retrieval', async () => {
  const mock = transport([
    { body: { action: 'offer', dispatch: offer } },
    { status: 409, body: { error: 'dispatch_conflict' } },
  ]);
  let loads = 0;
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  await assert.rejects(claimRunnerTask(runner, {
    async loadAcceptedTask() { loads++; return {}; },
    async cancellationRequested() {},
  }), err => err instanceof HubBridgeError &&
    err.status === 409 && err.code === 'dispatch_conflict');
  assert.equal(loads, 0);
});

test('task lookup failure after acceptance never auto-rejects or requeues', async () => {
  const mock = transport([
    { body: { action: 'offer', dispatch: offer } },
    { body: { ok: true, status: 'accepted' } },
  ]);
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  await assert.rejects(claimRunnerTask(runner, {
    async loadAcceptedTask() { throw new Error('Runtime unreachable'); },
    async cancellationRequested() {},
  }), /Runtime unreachable/);
  assert.equal(mock.calls.length, 2, 'Runtime must reconcile uncertain accepted work');
});

test('malformed offers, unsafe hub URLs and invalid credentials are rejected before execution', async () => {
  assert.throws(() => new RunnerDispatchClient('http://mcp.example', runnerToken), /https_origin/);
  assert.throws(() => new RunnerDispatchClient('https://mcp.example/evil', runnerToken), /https_origin/);
  assert.throws(() => new RunnerDispatchClient('https://evil@hub.example', runnerToken), /https_origin/);
  assert.throws(() => new RuntimeDispatchClient(hub, 'short'), /invalid_hub_bearer/);
  const mock = transport([{ body: { action: 'offer', dispatch: { ...offer, taskRef: '../../secrets' } } }]);
  let taskLoads = 0;
  await assert.rejects(claimRunnerTask(new RunnerDispatchClient(hub, runnerToken, mock.fetchPort), {
    async loadAcceptedTask() { taskLoads++; },
    async cancellationRequested() {},
  }), err => err instanceof HubBridgeError && err.code === 'invalid_runner_offer');
  assert.equal(taskLoads, 0);
  assert.equal(mock.calls.length, 1);
});

test('Hub error codes omit response bodies and credentials', async () => {
  const mock = transport([{ status: 401, body: { error: 'Unauthorized', leaked: runnerToken } }]);
  const runner = new RunnerDispatchClient(hub, runnerToken, mock.fetchPort);
  await assert.rejects(runner.next(), error => {
    assert.equal(error.status, 401);
    assert.equal(error.code, 'Unauthorized');
    assert.ok(!String(error).includes(runnerToken));
    return true;
  });
});
