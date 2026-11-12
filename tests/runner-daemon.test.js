import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunnerDaemon, createRunnerSequenceStore } from '../runtime/runner-daemon.mjs';

const offer = {
  dispatchId: 'dispatch_' + 'a'.repeat(43),
  leaseId: 'lease_' + 'b'.repeat(43),
  taskRef: 'runtime-task-42', resourceKey: 'workspace:unit',
  requiredCapabilities: ['coding.patch'], priority: 30, quotaKey: null,
};
const finished = { status: 'completed', dispatchId: offer.dispatchId };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fongap-runner-test-'));
  const file = join(dir, 'sequence.txt');
  return { dir, file, sequence: createRunnerSequenceStore(file),
    cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}
function harness(answers = []) {
  const calls = [];
  const runner = {
    async register(payload) { calls.push(['register',payload]); return { ok: true }; },
    async heartbeat(payload) { calls.push(['heartbeat',payload]); return { ok: true }; },
    async next() { calls.push(['next']); return answers.shift() ?? { dispatch: null }; },
    async accept(id, lease) { calls.push(['accept',id,lease]); return { ok: true }; },
    async reject(id, lease, reason) { calls.push(['reject',id,lease,reason]); return { ok: true }; },
    async renew(id, lease, ttl) { calls.push(['renew',id,lease,ttl]); return { ok: true }; },
  };
  return { runner, calls };
}
function makeDaemon(fx, runner, port, options = {}) {
  return createRunnerDaemon({
    runner, runtimePort: { async fenceTask() { return {status:'outcome_uncertain'}; }, ...port },
    heartbeatSequence: fx.sequence,
    displayName: 'Test Coding Runner', capabilities: ['coding.patch'],
    maxConcurrency: 1, heartbeatMs: 1000, renewMs: 500,
    pollMs: 100, clock: () => 10000, ...options,
  });
}

test('monotonic heartbeats survive process restart and persist before submission', () => {
  const fx = fixture();
  try {
    const n1 = fx.sequence.next();
    const n2 = fx.sequence.next();
    const n3 = createRunnerSequenceStore(fx.file).next();
    assert.ok(n1 < n2 && n2 < n3);
    assert.equal(Number(readFileSync(fx.file, 'utf8').trim()), n3);
  } finally { fx.cleanup(); }
});

test('a single accepted task renews lease and receives cancellation while executor is still running', async () => {
  const fx = fixture();
  const job = deferred();
  let clock = 0;
  const { runner, calls } = harness([
    { action: 'offer', dispatch: offer },
    { dispatch: null },
    { action: 'cancel', dispatch: offer },
    { action: 'cancel', dispatch: offer },
  ]);
  const notifications = [];
  let executions = 0, cancellations = 0;
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { executions++; return job.promise; },
    async cancellationRequested(o) { assert.equal(o.dispatchId, offer.dispatchId); cancellations++; },
  }, { clock: () => clock, notify: e => notifications.push(e) });
  try {
    await daemon.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(executions, 1);
    assert.equal(daemon.status.activeDispatchId, offer.dispatchId);
    assert.deepEqual(calls.filter(c => c[0] === 'accept').length, 1);
    clock = 1001;
    await daemon.tick();
    assert.ok(calls.some(c => c[0] === 'renew'));
    assert.equal(calls.filter(c => c[0] === 'heartbeat').length, 2);
    clock = 1100;
    await daemon.tick();
    await daemon.tick();
    assert.equal(cancellations, 1, 'Repeated cancellation polls do not reissue requests');
    job.resolve(finished);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(daemon.status.activeDispatchId, null);
    assert.equal(daemon.status.quarantined, false);
    assert.ok(notifications.some(n => n.type === 'finished'));
  } finally { fx.cleanup(); }
});

test('offers while active are rejected busy, not accepted twice', async () => {
  const fx = fixture();
  const job = deferred();
  const { runner, calls } = harness([
    { action: 'offer', dispatch: offer },
    { action: 'offer', dispatch: { ...offer, dispatchId: 'dispatch_' + 'c'.repeat(43) } },
  ]);
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { return job.promise; },
    async cancellationRequested() {},
  });
  try {
    await daemon.tick();
    await daemon.tick();
    assert.equal(calls.filter(x => x[0] === 'accept').length, 1);
    assert.equal(calls.filter(x => x[0] === 'reject').length, 1);
    assert.equal(calls.find(x => x[0] === 'reject')[3], 'busy');
    job.resolve(finished);
    await new Promise(resolve => setImmediate(resolve));
  } finally { fx.cleanup(); }
});

test('ambiguous accepted task is quarantined, never repeated automatically', async () => {
  const fx = fixture();
  const { runner, calls } = harness([{ action: 'offer', dispatch: offer }]);
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { throw Error('Runtime connection dropped after acceptance'); },
    async cancellationRequested() {},
  });
  try {
    await daemon.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(daemon.status.quarantined, true);
    await daemon.tick();
    assert.equal(calls.filter(x => x[0] === 'accept').length, 1);
  } finally { fx.cleanup(); }
});

test('failed heartbeat fences Runner before accepting any offer', async () => {
  const fx = fixture();
  const { runner, calls } = harness([{ action: 'offer', dispatch: offer }]);
  runner.heartbeat = async () => { calls.push(['heartbeat-failed']); throw Error('token: sensitive'); };
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { throw Error('Must never execute'); },
    async cancellationRequested() {},
  });
  try {
    await daemon.tick();
    assert.equal(daemon.status.quarantined, true);
    assert.equal(calls.filter(x => x[0] === 'accept').length, 0);
    assert.equal(calls.filter(x => x[0] === 'next').length, 0);
  } finally { fx.cleanup(); }
});

test('completed but not reconciled tasks fence Runner rather than replay', async () => {
  const fx = fixture();
  const { runner, calls } = harness([{ action: 'offer', dispatch: offer }]);
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { return { status: 'reconciliation_pending' }; },
    async cancellationRequested() {},
  });
  try {
    await daemon.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(daemon.status.quarantined, true);
    assert.equal(calls.filter(x => x[0] === 'accept').length, 1);
  } finally { fx.cleanup(); }
});

test('stop and abort exit the daemon run loop without provisioning new work', async () => {
  const fx = fixture();
  const { runner, calls } = harness();
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { return finished; },
    async cancellationRequested() {},
  });
  try {
    const ac = new AbortController();
    const running = daemon.run({ signal: ac.signal });
    ac.abort();
    await running;
    daemon.stop();
    assert.equal(daemon.status.stopped, true);
    const count = calls.length;
    await daemon.tick();
    assert.equal(calls.length, count);
  } finally { fx.cleanup(); }
});

test('invalid options fail before a Runner connects', () => {
  const fx = fixture(), { runner } = harness();
  try {
    assert.throws(() => createRunnerDaemon({
      runner, runtimePort: { loadAcceptedTask() {}, cancellationRequested() {}, fenceTask() {} },
      heartbeatSequence: fx.sequence, displayName: 'runner', capabilities: ['coding.patch'],
      maxConcurrency: 2,
    }), /runner_single_flight_required/);
  } finally { fx.cleanup(); }
});


test('renewal rejection fences active Runtime task and quarantines Runner', async () => {
  const fx = fixture();
  const job = deferred();
  let clock = 0, fences = 0, executions = 0;
  const {runner,calls} = harness([{ action:'offer', dispatch: offer }]);
  runner.renew = async () => { throw new Error('lease lost'); };
  const daemon = makeDaemon(fx, runner, {
    async loadAcceptedTask() { executions++; return job.promise; },
    async cancellationRequested() {},
    async fenceTask(given) { fences++; assert.equal(given.leaseId,offer.leaseId);
      return {status:'outcome_uncertain'}; },
  }, { clock:()=>clock });
  try {
    await daemon.tick();
    await new Promise(r=>setImmediate(r));
    assert.equal(executions,1);
    clock = 1001;
    await daemon.tick();
    assert.equal(fences,1);
    assert.equal(daemon.status.quarantined,true);
    assert.equal(daemon.status.requiresReview,true);
    const count = calls.filter(x=>x[0]==='accept').length;
    await daemon.tick();
    assert.equal(calls.filter(x=>x[0]==='accept').length,count);
    job.resolve({status:'outcome_uncertain'});
    await new Promise(r=>setImmediate(r));
  } finally { fx.cleanup(); }
});

test('lost accept response fences the ambiguously accepted offer without starting Runtime', async () => {
  const fx=fixture(), {runner,calls}=harness([{action:'offer',dispatch:offer}]);
  let executed=0, fences=0;
  runner.accept=async () => { calls.push(['accept',offer.dispatchId]); throw Error('response lost'); };
  const daemon=makeDaemon(fx,runner,{
    async loadAcceptedTask(){executed++;return finished;},
    async cancellationRequested(){},
    async fenceTask(given){assert.equal(given.dispatchId,offer.dispatchId);fences++;},
  });
  try {
    await daemon.tick();
    assert.equal(fences,1);
    assert.equal(executed,0);
    assert.equal(daemon.status.requiresReview,true);
    assert.equal(daemon.status.quarantined,true);
  } finally {fx.cleanup();}
});

test('graceful shutdown fences active work before releasing control', async () => {
  const fx=fixture(), job=deferred(), {runner}=harness([{action:'offer',dispatch:offer}]);
  let fences=0;
  const daemon=makeDaemon(fx,runner,{
    async loadAcceptedTask(){return job.promise;},
    async cancellationRequested(){},
    async fenceTask(){fences++;return {status:'outcome_uncertain'};},
  });
  try {
    await daemon.tick();
    await new Promise(r=>setImmediate(r));
    daemon.stop();
    await daemon.shutdown();
    assert.equal(fences,1);
    assert.equal(daemon.status.stopped,true);
    assert.equal(daemon.status.requiresReview,true);
    job.resolve({status:'outcome_uncertain'});
    await new Promise(r=>setImmediate(r));
  } finally{fx.cleanup();}
});

test('fence transport failure retains manual-review state',async()=>{
  const fx=fixture(),job=deferred(),{runner}=harness([{action:'offer',dispatch:offer}]);
  const daemon=makeDaemon(fx,runner,{
    async loadAcceptedTask(){return job.promise;},
    async cancellationRequested(){},
    async fenceTask(){throw Error('Runtime unreachable');},
  });
  try{
    await daemon.tick();
    await new Promise(r=>setImmediate(r));
    await daemon.shutdown();
    assert.equal(daemon.status.requiresReview,true);
    job.resolve({status:'outcome_uncertain'});
    await new Promise(r=>setImmediate(r));
  } finally{fx.cleanup();}
});
