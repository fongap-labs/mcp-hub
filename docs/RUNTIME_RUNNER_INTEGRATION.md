# Runtime–Runner Handoff Adapter v1

This repository supplies **portable typed protocol clients**, not a Coding Engine or an autonomously running Agent. Source: src/control/runner-runtime-client.ts. Tests: tests/runner-runtime-client.test.js.

## Trust boundary

- The **Runtime process** uses RuntimeDispatchClient with MCP_RUNTIME_KEY. It owns task storage, execution, side-effect journal, idempotency and terminal reconciliation.
- The **Runner process** uses RunnerDispatchClient with its one-time Runner credential. It registers, heartbeats, reports quota, polls, accepts/rejects and renews leases. The Runner must **never** receive MCP_RUNTIME_KEY.
- **Hub** sees taskRef, capabilities, resource key, dispatch and lease IDs, never task bodies, prompts, workspace paths, source bundles, execution logs, credentials or outcomes.
- The RunnerTaskPort.loadAcceptedTask implementation must independently authenticate the caller and verify the task, dispatch, Runner and lease against Runtime state **before** disclosing task content. An opaque taskRef alone grants no task access.
- The HTTP clients accept HTTPS origins only, refuse redirects, and do not put bearer tokens into URLs or error messages.

## Runtime example

~~~ts
import { RuntimeDispatchClient } from './src/control/runner-runtime-client.ts';

const runtime = new RuntimeDispatchClient(hubOrigin, runtimeKey);
const { dispatchId } = await runtime.create({
  protocolVersion: 'v1',
  idempotencyKey: 'runtime-run-42-attempt-1',
  taskRef: 'runtime-task-42',
  resourceKey: 'workspace:project-a',
  requiredCapabilities: ['coding.patch', 'coding.test'],
  priority: 50, quotaKey: null, leaseSeconds: 300,
});

// Runtime owns its persisted journal and reconcile sequence.
// await runtime.get(dispatchId);
// await runtime.reconcile(dispatchId, 1, 'running');
// await runtime.reconcile(dispatchId, 2, 'completed');
// await runtime.cancel(dispatchId);
~~~

A reconciliation with not_started is safe only after Runtime confirms that no side effect was initiated. If an outcome is uncertain, report side_effects_uncertain and keep it held; do not auto-replay accepted work.

## Runner example

After Runner registration and fresh heartbeat/quota reports, its separately authenticated process can use the adapter to claim an offer. The adapter **does not execute code** or report terminal completion.

~~~ts
import { RunnerDispatchClient, claimRunnerTask } from './src/control/runner-runtime-client.ts';

const runner = new RunnerDispatchClient(hubOrigin, runnerCredential);
const handoff = await claimRunnerTask(runner, {
  // These functions belong in trusted Coding Runtime, not Hub:
  loadAcceptedTask: offer => runtimeTaskPort.claimForRunner(offer),
  cancellationRequested: offer => runtimeTaskPort.notifyCancellation(offer),
});
if (handoff.kind === 'accepted') {
  // Runtime records execution intent before side-effectful tools.
  // Runtime manages renewal, result journaling and reconciliation.
}
~~~

When accept fails, the Runtime task resolver is never called. When task retrieval fails **after** an accepted offer, no automatic reject/requeue/retry is issued; Runtime must inspect its own side-effect journal before recovery. Cancellation notifications must be idempotent.

## Integration status and remaining dependency

The Hub registry, queue, quota, offer, acceptance, renewal and reconciliation are implemented and tested. The client and handoff adapter are runnable against that protocol.

**Still missing**: a live Delta Coding Runtime or Action Worker Runner process exposing a trusted task-lookup API, credentials for that Runtime-only API, and durable execution/result-journal wiring. The shared MCP endpoint cannot bypass Action Worker's existing private agent-task-ingress GitHub identity restrictions.

No credentials, production endpoints, deployment workflows or background services are added. Deploy only after the remaining code tasks and production acceptance plan are complete.


## Durable task store and recovery (Node Runtime)

The optional Node implementation is in runtime/sqlite-task-journal.mjs. It creates a separate private SQLite file belonging to the trusted Coding Runtime, encrypts task and result JSON with AES-256-GCM, and persists a monotonically increasing journal sequence for each task. The Runtime must obtain the stable 32-byte encryption key from its own secret manager; losing or rotating the key without migration makes stored data unreadable. Do not copy that key or the SQLite database into the public Hub.

Workflow:

1. RuntimeTaskJournal.createTask creates encrypted task content in Runtime storage.
2. Runtime submits the opaque reference through RuntimeDispatchClient.create; after the Hub confirms a dispatch ID, RuntimeTaskJournal.attachDispatch binds that ID locally. Repeated Hub submissions must use the same idempotency key.
3. A trusted Runtime endpoint authenticates the Runner separately and constructs createTrustedRuntimeTaskPort with its authenticated Runner ID. The port calls Hub using the Runtime-only credential to verify the dispatch ID, task reference, resource key, accepted status, Runner, lease ID and current lease expiry. Only then may the encrypted task be decrypted and returned.
4. Immediately before starting any side-effectful tool, the trusted Runtime calls await journal.beginSideEffects(taskRef, runnerId, leaseId, runtimeClient). This repeats the live lease checks and **durably commits execution intent first**. Never run a tool if it fails.
5. RuntimeTaskJournal.complete atomically stores the encrypted result and a terminal state. flushRuntimeReconciliations sends only a status and sequence to Hub, and acknowledges locally only after the Hub verifies the same sequence and transition.
6. After a crash, recoverAfterRestart marks claimed or started work as uncertain. Do not auto-replay it. An operator or trusted Runtime audit must independently prove that no side effect occurred before confirmNeverStarted records hashed evidence. Only a successful not_started Hub reconciliation permits the local task to become eligible for redispatch.

No log, prompt, file content or execution result is sent through Hub. The SQLite journal keeps a small local event history, including a SHA-256 digest of recovery evidence rather than the evidence itself. Keep encrypted data backups and migration procedures in the trusted Runtime environment.

The Runtime service-side adapter is runtime/runtime-task-port.mjs. It must run in a **different trust boundary** from the Runner process: the Runtime's authenticated task-lookup HTTP endpoint, token verification, journal key custody and the actual Coding Engine are external to this repository. Do not instantiate that port in an untrusted Runner or provide it with MCP_RUNTIME_KEY. It can be connected in-process only in unit tests.

### Validated and not yet integrated

Automated tests in tests/runtime-task-journal.test.js exercise real Node SQLite persistence, encrypted reopen, authorised lease-bound task lookup, cancellation, interruption, uncertain side-effects, duplicate suppression, Hub reconciliation and explicit recovery confirmation.

This change is a reusable Node Runtime journal and protocol adapter; it does **not** ship a live Delta Coding Engine, an authenticated task server or a running Action Worker Agent, and it does not change production deployment.
