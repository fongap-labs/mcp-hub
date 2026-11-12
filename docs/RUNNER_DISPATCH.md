# Runner Dispatch Protocol v1

This contract lets Delta Runtime request a suitable execution resource from MCP Hub. Hub stores an opaque `taskRef`, capability and resource requirements, a bounded lease, and the assignment handshake. The task body, execution log, cancellation authority, side-effect record, retry policy, and final task status remain in Runtime.

## Trust and payload boundary

- Runtime authenticates with `MCP_RUNTIME_KEY`, a separate secret of at least 32 characters. The key is never sent to a Runner.
- Runner calls use the one-time Hub-issued bearer credential. Hub derives `runnerId` from that credential; request bodies cannot choose identity.
- Queue messages contain only `{ "dispatchId": "…" }`. Queue delivery may repeat; D1 state and idempotency keys prevent a repeated message from creating multiple assignments.
- Hub does not accept task bodies, prompts, credentials, workspace paths, or completion claims from Runners. `taskRef` is an opaque Runtime-owned reference, not a task payload.
- Runtime remains authoritative for whether execution started and whether side effects are known. Hub does not implement an Agent loop or infer that a disconnected Runner is safe to retry.

## Runtime requests

`POST /control/dispatch` accepts an idempotent request:

```json
{
  "protocolVersion": "v1",
  "idempotencyKey": "run-42-resource-attempt-1",
  "taskRef": "runtime-task-42",
  "resourceKey": "workspace:project-a",
  "requiredCapabilities": ["coding.patch", "coding.test"],
  "priority": 50,
  "quotaKey": "provider.codex",
  "leaseSeconds": 300
}
```

`idempotencyKey` must be unique per dispatch attempt. Reusing it with the same normalized request returns the existing dispatch; changing any request field returns `409 idempotency_conflict`. The response contains `dispatchId` and the current status. `quotaKey` may be `null` or omitted; `leaseSeconds` defaults to 300 and is bounded to 60–900 seconds. Priority ranges from 0 to 100.

Runtime reads a dispatch using `GET /control/dispatch?dispatchId=…`. It can cancel with `POST /control/dispatch/cancel` and reconcile with `POST /control/dispatch/reconcile`:

```json
{ "dispatchId": "dispatch_…", "sequence": 7, "state": "not_started" }
```

Runtime reconciliation sequences must strictly increase. Supported states are `not_started`, `running`, `side_effects_uncertain`, `completed`, `cancelled`, and `failed`. A `not_started` report is the only signal that can return an offered or accepted dispatch to the queue. If cancellation was requested, `not_started` closes the dispatch as cancelled. `side_effects_uncertain` holds the dispatch without reassigning it. Terminal Runtime reports close the dispatch and release its lease.

## Runner capacity and quota

Runners register and heartbeat using [Runner Protocol v1](RUNNER_PROTOCOL.md). A Runner is eligible only when enabled, registered, heartbeat-fresh, below its concurrency limit, and advertising every required capability.

When a dispatch has a `quotaKey`, the Runner must report a fresh quota snapshot using `POST /runner/quota`:

```json
{
  "protocolVersion": "v1",
  "quotaKey": "provider.codex",
  "sequence": 9,
  "remaining": 12,
  "limit": 20,
  "cooldownSeconds": 0
}
```

Quota report sequences must strictly increase per Runner and quota key. Hub uses its own receive time; reports expire after five minutes. The scheduler skips a Runner in cooldown, with an expired report, or with no unreserved quota. A quota reservation remains counted while an offer is pending and after acceptance until a newer Runner quota report reconciles consumption. It prefers the largest remaining quota after reservations, then the lowest capacity utilization, then the oldest Runner update. Runner quota values are authenticated reports, not independently verified provider facts.

## Offer handshake

The queue is a wakeup mechanism. It has at-least-once delivery, so the consumer reads authoritative queued dispatches from D1, considers higher priorities first, and makes one conditional lease claim. Duplicates and races can produce at most one active offer for a dispatch.

- `GET /runner/dispatches/next` returns the Runner's next live offer or a pending cancellation. An offer carries the task reference and requirements but no task body.
- `POST /runner/dispatches/accept` accepts `{ "dispatchId": "dispatch_…", "leaseId": "lease_…" }` before the 60-second offer deadline.
- `POST /runner/dispatches/reject` uses the same identifiers plus a stable `reasonCode`. Only a not-yet-accepted offer can be rejected; it is released and put back in the outbox.
- `POST /runner/dispatches/renew` accepts those identifiers plus `ttlSeconds` from 60 to 900. Only the authenticated Runner with a live accepted dispatch can renew its lease.
- Runtime cancellation of a queued or offered dispatch closes it. Cancellation after acceptance becomes `cancel_requested`; the Runner observes it on its next poll, while Runtime decides and reports the final execution state.

The scheduled outbox retries unsent or unacknowledged queue wakeups. Expired unaccepted offers can safely return to `queued`. If an accepted lease expires, the dispatch becomes `held`; it is not assigned elsewhere automatically. Runtime must reconcile the task first.

## Admin observability

The authenticated `/admin/api/dispatch-metrics` endpoint and `/admin` page expose status counts, queue depth, oldest queue age, active lease count, and stale quota report count. They do not include task references or task content.

## Cloudflare setup

Create the queues in the same Cloudflare account as the Worker before deploying:

```sh
node scripts/with-secondary-cloudflare.mjs queues create mcp-hub-dispatch
node scripts/with-secondary-cloudflare.mjs queues create mcp-hub-dispatch-dlq
```

The Worker config binds the producer and consumer and sends repeatedly failing consumer messages to the dead-letter queue. A one-minute cron republishes the D1 outbox and recovers expired offers; the daily cron continues OAuth cleanup.

## Runtime integration boundary

This establishes a generic resource dispatch contract. Delta's published architecture assigns Run state, cancellation, retry, recovery, tool dispatch, and idempotency to Delta Runtime. The Hub contract preserves that boundary, but the Delta repository does not currently expose a Coding Engine task submission/pull API. Runtime must adopt this contract and provide a Runner-facing task retrieval path before Coding Worker execution can be enabled. Hub will not invent that Runtime API or copy task bodies into D1/Queues.

A typed Runner/Runtime HTTP client and offer handoff helper are provided in [Runtime–Runner Handoff Adapter](RUNTIME_RUNNER_INTEGRATION.md). This does not replace the missing trusted Runtime task-lookup API or grant the shared MCP service private Agent execution authority.
