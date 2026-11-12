import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeTaskJournal } from '../runtime/sqlite-task-journal.mjs';
import {
  createTrustedRuntimeTaskPort, flushRuntimeReconciliations,
} from '../runtime/runtime-task-port.mjs';
import { RunnerDispatchClient, RuntimeDispatchClient, claimRunnerTask } from '../src/control/runner-runtime-client.ts';

const taskRef = 'coding-task-42';
const resourceKey = 'workspace:demo';
const dispatchId = 'dispatch_' + 'a'.repeat(43);
const runnerId = 'runner_' + 'b'.repeat(43);
const otherRunnerId = 'runner_' + 'c'.repeat(43);
const leaseId = 'lease_' + 'd'.repeat(43);
const otherLeaseId = 'lease_' + 'e'.repeat(43);
const time = Date.UTC(2026, 10, 12, 11, 0, 0);
const offer = {
  taskRef, resourceKey, dispatchId, leaseId, priority: 50,
  quotaKey: null, requiredCapabilities: ['coding.patch'],
  expiresAt: new Date(time + 60000).toISOString(),
  leaseExpiresAt: new Date(time + 300000).toISOString(),
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-runtime-journal-'));
  const file = join(dir, 'runtime.db');
  const key = Buffer.alloc(32, 17);
  const clock = () => time;
  const open = (k = key) => new RuntimeTaskJournal({ databasePath: file, encryptionKey: k, clock });
  return { dir, file, key, open, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function hubStatus(overrides = {}) {
  return {
    dispatch_id: dispatchId, task_ref: taskRef, resource_key: resourceKey,
    status: 'accepted', runner_id: runnerId, lease_id: leaseId,
    lease_expires_at: Math.floor(time / 1000) + 300, ...overrides,
  };
}
function fakeRuntime(status = hubStatus()) {
  return {
    async get(id) { assert.equal(id, dispatchId); return status; },
  };
}
function createTask(journal) {
  journal.createTask({ taskRef, resourceKey, task: {
    repository: 'fongap-labs/demo', prompt: 'private source: NEVER EXPOSE', input: { file: 'src/main.ts' },
  } });
  journal.attachDispatch(taskRef, dispatchId);
}
function jsonFetch(status, expectedCalls = []) {
  return async (url, options) => {
    expectedCalls.push({ url, options });
    const u = new URL(url);
    assert.equal(u.origin, 'https://mcp.test');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, 'Bearer ' + 'R'.repeat(48));
    if (u.pathname === '/control/dispatch' && options.method === 'GET') {
      return new Response(JSON.stringify(status), { status: 200 });
    }
    if (u.pathname === '/control/dispatch/reconcile') {
      const data = JSON.parse(options.body);
      const mapped = {
        running: 'accepted', completed: 'closed', failed: 'closed',
        cancelled: 'cancelled', side_effects_uncertain: 'held', not_started: 'queued',
      };
      return new Response(JSON.stringify({
        ok: true, dispatchId: data.dispatchId, runtimeSequence: data.sequence,
        status: mapped[data.state],
      }), { status: 200 });
    }
    throw new Error('Unexpected runtime HTTP request: ' + u.pathname);
  };
}
function runtimeClient(status) {
  return new RuntimeDispatchClient('https://mcp.test', 'R'.repeat(48), jsonFetch(status));
}

test('SQLite Runtime journal encrypts task/result and survives reopen without replay', async () => {
  const fx = fixture();
  try {
    let journal = fx.open();
    createTask(journal);
    assert.equal(statSync(fx.file).mode & 0o777, 0o600);
    const client = runtimeClient(hubStatus());
    const runtimePort = createTrustedRuntimeTaskPort({
      journal, runtimeClient: client, authenticatedRunnerId: runnerId,
    });
    const runner = new RunnerDispatchClient('https://mcp.test', 'mcrn_' + 'x'.repeat(43),
      async (url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer ' + 'mcrn_' + 'x'.repeat(43));
        const result = new URL(url).pathname === '/runner/dispatches/next'
          ? { action: 'offer', dispatch: offer } : { ok: true, status: 'accepted' };
        return new Response(JSON.stringify(result), { status: 200 });
      });
    const handoff = await claimRunnerTask(runner, runtimePort);
    assert.equal(handoff.kind, 'accepted');
    assert.equal(handoff.task.prompt, 'private source: NEVER EXPOSE');
    assert.deepEqual(journal.recoveryPlan().find(x => x.taskRef === taskRef).report, null);
    assert.equal(await journal.beginSideEffects(taskRef, runnerId, leaseId, client), 3);
    assert.rejects(journal.beginSideEffects(taskRef, runnerId, leaseId, client), /runtime_task_conflict/);
    assert.equal(journal.complete(taskRef, runnerId, leaseId, 'completed', { filesChanged: 2 }), 4);
    assert.deepEqual(journal.result(taskRef), { filesChanged: 2 });
    journal.close();
    const onDisk = readFileSync(fx.file).toString('utf8');
    assert.ok(!onDisk.includes('private source: NEVER EXPOSE'));
    assert.ok(!onDisk.includes('filesChanged'));
    journal = fx.open();
    assert.deepEqual(journal.result(taskRef), { filesChanged: 2 });
    const pending = journal.recoveryPlan().find(x => x.taskRef === taskRef);
    assert.deepEqual(pending.report, { dispatchId, sequence: 4, state: 'completed' });
    const acknowledged = await flushRuntimeReconciliations({ journal, runtimeClient: client });
    assert.deepEqual(acknowledged, [{ taskRef, sequence: 4, state: 'completed' }]);
    assert.equal(journal.recoveryPlan().find(x => x.taskRef === taskRef).report, null);
    assert.deepEqual(await flushRuntimeReconciliations({ journal, runtimeClient: client }), []);
    journal.close();
  } finally { fx.cleanup(); }
});

test('lease ownership, active status and expiry are verified before revealing task', async () => {
  const fx = fixture();
  try {
    const j = fx.open(); createTask(j);
    const bad = [
      [otherRunnerId, hubStatus(), 'runtime_lease_not_authorized'],
      [runnerId, hubStatus({ lease_id: otherLeaseId }), 'runtime_lease_not_authorized'],
      [runnerId, hubStatus({ status: 'cancel_requested' }), 'runtime_lease_not_authorized'],
      [runnerId, hubStatus({ lease_expires_at: Math.floor(time / 1000) - 1 }), 'runtime_lease_not_authorized'],
      [runnerId, hubStatus({ task_ref: 'coding-task-other' }), 'runtime_lease_not_authorized'],
      [runnerId, hubStatus({ resource_key: 'workspace:other' }), 'runtime_lease_not_authorized'],
    ];
    for (const [identity, status, expected] of bad) {
      await assert.rejects(j.claimAcceptedTask(offer, identity, fakeRuntime(status)),
        new RegExp(expected));
      assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).state, 'dispatched');
    }
    const payload = await j.claimAcceptedTask(offer, runnerId, fakeRuntime());
    assert.equal(payload.repository, 'fongap-labs/demo');
    await assert.rejects(j.claimAcceptedTask(offer, runnerId, fakeRuntime()), /runtime_task_conflict/);
    await assert.rejects(j.beginSideEffects(taskRef, runnerId, leaseId,
      fakeRuntime(hubStatus({ lease_expires_at: Math.floor(time / 1000) - 1 }))),
    /runtime_lease_not_authorized/);
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).state, 'claimed');
    j.close();
  } finally { fx.cleanup(); }
});

test('restart fences claimed or started work as uncertain, never replays automatically', async () => {
  const fx = fixture();
  try {
    let j = fx.open();
    createTask(j);
    await j.claimAcceptedTask(offer, runnerId, fakeRuntime());
    j.close();
    j = fx.open();
    let plan = j.recoverAfterRestart().find(x => x.taskRef === taskRef);
    assert.equal(plan.state, 'uncertain');
    assert.equal(plan.requiresReview, true);
    assert.deepEqual(plan.report, { dispatchId, sequence: 3, state: 'side_effects_uncertain' });
    await assert.rejects(j.claimAcceptedTask(offer, runnerId, fakeRuntime()), /runtime_task_conflict/);
    assert.throws(() => j.confirmNeverStarted(taskRef, 'too short'), /runtime_recovery_evidence_required/);
    let client = runtimeClient(hubStatus());
    await flushRuntimeReconciliations({ journal: j, runtimeClient: client });
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).report, null);
    assert.equal(j.confirmNeverStarted(taskRef, 'verified no subprocess was launched from runtime audit'), 4);
    plan = j.recoveryPlan().find(x => x.taskRef === taskRef);
    assert.equal(plan.state, 'ready_to_retry');
    assert.deepEqual(plan.report, { dispatchId, sequence: 4, state: 'not_started' });
    // Never unlock local task before Hub acknowledges that no work was started.
    client = runtimeClient(hubStatus());
    await flushRuntimeReconciliations({ journal: j, runtimeClient: client });
    plan = j.recoveryPlan().find(x => x.taskRef === taskRef);
    assert.equal(plan.state, 'dispatched');
    assert.equal(plan.runnerId, null);
    assert.equal(plan.leaseId, null);
    assert.equal(plan.report, null);
    j.close();
  } finally { fx.cleanup(); }
});

test('running task remains held after crash, stale Runner cannot complete or re-run', async () => {
  const fx = fixture();
  try {
    let j = fx.open(); createTask(j);
    await j.claimAcceptedTask(offer, runnerId, fakeRuntime());
    await j.beginSideEffects(taskRef, runnerId, leaseId, fakeRuntime());
    j.close();
    j = fx.open();
    const item = j.recoverAfterRestart().find(x => x.taskRef === taskRef);
    assert.equal(item.state, 'uncertain');
    assert.equal(item.sequence, 4);
    assert.throws(() => j.complete(taskRef, runnerId, leaseId, 'completed', { ok: true }), /runtime_task_conflict/);
    await assert.rejects(j.beginSideEffects(taskRef, runnerId, leaseId, fakeRuntime()), /runtime_task_conflict/);
    assert.equal(j.requestCancellation(taskRef), 'uncertain');
    j.close();
  } finally { fx.cleanup(); }
});

test('cancellation before claim is terminal; accepted cancellation requires manual review', async () => {
  const fx = fixture();
  try {
    const j = fx.open(); createTask(j);
    assert.equal(j.requestCancellation(taskRef), 'cancelled');
    assert.equal(j.requestCancellation(taskRef), 'cancelled');
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).report.state, 'cancelled');
    assert.throws(() => j.complete(taskRef, runnerId, leaseId, 'completed', {}), /runtime_lease_not_authorized/);
    j.close();
  } finally { fx.cleanup(); }
  const fx2 = fixture();
  try {
    const j = fx2.open(); createTask(j);
    await j.claimAcceptedTask(offer, runnerId, fakeRuntime());
    const port = createTrustedRuntimeTaskPort({ journal: j, runtimeClient: fakeRuntime(), authenticatedRunnerId: runnerId });
    await assert.rejects(port.cancellationRequested(offer), /runtime_cancellation_not_authorized/);
    const cancelPort = createTrustedRuntimeTaskPort({
      journal: j, runtimeClient: fakeRuntime(hubStatus({ status: 'cancel_requested' })),
      authenticatedRunnerId: runnerId,
    });
    await cancelPort.cancellationRequested(offer);
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).state, 'uncertain');
    j.close();
  } finally { fx2.cleanup(); }
});

test('failed reconciliation remains pending, and wrong encryption key cannot read saved result', async () => {
  const fx = fixture();
  try {
    let j = fx.open(); createTask(j);
    await j.claimAcceptedTask(offer, runnerId, fakeRuntime());
    await j.beginSideEffects(taskRef, runnerId, leaseId, fakeRuntime());
    j.complete(taskRef, runnerId, leaseId, 'failed', { exitCode: 3 });
    await assert.rejects(flushRuntimeReconciliations({
      journal: j, runtimeClient: { async reconcile() { throw new Error('network down'); } },
    }), /network down/);
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).report.state, 'failed');
    assert.throws(() => j.acknowledge(taskRef, 999), /runtime_sequence_conflict/);
    j.close();
    j = fx.open(Buffer.alloc(32, 88));
    assert.throws(() => j.result(taskRef));
    j.close();
    j = fx.open();
    assert.deepEqual(j.result(taskRef), { exitCode: 3 });
    await flushRuntimeReconciliations({ journal: j, runtimeClient: runtimeClient(hubStatus()) });
    assert.equal(j.recoveryPlan().find(x => x.taskRef === taskRef).report, null);
    j.close();
  } finally { fx.cleanup(); }
});
