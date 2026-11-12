import type { Env, QueueBatch } from '../types.ts';
import { bodyJson, equals, json, now, randomId } from '../util.ts';
import { authenticateRunner } from './runner-registry.ts';
import {
  DISPATCH_OFFER_TTL_SECONDS, DISPATCH_OUTBOX_RETRY_SECONDS, QUOTA_REPORT_TTL_SECONDS,
  DispatchProtocolError, parseQuotaReport, parseResourceDispatch, parseRuntimeReconciliation,
  type RuntimeDispatchState,
} from './dispatch-protocol.ts';

type Row = Record<string, unknown>;
type DispatchRow = Row & {
  dispatch_id: string; idempotency_key: string; task_ref: string; resource_key: string;
  required_capabilities_json: string; priority: number; quota_key: string | null;
  lease_seconds: number; status: string; runner_id: string | null; lease_id: string | null;
  published_at: number | null; offer_expires_at: number | null; runtime_sequence: number;
  runtime_state: string | null;
};

const DISPATCH_ID = /^dispatch_[A-Za-z0-9_-]{43}$/;
const LEASE_ID = /^lease_[A-Za-z0-9_-]{43}$/;
const REJECT_REASONS = new Set(['busy','capability_unavailable','operator_disabled','quota_unavailable','unsupported']);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(input: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(input).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
async function readBody(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  try { return await bodyJson(request, limit); }
  catch { throw new DispatchProtocolError('invalid_payload_shape'); }
}
async function runtimeAuth(request: Request, env: Env): Promise<Response | null> {
  if (typeof env.MCP_RUNTIME_KEY !== 'string' || env.MCP_RUNTIME_KEY.length < 32) return json({ error: 'dispatch_unavailable' }, 503);
  if (!(await equals(request.headers.get('Authorization') || '', `Bearer ${env.MCP_RUNTIME_KEY}`))) return json({ error: 'Unauthorized' }, 401);
  return null;
}
function protocolError(error: unknown): Response {
  if (error instanceof DispatchProtocolError) {
    const conflict = error.code === 'stale_runtime_sequence' || error.code === 'dispatch_conflict' || error.code === 'stale_quota_sequence';
    return json({ error: error.code }, conflict ? 409 : 400);
  }
  return json({ error: 'Internal error' }, 500);
}
function dbRow(value: unknown): Row | null { return value && typeof value === 'object' ? value as Row : null; }
function stmt(env: Env, sql: string, ...values: (string | number | null)[]) {
  return env.MCP_DB.prepare(sql).bind(...values);
}

/** Runtime submits only an opaque task reference. Task content remains in Runtime storage. */
export async function createDispatch(request: Request, env: Env): Promise<Response> {
  const auth = await runtimeAuth(request, env); if (auth) return auth;
  if (!env.MCP_DISPATCH_QUEUE) return json({ error: 'dispatch_unavailable' }, 503);
  try {
    const dispatch = parseResourceDispatch(await readBody(request));
    const at = now(), dispatchId = `dispatch_${randomId()}`;
    const inserted = await stmt(env, `INSERT INTO runner_dispatches(
      dispatch_id,idempotency_key,task_ref,resource_key,required_capabilities_json,priority,quota_key,lease_seconds,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,'queued',?) ON CONFLICT(idempotency_key) DO NOTHING
      RETURNING *`, dispatchId, dispatch.idempotencyKey, dispatch.taskRef, dispatch.resourceKey,
      JSON.stringify(dispatch.requiredCapabilities), dispatch.priority, dispatch.quotaKey, dispatch.leaseSeconds, at).first();
    const row = dbRow(inserted) || dbRow(await stmt(env,
      'SELECT * FROM runner_dispatches WHERE idempotency_key=?', dispatch.idempotencyKey).first());
    if (!row) return json({ error: 'dispatch_unavailable' }, 503);
    const same = row.task_ref === dispatch.taskRef && row.resource_key === dispatch.resourceKey &&
      row.required_capabilities_json === JSON.stringify(dispatch.requiredCapabilities) && row.priority === dispatch.priority &&
      row.quota_key === dispatch.quotaKey && row.lease_seconds === dispatch.leaseSeconds;
    if (!same) return json({ error: 'idempotency_conflict' }, 409);
    if (inserted && env.MCP_DISPATCH_QUEUE) {
      try {
        await env.MCP_DISPATCH_QUEUE.send({ dispatchId: row.dispatch_id }, { contentType: 'json' });
        await stmt(env, 'UPDATE runner_dispatches SET published_at=? WHERE dispatch_id=? AND status=\'queued\'', at, String(row.dispatch_id)).run();
      } catch { /* The D1 outbox keeps the queued dispatch for the next scheduled publish. */ }
    }
    return json({ dispatchId: row.dispatch_id, status: row.status, accepted: false }, inserted ? 202 : 200);
  } catch (error) { return protocolError(error); }
}

export async function getDispatchStatus(request: Request, env: Env): Promise<Response> {
  const auth = await runtimeAuth(request, env); if (auth) return auth;
  const id = new URL(request.url).searchParams.get('dispatchId') || '';
  if (!DISPATCH_ID.test(id)) return json({ error: 'invalid_dispatch_id' }, 400);
  const row = dbRow(await stmt(env, `SELECT dispatch_id,status,runner_id,lease_id,created_at,offered_at,offer_expires_at,
    accepted_at,closed_at,runtime_sequence,runtime_state,last_reason_code FROM runner_dispatches WHERE dispatch_id=?`, id).first());
  return row ? json(row) : json({ error: 'not_found' }, 404);
}

export async function reportRunnerQuota(request: Request, env: Env): Promise<Response> {
  const runner = await authenticateRunner(request, env);
  if (!runner || !runner.scopes.includes('runner:quota')) return json({ error: 'Unauthorized' }, 401);
  try {
    const report = parseQuotaReport(await readBody(request, 2048));
    const at = now();
    const capacity = dbRow(await stmt(env, 'SELECT registered_at,expires_at FROM runners WHERE runner_id=? AND enabled=1', runner.runnerId).first());
    if (!capacity || typeof capacity.expires_at !== 'number' || capacity.expires_at <= at) return json({ error: 'runner_unavailable' }, 409);
    const saved = await stmt(env, `INSERT INTO runner_quota_reports(runner_id,quota_key,sequence,remaining,quota_limit,cooldown_until,observed_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(runner_id,quota_key) DO UPDATE SET sequence=excluded.sequence,remaining=excluded.remaining,
      quota_limit=excluded.quota_limit,cooldown_until=excluded.cooldown_until,observed_at=excluded.observed_at,expires_at=excluded.expires_at
      WHERE runner_quota_reports.sequence<excluded.sequence RETURNING runner_id`, runner.runnerId, report.quotaKey, report.sequence,
      report.remaining, report.limit, report.cooldownSeconds ? at + report.cooldownSeconds : null, at, at + QUOTA_REPORT_TTL_SECONDS).first();
    const latest = dbRow(await stmt(env, 'SELECT sequence FROM runner_quota_reports WHERE runner_id=? AND quota_key=?',
      runner.runnerId, report.quotaKey).first());
    if (!latest || typeof latest.sequence !== 'number') return json({ error: 'dispatch_unavailable' }, 503);
    await stmt(env, `UPDATE runner_dispatches SET quota_reserved=0 WHERE runner_id=? AND quota_key=?
      AND status IN ('accepted','cancel_requested','held') AND quota_reserved=1 AND quota_sequence<?`,
      runner.runnerId, report.quotaKey, latest.sequence).run();
    if (!saved) return json({ error: 'stale_quota_sequence' }, 409);
    return json({ ok: true, observedAt: new Date(at * 1000).toISOString(), expiresAt: new Date((at + QUOTA_REPORT_TTL_SECONDS) * 1000).toISOString() });
  } catch (error) { return protocolError(error); }
}

async function eligibleRunner(env: Env, dispatch: DispatchRow, at: number): Promise<string | null> {
  const row = dbRow(await stmt(env, `SELECT r.runner_id FROM runners r JOIN runner_dispatches d ON d.dispatch_id=?
    LEFT JOIN runner_quota_reports q ON q.runner_id=r.runner_id AND q.quota_key=d.quota_key
    WHERE d.status='queued' AND r.enabled=1 AND r.registered_at IS NOT NULL AND r.observed_at IS NOT NULL AND r.expires_at>?
      AND MAX(COALESCE(r.active_concurrency,0),(SELECT COUNT(*) FROM runner_leases l WHERE l.runner_id=r.runner_id AND l.released_at IS NULL AND l.expires_at>?))<r.max_concurrency
      AND NOT EXISTS(SELECT 1 FROM json_each(d.required_capabilities_json) req WHERE NOT EXISTS(
        SELECT 1 FROM json_each(r.capabilities_json) cap WHERE cap.value=req.value))
      AND (d.quota_key IS NULL OR (q.expires_at>? AND (q.cooldown_until IS NULL OR q.cooldown_until<=?) AND
        q.remaining>COALESCE((SELECT SUM(x.quota_reserved) FROM runner_dispatches x WHERE x.runner_id=r.runner_id
          AND x.quota_key=d.quota_key AND x.status IN ('offered','accepted','cancel_requested','held')),0)))
    ORDER BY CASE WHEN d.quota_key IS NULL THEN 0 ELSE q.remaining-COALESCE((SELECT SUM(x.quota_reserved)
      FROM runner_dispatches x WHERE x.runner_id=r.runner_id AND x.quota_key=d.quota_key
      AND x.status IN ('offered','accepted','cancel_requested','held')),0) END DESC,
      (MAX(COALESCE(r.active_concurrency,0),(SELECT COUNT(*) FROM runner_leases l WHERE l.runner_id=r.runner_id
        AND l.released_at IS NULL AND l.expires_at>?))*1.0/r.max_concurrency) ASC,
      r.updated_at ASC,r.runner_id ASC LIMIT 1`, dispatch.dispatch_id, at, at, at, at, at).first());
  return typeof row?.runner_id === 'string' ? row.runner_id : null;
}

/** Queue messages are wakeups only; D1 state and the dispatch idempotency key are authoritative. */
async function offerDispatch(env: Env, dispatch: DispatchRow, runnerId: string, at: number): Promise<boolean> {
  const leaseId = `lease_${randomId()}`, idempotencyKey = `${dispatch.dispatch_id}:${leaseId}`;
  const leaseExpiry = at + dispatch.lease_seconds;
  const result = await env.MCP_DB.batch([
    stmt(env, `INSERT INTO runner_leases(lease_id,runner_id,idempotency_key,resource_key,acquired_at,expires_at,dispatch_id)
      SELECT ?,r.runner_id,?,?,?,?,? FROM runners r JOIN runner_dispatches d ON d.dispatch_id=?
      WHERE r.runner_id=? AND r.enabled=1 AND r.registered_at IS NOT NULL AND r.expires_at>?
        AND d.status='queued'
        AND MAX(COALESCE(r.active_concurrency,0),(SELECT COUNT(*) FROM runner_leases l WHERE l.runner_id=r.runner_id
          AND l.released_at IS NULL AND l.expires_at>?))<r.max_concurrency
        AND NOT EXISTS(SELECT 1 FROM json_each(d.required_capabilities_json) req WHERE NOT EXISTS(
          SELECT 1 FROM json_each(r.capabilities_json) cap WHERE cap.value=req.value))
        AND (d.quota_key IS NULL OR EXISTS(SELECT 1 FROM runner_quota_reports q WHERE q.runner_id=r.runner_id
          AND q.quota_key=d.quota_key AND q.expires_at>? AND (q.cooldown_until IS NULL OR q.cooldown_until<=?)
          AND q.remaining>COALESCE((SELECT SUM(x.quota_reserved) FROM runner_dispatches x WHERE x.runner_id=r.runner_id
            AND x.quota_key=d.quota_key AND x.status IN ('offered','accepted','cancel_requested','held')),0)))
      ON CONFLICT(idempotency_key) DO NOTHING RETURNING lease_id`, leaseId, idempotencyKey, dispatch.resource_key, at,
      leaseExpiry, dispatch.dispatch_id, dispatch.dispatch_id, runnerId, at, at, at, at),
    stmt(env, `UPDATE runner_dispatches SET status='offered',runner_id=?,lease_id=?,offered_at=?,offer_expires_at=?,
        quota_reserved=CASE WHEN quota_key IS NULL THEN 0 ELSE 1 END,
        quota_sequence=CASE WHEN quota_key IS NULL THEN NULL ELSE (SELECT q.sequence FROM runner_quota_reports q
          WHERE q.runner_id=? AND q.quota_key=runner_dispatches.quota_key) END,last_reason_code=NULL
      WHERE dispatch_id=? AND status='queued' AND EXISTS(SELECT 1 FROM runner_leases l WHERE l.lease_id=?
        AND l.dispatch_id=? AND l.runner_id=?) RETURNING dispatch_id`, runnerId, leaseId, at, at + DISPATCH_OFFER_TTL_SECONDS,
      runnerId, dispatch.dispatch_id, leaseId, dispatch.dispatch_id, runnerId),
    stmt(env, `DELETE FROM runner_leases WHERE lease_id=? AND NOT EXISTS(SELECT 1 FROM runner_dispatches d
      WHERE d.dispatch_id=? AND d.lease_id=? AND d.status='offered')`, leaseId, dispatch.dispatch_id, leaseId),
  ]);
  return (result[1]?.results?.length || 0) > 0;
}

async function offerHighestPriority(env: Env): Promise<void> {
  const at = now();
  const queued = (await stmt(env, `SELECT * FROM runner_dispatches WHERE status='queued'
    ORDER BY priority DESC,created_at ASC LIMIT 50`).all()).results || [];
  for (const value of queued) {
    const dispatch = value as unknown as DispatchRow;
    const runnerId = await eligibleRunner(env, dispatch, at);
    if (runnerId && await offerDispatch(env, dispatch, runnerId, at)) return;
  }
}

function parseQueueId(value: unknown): string | null {
  return isObject(value) && typeof value.dispatchId === 'string' && DISPATCH_ID.test(value.dispatchId) ? value.dispatchId : null;
}
export async function consumeDispatchQueue(batch: QueueBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (!parseQueueId(message.body)) { message.ack(); continue; }
      await offerHighestPriority(env);
      message.ack();
    } catch { message.retry({ delaySeconds: 30 }); }
  }
}

async function publishOutbox(env: Env, at: number): Promise<void> {
  if (!env.MCP_DISPATCH_QUEUE) return;
  const pending = (await stmt(env, `SELECT dispatch_id FROM runner_dispatches WHERE status='queued'
    AND (published_at IS NULL OR published_at<=?) ORDER BY priority DESC,created_at ASC LIMIT 100`,
    at - DISPATCH_OUTBOX_RETRY_SECONDS).all()).results || [];
  if (!pending.length) return;
  const ids = pending.map(row => String(row.dispatch_id));
  await env.MCP_DISPATCH_QUEUE.sendBatch(ids.map(dispatchId => ({ body: { dispatchId }, contentType: 'json' as const })));
  await env.MCP_DB.batch(ids.map(dispatchId => stmt(env,
    'UPDATE runner_dispatches SET published_at=? WHERE dispatch_id=? AND status=\'queued\'', at, dispatchId)));
}

export async function maintainDispatches(env: Env): Promise<void> {
  const at = now();
  await env.MCP_DB.batch([
    stmt(env, `UPDATE runner_leases SET released_at=? WHERE released_at IS NULL AND lease_id IN
      (SELECT lease_id FROM runner_dispatches WHERE status='offered' AND offer_expires_at<=?)`, at, at),
    stmt(env, `UPDATE runner_dispatches SET status='queued',runner_id=NULL,lease_id=NULL,offered_at=NULL,
      offer_expires_at=NULL,published_at=NULL,quota_reserved=0,last_reason_code='offer_expired'
      WHERE status='offered' AND offer_expires_at<=?`, at),
    stmt(env, `UPDATE runner_dispatches SET status='held',runtime_state=COALESCE(runtime_state,'side_effects_uncertain')
      WHERE status='accepted' AND lease_id IN (SELECT lease_id FROM runner_leases WHERE expires_at<=? AND released_at IS NULL)`, at),
  ]);
  await publishOutbox(env, at);
}

async function authenticatedRunner(request: Request, env: Env, scope: 'runner:dispatch' | 'runner:quota') {
  const runner = await authenticateRunner(request, env);
  return runner && runner.scopes.includes(scope) ? runner : null;
}

export async function nextRunnerDispatch(request: Request, env: Env): Promise<Response> {
  const runner = await authenticatedRunner(request, env, 'runner:dispatch');
  if (!runner) return json({ error: 'Unauthorized' }, 401);
  const at = now();
  const row = dbRow(await stmt(env, `SELECT d.dispatch_id,d.task_ref,d.resource_key,d.required_capabilities_json,
    d.priority,d.quota_key,d.status,d.lease_id,l.expires_at AS lease_expires_at,d.offer_expires_at
    FROM runner_dispatches d LEFT JOIN runner_leases l ON l.lease_id=d.lease_id
    WHERE d.runner_id=? AND d.status IN ('offered','cancel_requested')
      AND (d.status='cancel_requested' OR d.offer_expires_at>?)
    ORDER BY CASE WHEN d.status='cancel_requested' THEN 0 ELSE 1 END,d.priority DESC,d.created_at ASC LIMIT 1`, runner.runnerId, at).first());
  if (!row) return json({ dispatch: null });
  const cancelling = row.status === 'cancel_requested';
  return json({ action: cancelling ? 'cancel' : 'offer', dispatch: {
    dispatchId: row.dispatch_id, taskRef: row.task_ref, resourceKey: row.resource_key,
    requiredCapabilities: JSON.parse(String(row.required_capabilities_json)), priority: row.priority,
    quotaKey: row.quota_key, leaseId: row.lease_id,
    expiresAt: row.offer_expires_at ? new Date(Number(row.offer_expires_at) * 1000).toISOString() : null,
    leaseExpiresAt: row.lease_expires_at ? new Date(Number(row.lease_expires_at) * 1000).toISOString() : null,
  } });
}

function dispatchLeaseBody(input: Record<string, unknown>): { dispatchId: string; leaseId: string } | null {
  if (!exactKeys(input, ['dispatchId','leaseId']) || typeof input.dispatchId !== 'string' || !DISPATCH_ID.test(input.dispatchId) ||
      typeof input.leaseId !== 'string' || !LEASE_ID.test(input.leaseId)) return null;
  return { dispatchId: input.dispatchId, leaseId: input.leaseId };
}

export async function acceptRunnerDispatch(request: Request, env: Env): Promise<Response> {
  const runner = await authenticatedRunner(request, env, 'runner:dispatch');
  if (!runner) return json({ error: 'Unauthorized' }, 401);
  try {
    const parsed = dispatchLeaseBody(await readBody(request)); if (!parsed) throw new DispatchProtocolError('invalid_payload_shape');
    const at = now();
    const accepted = await stmt(env, `UPDATE runner_dispatches SET status='accepted',accepted_at=?,offer_expires_at=NULL
      WHERE dispatch_id=? AND lease_id=? AND runner_id=? AND status='offered' AND offer_expires_at>?
      AND EXISTS(SELECT 1 FROM runner_leases l JOIN runners r ON r.runner_id=l.runner_id WHERE l.lease_id=?
        AND l.released_at IS NULL AND l.expires_at>? AND r.enabled=1 AND r.expires_at>?) RETURNING dispatch_id`,
      at, parsed.dispatchId, parsed.leaseId, runner.runnerId, at, parsed.leaseId, at, at).first();
    if (!accepted) return json({ error: 'dispatch_conflict' }, 409);
    return json({ ok: true, dispatchId: parsed.dispatchId, status: 'accepted' });
  } catch (error) { return protocolError(error); }
}

export async function rejectRunnerDispatch(request: Request, env: Env): Promise<Response> {
  const runner = await authenticatedRunner(request, env, 'runner:dispatch');
  if (!runner) return json({ error: 'Unauthorized' }, 401);
  try {
    const input = await readBody(request);
    if (!exactKeys(input, ['dispatchId','leaseId','reasonCode']) || typeof input.dispatchId !== 'string' || !DISPATCH_ID.test(input.dispatchId) ||
        typeof input.leaseId !== 'string' || !LEASE_ID.test(input.leaseId) || typeof input.reasonCode !== 'string' || !REJECT_REASONS.has(input.reasonCode))
      throw new DispatchProtocolError('invalid_payload_shape');
    const at = now();
    const result = await env.MCP_DB.batch([
      stmt(env, `UPDATE runner_dispatches SET status='queued',runner_id=NULL,lease_id=NULL,offered_at=NULL,
        offer_expires_at=NULL,published_at=NULL,quota_reserved=0,last_reason_code=?
        WHERE dispatch_id=? AND lease_id=? AND runner_id=? AND status='offered' AND offer_expires_at>? RETURNING dispatch_id`,
        input.reasonCode, input.dispatchId, input.leaseId, runner.runnerId, at),
      stmt(env, `UPDATE runner_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL AND EXISTS(
        SELECT 1 FROM runner_dispatches d WHERE d.dispatch_id=? AND d.status='queued' AND d.last_reason_code=?)`,
        at, input.leaseId, input.dispatchId, input.reasonCode),
    ]);
    if (!(result[0]?.results?.length)) return json({ error: 'dispatch_conflict' }, 409);
    return json({ ok: true, status: 'queued' });
  } catch (error) { return protocolError(error); }
}

export async function renewRunnerDispatch(request: Request, env: Env): Promise<Response> {
  const runner = await authenticatedRunner(request, env, 'runner:dispatch');
  if (!runner) return json({ error: 'Unauthorized' }, 401);
  try {
    const input = await readBody(request);
    if (!exactKeys(input, ['dispatchId','leaseId','ttlSeconds']) || typeof input.dispatchId !== 'string' || !DISPATCH_ID.test(input.dispatchId) ||
        typeof input.leaseId !== 'string' || !LEASE_ID.test(input.leaseId) || !Number.isSafeInteger(input.ttlSeconds) ||
        (input.ttlSeconds as number) < 60 || (input.ttlSeconds as number) > 900) throw new DispatchProtocolError('invalid_payload_shape');
    const at = now();
    const result = await stmt(env, `UPDATE runner_leases SET expires_at=MAX(expires_at,?) WHERE lease_id=? AND runner_id=?
      AND released_at IS NULL AND EXISTS(SELECT 1 FROM runner_dispatches d JOIN runners r ON r.runner_id=d.runner_id
        WHERE d.dispatch_id=? AND d.lease_id=runner_leases.lease_id AND d.status='accepted' AND d.runner_id=?
          AND r.enabled=1 AND r.expires_at>?) RETURNING expires_at`, at + (input.ttlSeconds as number), input.leaseId,
      runner.runnerId, input.dispatchId, runner.runnerId, at).first();
    const row = dbRow(result);
    return row ? json({ ok: true, expiresAt: new Date(Number(row.expires_at) * 1000).toISOString() }) : json({ error: 'dispatch_conflict' }, 409);
  } catch (error) { return protocolError(error); }
}

export async function cancelDispatch(request: Request, env: Env): Promise<Response> {
  const auth = await runtimeAuth(request, env); if (auth) return auth;
  try {
    const input = await readBody(request, 2048);
    if (!exactKeys(input, ['dispatchId']) || typeof input.dispatchId !== 'string' || !DISPATCH_ID.test(input.dispatchId))
      throw new DispatchProtocolError('invalid_dispatch_id');
    const row = dbRow(await stmt(env, 'SELECT status,lease_id FROM runner_dispatches WHERE dispatch_id=?', input.dispatchId).first());
    if (!row) return json({ error: 'not_found' }, 404);
    if (row.status === 'closed' || row.status === 'cancelled' || row.status === 'cancel_requested') return json({ ok: true, status: row.status });
    const next = row.status === 'accepted' || row.status === 'held' ? 'cancel_requested' : 'cancelled';
    const at = now();
    const results = await env.MCP_DB.batch([
      stmt(env, 'UPDATE runner_dispatches SET status=?,quota_reserved=CASE WHEN ?=\'cancelled\' THEN 0 ELSE quota_reserved END,closed_at=CASE WHEN ?=\'cancelled\' THEN ? ELSE closed_at END WHERE dispatch_id=? AND status=? RETURNING dispatch_id',
        next, next, next, at, input.dispatchId, String(row.status)),
      ...(next === 'cancelled' && typeof row.lease_id === 'string' ? [stmt(env,
        `UPDATE runner_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL AND EXISTS(
          SELECT 1 FROM runner_dispatches d WHERE d.dispatch_id=? AND d.status='cancelled' AND d.lease_id=?)`,
        at, row.lease_id, input.dispatchId, row.lease_id)] : []),
    ]);
    if (!(results[0]?.results?.length)) return json({ error: 'dispatch_conflict' }, 409);
    return json({ ok: true, status: next });
  } catch (error) { return protocolError(error); }
}

function runtimeTarget(state: RuntimeDispatchState, current: string): string {
  if (state === 'not_started') return current === 'cancel_requested' ? 'cancelled' : 'queued';
  if (state === 'running') return 'accepted';
  if (state === 'side_effects_uncertain') return 'held';
  if (state === 'cancelled') return 'cancelled';
  return 'closed';
}

/** Runtime is the only authority that can say an accepted task never started. */
export async function reconcileDispatch(request: Request, env: Env): Promise<Response> {
  const auth = await runtimeAuth(request, env); if (auth) return auth;
  try {
    const report = parseRuntimeReconciliation(await readBody(request, 2048));
    const current = dbRow(await stmt(env, 'SELECT * FROM runner_dispatches WHERE dispatch_id=?', report.dispatchId).first()) as DispatchRow | null;
    if (!current) return json({ error: 'not_found' }, 404);
    if (['closed','cancelled'].includes(current.status)) return json({ error: 'dispatch_conflict' }, 409);
    if (report.sequence <= current.runtime_sequence) return json({ error: 'stale_runtime_sequence' }, 409);
    if (report.state === 'running') {
      if (!current.runner_id) return json({ error: 'dispatch_conflict' }, 409);
      const runner = dbRow(await stmt(env, 'SELECT enabled,expires_at FROM runners WHERE runner_id=?', current.runner_id).first());
      if (runner?.enabled !== 1 || typeof runner.expires_at !== 'number' || runner.expires_at <= now())
        return json({ error: 'dispatch_conflict' }, 409);
    }
    const target = runtimeTarget(report.state, current.status), at = now();
    const clearRunner = target === 'queued' || target === 'closed' || target === 'cancelled';
    const terminal = target === 'closed' || target === 'cancelled';
    const result = await env.MCP_DB.batch([
      stmt(env, `UPDATE runner_dispatches SET status=?,runtime_sequence=?,runtime_state=?,
        runner_id=CASE WHEN ?=1 THEN NULL ELSE runner_id END,lease_id=CASE WHEN ?=1 THEN NULL ELSE lease_id END,
        offered_at=CASE WHEN ?=1 THEN NULL ELSE offered_at END,offer_expires_at=CASE WHEN ?=1 THEN NULL ELSE offer_expires_at END,
        published_at=CASE WHEN ?=1 THEN NULL ELSE published_at END,accepted_at=CASE WHEN ?='accepted' THEN COALESCE(accepted_at,?) ELSE accepted_at END,
        quota_reserved=CASE WHEN ?=1 THEN 0 ELSE quota_reserved END,closed_at=CASE WHEN ?=1 THEN ? ELSE closed_at END
        WHERE dispatch_id=? AND status=? AND runtime_sequence<? RETURNING dispatch_id`, target, report.sequence, report.state,
        clearRunner ? 1 : 0, clearRunner ? 1 : 0, clearRunner ? 1 : 0, clearRunner ? 1 : 0, target === 'queued' ? 1 : 0,
        target, at, clearRunner ? 1 : 0, terminal ? 1 : 0, at, report.dispatchId, current.status, report.sequence),
      stmt(env, `UPDATE runner_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL AND EXISTS(
        SELECT 1 FROM runner_dispatches d WHERE d.dispatch_id=? AND d.runtime_sequence=? AND d.runtime_state=? AND d.status IN ('queued','closed','cancelled'))`,
        at, current.lease_id, report.dispatchId, report.sequence, report.state),
      ...(report.state === 'running' && current.lease_id ? [stmt(env, `UPDATE runner_leases SET expires_at=? WHERE lease_id=? AND released_at IS NULL
        AND EXISTS(SELECT 1 FROM runner_dispatches d JOIN runners r ON r.runner_id=d.runner_id
          WHERE d.dispatch_id=? AND d.runtime_sequence=? AND d.runtime_state='running' AND d.status='accepted' AND r.enabled=1 AND r.expires_at>?)`,
        at + current.lease_seconds, current.lease_id, report.dispatchId, report.sequence, at)] : []),
    ]);
    if (!(result[0]?.results?.length)) return json({ error: 'stale_runtime_sequence' }, 409);
    if (target === 'queued' && env.MCP_DISPATCH_QUEUE) {
      try { await env.MCP_DISPATCH_QUEUE.send({ dispatchId: report.dispatchId }, { contentType: 'json' });
        await stmt(env, 'UPDATE runner_dispatches SET published_at=? WHERE dispatch_id=? AND status=\'queued\'', at, report.dispatchId).run();
      } catch { /* Scheduled outbox retries the dispatch. */ }
    }
    return json({ ok: true, dispatchId: report.dispatchId, status: target, runtimeSequence: report.sequence });
  } catch (error) { return protocolError(error); }
}

export async function dispatchMetrics(env: Env) {
  const at = now();
  const [statuses, queue, leases, staleQuotas] = await Promise.all([
    stmt(env, 'SELECT status,COUNT(*) AS count FROM runner_dispatches GROUP BY status').all(),
    stmt(env, `SELECT COUNT(*) AS count,MIN(created_at) AS oldest_created_at FROM runner_dispatches WHERE status='queued'`).first(),
    stmt(env, `SELECT COUNT(*) AS count FROM runner_leases WHERE released_at IS NULL AND expires_at>?`, at).first(),
    stmt(env, `SELECT COUNT(*) AS count FROM runner_quota_reports WHERE expires_at<=?`, at).first(),
  ]);
  const counts: Record<string, number> = {};
  for (const row of statuses.results || []) counts[String(row.status)] = Number(row.count) || 0;
  const q = dbRow(queue), l = dbRow(leases), s = dbRow(staleQuotas);
  const queuedCount = Number(q?.count) || 0, oldest = typeof q?.oldest_created_at === 'number' ? q.oldest_created_at : null;
  return { counts, queuedCount, oldestQueuedAgeSeconds: oldest === null ? 0 : Math.max(0, at - oldest),
    activeLeases: Number(l?.count) || 0, staleQuotaReports: Number(s?.count) || 0 };
}

export async function adminDispatchMetrics(env: Env): Promise<Response> {
  return json(await dispatchMetrics(env));
}

