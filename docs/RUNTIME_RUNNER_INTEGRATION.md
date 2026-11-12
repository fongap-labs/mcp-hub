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
