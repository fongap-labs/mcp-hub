import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeTaskJournal } from '../runtime/sqlite-task-journal.mjs';
import { startLoopbackRuntimeTaskService } from '../runtime/authenticated-task-service.mjs';
import { createRunnerRuntimeTaskPort } from '../runtime/runner-task-transport.mjs';
import { claimRunnerTask } from '../src/control/runner-runtime-client.ts';

const runnerId = 'runner_' + 'a'.repeat(43);
const anotherRunner = 'runner_' + 'z'.repeat(43);
const dispatchId = 'dispatch_' + 'b'.repeat(43);
const leaseId = 'lease_' + 'c'.repeat(43);
const taskRef = 'coding-task-test';
const resourceKey = 'workspace:unit-test';
const runtimeRunnerToken = 'rtkn_' + 't'.repeat(48);
const otherToken = 'rtkn_' + 'w'.repeat(48);
const clock = Date.UTC(2026, 10, 12, 10, 0, 0);
const offer = { dispatchId, leaseId, taskRef, resourceKey, quotaKey: null,
  priority: 50, requiredCapabilities: ['coding.patch'],
  expiresAt: new Date(clock + 60000).toISOString(),
  leaseExpiresAt: new Date(clock + 300000).toISOString() };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-runtime-service-'));
  const journal = new RuntimeTaskJournal({
    databasePath: join(dir, 'task.db'),
    encryptionKey: Buffer.alloc(32, 5), clock: () => clock,
  });
  journal.createTask({ taskRef, resourceKey, task: {
    repository: 'fongap-labs/example', prompt: 'private instructions never return', work: ['source.ts'],
  } });
  journal.attachDispatch(taskRef, dispatchId);
  return { dir, journal, close() { journal.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function mockHub({ status = 'accepted', runner = runnerId, leaseExpiresAt = clock / 1000 + 300,
                   failRunning = false } = {}) {
  const commits = [];
  const record = {
    dispatch_id: dispatchId, task_ref: taskRef, resource_key: resourceKey,
    status, runner_id: runner, lease_id: leaseId, lease_expires_at: leaseExpiresAt,
  };
  return {
    record, commits,
    async get(id) { assert.equal(id, dispatchId); return { ...record }; },
    async reconcile(id, sequence, state) {
      assert.equal(id, dispatchId);
      if (failRunning && state === 'running') throw new Error('upstream-unavailable');
      const states = { running: 'accepted', completed: 'closed', failed: 'closed',
        cancelled: 'cancelled', side_effects_uncertain: 'held', not_started: 'queued' };
      const next = states[state];
      assert.ok(next);
      record.status = next;
      record.runtime_sequence = sequence;
      record.runtime_state = state;
      commits.push({ id, sequence, state });
      return { ok: true, dispatchId: id, runtimeSequence: sequence, status: next };
    },
  };
}

async function start(env, executor, credentials = [
  { runnerId, token: runtimeRunnerToken },
]) {
  const server = await startLoopbackRuntimeTaskService({
    journal: env.journal, runtimeClient: env.hub, executor,
    runnerCredentials: credentials, nowMs: () => clock, leaseCheckMs: 100,
  });
  return {
    server,
    origin: 'http://127.0.0.1:' + server.address().port,
    async stop() { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); },
  };
}
function wrapper() {
  const env = setup();
  env.hub = mockHub();
  return env;
}
function sendRaw(origin, path, data = {
  dispatchId, taskRef, resourceKey, leaseId,
}, token = runtimeRunnerToken, headers = {}) {
  return fetch(origin + path, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data), redirect: 'error',
  });
}

test('Runner handoff triggers authenticated Runtime executor once without disclosing task text', async () => {
  const env = wrapper();
  const executed = [];
  const runtime = await start(env, { async execute(task, context) {
    executed.push({ task, context });
    assert.equal(task.prompt, 'private instructions never return');
    assert.equal(context.runnerId, runnerId);
    assert.equal(context.leaseId, leaseId);
    assert.equal(context.signal.aborted, false);
    assert.deepEqual(env.hub.commits.map(x => x.state), ['running'],
      'Hub must acknowledge execution intent before invoking tools');
    return { changeCount: 3, internalResult: 'secret result' };
  } });
  try {
    const port = createRunnerRuntimeTaskPort({ origin: runtime.origin, runnerRuntimeToken: runtimeRunnerToken });
    const runner = {
      async next() { return { action: 'offer', dispatch: offer }; },
      async accept(d, l) { assert.equal(d, dispatchId); assert.equal(l, leaseId); return { ok: true }; },
    };
    const handoff = await claimRunnerTask(runner, port);
    assert.equal(handoff.kind, 'accepted');
    assert.deepEqual(handoff.task, { status: 'completed', dispatchId });
    assert.ok(!JSON.stringify(handoff).includes('secret'));
    assert.equal(executed.length, 1);
    assert.deepEqual(env.journal.result(taskRef), { changeCount: 3, internalResult: 'secret result' });
    assert.equal(env.journal.recoveryPlan().find(x => x.taskRef === taskRef).report, null);
    assert.deepEqual(env.hub.commits.map(x => x.state), ['running', 'completed']);
    const duplicate = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    assert.equal(duplicate.status, 409);
    assert.equal(executed.length, 1, 'Repeated request must never re-execute');
  } finally { await runtime.stop(); env.close(); }
});

test('missing or invalid Runtime bearer never reaches task storage or executor', async () => {
  const env = wrapper(); let called = 0;
  const runtime = await start(env, { async execute() { called++; return {}; } });
  try {
    const wrong = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute', offer, otherToken);
    assert.equal(wrong.status, 401);
    const noAuth = await fetch(runtime.origin + '/runtime/v1/tasks/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(offer),
    });
    assert.equal(noAuth.status, 401);
    const unknown = await sendRaw(runtime.origin, '/runtime/v1/other');
    assert.equal(unknown.status, 404);
    const invalid = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute', { ...offer, prompt: 'inject' });
    assert.equal(invalid.status, 400);
    assert.equal(called, 0);
    assert.equal(env.journal.recoveryPlan()[0].state, 'dispatched');
  } finally { await runtime.stop(); env.close(); }
});

test('token bound to wrong Runner identity cannot claim another Runner lease', async () => {
  const env = wrapper(); let calls = 0;
  const runtime = await start(env, { async execute() { calls++; } },
    [{ runnerId: anotherRunner, token: otherToken }]);
  try {
    const response = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute',
      { dispatchId, leaseId, taskRef, resourceKey }, otherToken);
    assert.equal(response.status, 409);
    assert.equal(calls, 0);
    assert.equal(env.journal.recoveryPlan()[0].state, 'dispatched');
  } finally { await runtime.stop(); env.close(); }
});

test('expired lease or cancelled Hub assignment fails closed before execution', async () => {
  for (const hubOptions of [
    { leaseExpiresAt: clock / 1000 - 1 },
    { status: 'cancel_requested' },
    { runner: anotherRunner },
  ]) {
    const env = wrapper(); env.hub = mockHub(hubOptions);
    let calls = 0;
    const runtime = await start(env, { async execute() { calls++; } });
    try {
      assert.equal((await sendRaw(runtime.origin, '/runtime/v1/tasks/execute')).status, 409);
      assert.equal(calls, 0);
      assert.equal(env.journal.recoveryPlan()[0].state, 'dispatched');
    } finally { await runtime.stop(); env.close(); }
  }
});

test('executor failure holds potentially changed files for manual review, without leaking secrets', async () => {
  const env = wrapper();
  let attempts = 0;
  const runtime = await start(env, { async execute() {
    attempts++;
    throw Error('private execution exception');
  } });
  try {
    const response = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    assert.equal(response.status, 202);
    const body = await response.text();
    assert.match(body, /outcome_uncertain/);
    assert.ok(!body.includes('private'));
    assert.equal(env.journal.recoveryPlan()[0].state, 'uncertain');
    assert.equal(env.journal.recoveryPlan()[0].requiresReview, true);
    assert.deepEqual(env.hub.commits.map(x => x.state), ['running', 'side_effects_uncertain']);
    const repeated = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    assert.equal(repeated.status, 409);
    assert.equal(attempts, 1);
  } finally { await runtime.stop(); env.close(); }
});

test('failure to acknowledge started state does not invoke Coding Engine', async () => {
  const env = wrapper(); env.hub = mockHub({ failRunning: true });
  let calls = 0;
  const runtime = await start(env, { async execute() { calls++; return {}; } });
  try {
    const response = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
    assert.equal(env.journal.recoveryPlan()[0].state, 'started');
    assert.equal((await sendRaw(runtime.origin, '/runtime/v1/tasks/execute')).status, 409);
    env.journal.recoverAfterRestart();
    assert.equal(env.journal.recoveryPlan()[0].state, 'uncertain');
  } finally { await runtime.stop(); env.close(); }
});

test('cancellation route requires accepted Hub ownership and never exposes task', async () => {
  const env = wrapper(); env.hub = mockHub({ status: 'cancel_requested' });
  let calls = 0;
  const runtime = await start(env, { async execute() { calls++; } });
  try {
    const port = createRunnerRuntimeTaskPort({
      origin: runtime.origin, runnerRuntimeToken: runtimeRunnerToken,
    });
    await port.cancellationRequested(offer);
    assert.equal(env.journal.recoveryPlan()[0].state, 'cancelled');
    assert.equal(calls, 0);
    assert.equal(env.hub.commits.at(-1).state, 'cancelled');
    assert.equal((await sendRaw(runtime.origin, '/runtime/v1/tasks/execute')).status, 409);
  } finally { await runtime.stop(); env.close(); }
});

test('post-execution lost reconciliation response cannot cause replay', async () => {
  const env = wrapper();
  const real = env.hub.reconcile.bind(env.hub);
  env.hub.reconcile = async (id, seq, state) => {
    if (state === 'completed') throw Error('temporary network failure');
    return real(id, seq, state);
  };
  let calls = 0;
  const runtime = await start(env, { async execute() { calls++; return { done: true }; } });
  try {
    const response = await sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status, 'reconciliation_pending');
    assert.equal(calls, 1);
    assert.equal(env.journal.recoveryPlan()[0].report.state, 'completed');
    assert.equal((await sendRaw(runtime.origin, '/runtime/v1/tasks/execute')).status, 409);
    assert.equal(calls, 1);
  } finally { await runtime.stop(); env.close(); }
});

test('loopback-only listener and transport reject unsafe origins and credentials', async () => {
  const env = wrapper();
  try {
    await assert.rejects(startLoopbackRuntimeTaskService({
      journal: env.journal, runtimeClient: env.hub,
      runnerCredentials: [{ runnerId, token: runtimeRunnerToken }],
      executor: { async execute() {} },
    }, 0, '0.0.0.0'), /runtime_loopback_only/);
    assert.throws(() => createRunnerRuntimeTaskPort({
      origin: 'http://remote.example', runnerRuntimeToken: runtimeRunnerToken,
    }), /runtime_service_origin_invalid/);
    assert.throws(() => createRunnerRuntimeTaskPort({
      origin: 'https://example.com/evil', runnerRuntimeToken: runtimeRunnerToken,
    }), /runtime_service_origin_invalid/);
    assert.throws(() => createRunnerRuntimeTaskPort({
      origin: 'https://example.com', runnerRuntimeToken: 'short',
    }), /runtime_runner_token_invalid/);
  } finally { env.close(); }
});


test('Runtime lease watchdog holds in-flight edits when renewal expires', async () => {
  const env = wrapper();
  let started;
  const began = new Promise(resolve => { started = resolve; });
  let aborted = 0;
  const runtime = await start(env, { async execute(_task, {signal}) {
    return new Promise((_resolve,reject) => {
      signal.addEventListener('abort', () => { aborted++; reject(Error('aborted by lease fence')); }, {once:true});
      started();
    });
  } });
  try {
    const executing = sendRaw(runtime.origin, '/runtime/v1/tasks/execute');
    await began;
    env.hub.record.lease_expires_at = Math.floor(clock / 1000) - 1;
    const response = await executing;
    assert.equal(response.status, 202);
    assert.equal((await response.json()).status,'outcome_uncertain');
    assert.equal(aborted,1);
    assert.equal(env.journal.recoveryPlan()[0].state,'uncertain');
    assert.equal(env.hub.commits.at(-1).state,'side_effects_uncertain');
    assert.equal((await sendRaw(runtime.origin,'/runtime/v1/tasks/execute')).status,409);
  } finally { await runtime.stop(); env.close(); }
});

test('Runtime fences an in-flight job when Hub lease cannot be verified', async () => {
  const env = wrapper();
  let started;
  const began = new Promise(resolve=>{started=resolve;});
  const realGet=env.hub.get.bind(env.hub);
  let calls=0;
  env.hub.get=async id=> {
    calls++;
    if(calls > 2) throw Error('Hub connection lost');
    return realGet(id);
  };
  const runtime=await start(env,{async execute(_task,{signal}) {
    return new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(Error('fenced')),{once:true});
      started();
    });
  }});
  try {
    const executing=sendRaw(runtime.origin,'/runtime/v1/tasks/execute');
    await began;
    const result=await executing;
    assert.equal(result.status,202);
    assert.equal(env.journal.recoveryPlan()[0].state,'uncertain');
    assert.equal((await sendRaw(runtime.origin,'/runtime/v1/tasks/execute')).status,409);
  }finally{await runtime.stop();env.close();}
});

test('Runner authenticated fence immediately aborts a running task and is not replayable',async()=>{
  const env=wrapper();
  let started;
  const began=new Promise(resolve=>{started=resolve;});
  const runtime=await start(env,{async execute(_task,{signal}){
    return new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(Error('fenced')),{once:true});
      started();
    });
  }});
  try {
    const executing=sendRaw(runtime.origin,'/runtime/v1/tasks/execute');
    await began;
    const fenced=await sendRaw(runtime.origin,'/runtime/v1/tasks/fence');
    assert.equal(fenced.status,202);
    assert.equal((await fenced.json()).status,'outcome_uncertain');
    assert.equal((await executing).status,202);
    assert.equal(env.journal.recoveryPlan()[0].state,'uncertain');
    assert.equal((await sendRaw(runtime.origin,'/runtime/v1/tasks/execute')).status,409);
  }finally{await runtime.stop();env.close();}
});

test('wrong Runner credential cannot fence an existing lease',async()=>{
  const env=wrapper();
  let started;
  const began=new Promise(resolve=>{started=resolve;});
  const runtime=await start(env,{async execute(){
    started();
    return {ok:true};
  }},[
    {runnerId,token:runtimeRunnerToken},
    {runnerId:anotherRunner,token:otherToken},
  ]);
  try {
    // An inactive task still cannot be fenced by a different Runner.
    const forbidden=await sendRaw(runtime.origin,'/runtime/v1/tasks/fence',
      {dispatchId,taskRef,resourceKey,leaseId},otherToken);
    assert.equal(forbidden.status,409);
    assert.equal(env.journal.recoveryPlan()[0].state,'dispatched');
    assert.equal((await sendRaw(runtime.origin,'/runtime/v1/tasks/execute')).status,200);
    await began;
  }finally{await runtime.stop();env.close();}
});
