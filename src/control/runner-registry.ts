import type { Env } from '../types.ts';
import type { AuthenticatedRunner, RunnerCapacity, RunnerHeartbeatRequest, RunnerRegistrationRequest } from './runner-protocol.ts';
import {
  RUNNER_HEARTBEAT_TTL_MS, RunnerProtocolError, parseRunnerHeartbeat, parseRunnerRegistration,
  resolveRunnerAvailability,
} from './runner-protocol.ts';
import { bodyJson, json, now, randomId, sha } from '../util.ts';

const RUNNER_TOKEN_PREFIX = 'mcrn_';
const MIN_LEASE_TTL_SECONDS = 60;
const MAX_LEASE_TTL_SECONDS = 900;
const RUNNER_SCOPES = ['runner:register', 'runner:heartbeat', 'runner:dispatch', 'runner:quota'] as const;

export type RunnerRegistryErrorCode = 'invalid_request' | 'not_found' | 'forbidden' | 'conflict' | 'unavailable';
export class RunnerRegistryError extends Error {
  readonly code: RunnerRegistryErrorCode;
  constructor(code: RunnerRegistryErrorCode) { super(code); this.name = 'RunnerRegistryError'; this.code = code; }
}

type RunnerRow = {
  runner_id: string;
  display_name: string;
  enabled: number;
  allowed_capabilities_json: string;
  capabilities_json: string;
  max_concurrency_limit: number;
  max_concurrency: number | null;
  active_concurrency: number | null;
  heartbeat_sequence: number | null;
  observed_at: number | null;
  expires_at: number | null;
  registered_at: number | null;
};

function validCapabilities(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 &&
    value.every(capability => typeof capability === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(capability)) &&
    new Set(value).size === value.length;
}

function validLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 128;
}

function opaqueRunnerToken(): string { return RUNNER_TOKEN_PREFIX + randomId(); }
async function readJson(request: Request, limit: number) {
  try { return await bodyJson(request, limit); }
  catch { throw new RunnerRegistryError('invalid_request'); }
}

/** Provision credentials with Hub-generated identity and store only a one-way token hash. */
export async function provisionRunner(env: Env, input: { displayName: unknown; allowedCapabilities: unknown; maxConcurrency: unknown }): Promise<{ runnerId: string; credentialId: string; token: string }> {
  if (typeof input.displayName !== 'string' || input.displayName.length < 1 || input.displayName.length > 80 ||
      input.displayName.trim() !== input.displayName || /[\u0000-\u001f\u007f]/.test(input.displayName) ||
      !validCapabilities(input.allowedCapabilities) || !validLimit(input.maxConcurrency)) {
    throw new RunnerRegistryError('invalid_request');
  }
  const runnerId = 'runner_' + randomId();
  const credentialId = 'cred_' + randomId();
  const token = opaqueRunnerToken();
  const timestamp = now();
  await env.MCP_DB.prepare(`INSERT INTO runners(runner_id,display_name,allowed_capabilities_json,max_concurrency_limit,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`).bind(runnerId, input.displayName, JSON.stringify([...input.allowedCapabilities].sort()), input.maxConcurrency, timestamp, timestamp).run();
  await env.MCP_DB.prepare('INSERT INTO runner_credentials(credential_id,runner_id,token_hash,created_at) VALUES(?,?,?,?)')
    .bind(credentialId, runnerId, await sha(token), timestamp).run();
  return { runnerId, credentialId, token };
}

/** Resolve the bearer secret to a Hub-owned identity; never accept runnerId from a request. */
export async function authenticateRunner(request: Request, env: Env): Promise<AuthenticatedRunner | null> {
  const authorization = request.headers.get('Authorization') || '';
  const match = /^Bearer (mcrn_[A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return null;
  const row = await env.MCP_DB.prepare(`SELECT c.credential_id,r.runner_id FROM runner_credentials c
    JOIN runners r ON r.runner_id=c.runner_id
    WHERE c.token_hash=? AND c.revoked_at IS NULL AND r.enabled=1`).bind(await sha(match[1]!)).first();
  if (!row || typeof row.credential_id !== 'string' || typeof row.runner_id !== 'string') return null;
  return Object.freeze({ runnerId: row.runner_id, credentialId: row.credential_id, scopes: RUNNER_SCOPES });
}

function mapProtocolError(error: unknown): Response {
  if (error instanceof RunnerProtocolError) {
    const status = error.code === 'stale_heartbeat' ? 409 : 400;
    return json({ error: error.code }, status);
  }
  if (error instanceof RunnerRegistryError) {
    const status = error.code === 'invalid_request' ? 400 : error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : 409;
    return json({ error: error.code }, status);
  }
  return json({ error: 'Internal error' }, 500);
}

export async function registerRunner(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRunner(request, env);
  if (!auth || !auth.scopes.includes('runner:register')) return json({ error: 'Unauthorized' }, 401);
  try {
    const registration = parseRunnerRegistration(await readJson(request, 8192));
    const row = await env.MCP_DB.prepare('SELECT * FROM runners WHERE runner_id=? AND enabled=1').bind(auth.runnerId).first() as unknown as RunnerRow | null;
    if (!row) throw new RunnerRegistryError('not_found');
    const allowed = JSON.parse(row.allowed_capabilities_json) as unknown;
    if (!Array.isArray(allowed) || registration.capabilities.some(capability => !allowed.includes(capability)) ||
        registration.maxConcurrency > row.max_concurrency_limit) throw new RunnerRegistryError('forbidden');
    const registered = await env.MCP_DB.prepare(`UPDATE runners SET display_name=?,capabilities_json=?,max_concurrency=?,registered_at=COALESCE(registered_at,?),updated_at=?
      WHERE runner_id=? AND enabled=1
        AND COALESCE(active_concurrency,0)<=?
        AND (SELECT COUNT(*) FROM runner_leases l WHERE l.runner_id=runners.runner_id AND l.released_at IS NULL AND l.expires_at>?)<=?
      RETURNING runner_id`).bind(registration.displayName, JSON.stringify(registration.capabilities), registration.maxConcurrency,
      now(), now(), auth.runnerId, registration.maxConcurrency, now(), registration.maxConcurrency).first();
    if (!registered) throw new RunnerRegistryError('conflict');
    return json({ ok: true, runnerId: auth.runnerId, status: 'registered', heartbeatRequired: row.heartbeat_sequence === null }, 200);
  } catch (error) { return mapProtocolError(error); }
}

function capacityFromRow(row: RunnerRow, nowSeconds: number): RunnerCapacity {
  const enabled = row.enabled === 1;
  const maxConcurrency = row.max_concurrency ?? row.max_concurrency_limit;
  const observedAt = row.observed_at;
  const expiresAt = row.expires_at;
  const activeConcurrency = row.active_concurrency;
  const availability = resolveRunnerAvailability({
    enabled,
    observedAt: observedAt === null ? null : observedAt * 1000,
    expiresAt: expiresAt === null ? null : expiresAt * 1000,
    activeConcurrency,
    maxConcurrency,
    now: nowSeconds * 1000,
  });
  return Object.freeze({
    protocolVersion: 'v1', runnerId: row.runner_id,
    capabilities: JSON.parse(row.capabilities_json) as string[], maxConcurrency,
    activeConcurrency: activeConcurrency ?? 0, availability,
    observedAt: observedAt === null ? null : new Date(observedAt * 1000).toISOString(),
    expiresAt: expiresAt === null ? null : new Date(expiresAt * 1000).toISOString(),
  });
}

export async function heartbeatRunner(request: Request, env: Env): Promise<Response> {
  const auth = await authenticateRunner(request, env);
  if (!auth || !auth.scopes.includes('runner:heartbeat')) return json({ error: 'Unauthorized' }, 401);
  try {
    const row = await env.MCP_DB.prepare('SELECT * FROM runners WHERE runner_id=? AND enabled=1').bind(auth.runnerId).first() as unknown as RunnerRow | null;
    if (!row) throw new RunnerRegistryError('not_found');
    if (row.registered_at === null || row.max_concurrency === null) throw new RunnerRegistryError('conflict');
    const heartbeat = parseRunnerHeartbeat(await readJson(request, 2048), row.max_concurrency, row.heartbeat_sequence);
    const receivedAt = now();
    const expiry = receivedAt + RUNNER_HEARTBEAT_TTL_MS / 1000;
    const accepted = await env.MCP_DB.prepare(`UPDATE runners SET active_concurrency=?,heartbeat_sequence=?,observed_at=?,expires_at=?,updated_at=?
      WHERE runner_id=? AND enabled=1 AND heartbeat_sequence IS ? RETURNING runner_id`).bind(
      heartbeat.activeConcurrency, heartbeat.sequence, receivedAt, expiry, receivedAt, auth.runnerId, row.heartbeat_sequence,
    ).first();
    if (!accepted) throw new RunnerProtocolError('stale_heartbeat');
    const updated = { ...row, active_concurrency: heartbeat.activeConcurrency, heartbeat_sequence: heartbeat.sequence,
      observed_at: receivedAt, expires_at: expiry };
    return json({ ok: true, capacity: capacityFromRow(updated, receivedAt) });
  } catch (error) { return mapProtocolError(error); }
}

function validLeaseInput(
  input: { runnerId: unknown; idempotencyKey: unknown; resourceKey: unknown; ttlSeconds: unknown }
): input is { runnerId: string; idempotencyKey: string; resourceKey: string; ttlSeconds: number } {
  return typeof input.runnerId === 'string' && /^runner_[A-Za-z0-9_-]{43}$/.test(input.runnerId) &&
    typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) &&
    typeof input.resourceKey === 'string' && input.resourceKey.length >= 1 && input.resourceKey.length <= 200 &&
    input.resourceKey.trim() === input.resourceKey && !/[\u0000-\u001f\u007f]/.test(input.resourceKey) &&
    Number.isSafeInteger(input.ttlSeconds) && (input.ttlSeconds as number) >= MIN_LEASE_TTL_SECONDS && (input.ttlSeconds as number) <= MAX_LEASE_TTL_SECONDS;
}

export interface RunnerLease { leaseId: string; runnerId: string; idempotencyKey: string; resourceKey: string; acquiredAt: number; expiresAt: number; }
function leaseFromRow(row: Record<string, unknown>): RunnerLease {
  return { leaseId: String(row.lease_id), runnerId: String(row.runner_id), idempotencyKey: String(row.idempotency_key),
    resourceKey: String(row.resource_key), acquiredAt: Number(row.acquired_at), expiresAt: Number(row.expires_at) };
}

/** Atomically claim one available capacity slot; a retry can only return the same live lease. */
export async function acquireRunnerLease(env: Env, input: { runnerId: unknown; idempotencyKey: unknown; resourceKey: unknown; ttlSeconds: unknown }, at = now()): Promise<RunnerLease> {
  if (!validLeaseInput(input) || !Number.isSafeInteger(at)) throw new RunnerRegistryError('invalid_request');
  const leaseId = 'lease_' + randomId();
  const expiresAt = at + input.ttlSeconds;
  const inserted = await env.MCP_DB.prepare(`INSERT INTO runner_leases(lease_id,runner_id,idempotency_key,resource_key,acquired_at,expires_at)
    SELECT ?,r.runner_id,?,?,?,? FROM runners r
    WHERE r.runner_id=? AND r.enabled=1 AND r.registered_at IS NOT NULL AND r.observed_at IS NOT NULL AND r.expires_at>?
      AND MAX(r.active_concurrency,(SELECT COUNT(*) FROM runner_leases l WHERE l.runner_id=r.runner_id AND l.released_at IS NULL AND l.expires_at>?))<r.max_concurrency
    ON CONFLICT(idempotency_key) DO NOTHING RETURNING lease_id,runner_id,idempotency_key,resource_key,acquired_at,expires_at`).bind(
    leaseId, input.idempotencyKey, input.resourceKey, at, expiresAt, input.runnerId, at, at,
  ).first();
  if (inserted) return leaseFromRow(inserted);
  const existing = await env.MCP_DB.prepare('SELECT * FROM runner_leases WHERE idempotency_key=?').bind(input.idempotencyKey).first();
  if (existing) {
    if (existing.runner_id === input.runnerId && existing.resource_key === input.resourceKey && existing.released_at === null &&
        typeof existing.expires_at === 'number' && existing.expires_at > at) return leaseFromRow(existing);
    throw new RunnerRegistryError('conflict');
  }
  throw new RunnerRegistryError('unavailable');
}

/** Extend only a live lease while its Runner remains enabled and heartbeat-fresh. */
export async function renewRunnerLease(env: Env, leaseId: string, ttlSeconds: number, at = now()): Promise<boolean> {
  if (typeof leaseId !== 'string' || !/^lease_[A-Za-z0-9_-]{43}$/.test(leaseId) || !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < MIN_LEASE_TTL_SECONDS || ttlSeconds > MAX_LEASE_TTL_SECONDS || !Number.isSafeInteger(at)) return false;
  const row = await env.MCP_DB.prepare(`UPDATE runner_leases SET expires_at=? WHERE lease_id=? AND released_at IS NULL AND expires_at>?
    AND EXISTS(SELECT 1 FROM runners r WHERE r.runner_id=runner_leases.runner_id AND r.enabled=1 AND r.expires_at>?)
    RETURNING lease_id`).bind(at + ttlSeconds, leaseId, at, at).first();
  return Boolean(row);
}

/** Release is idempotent; expiry alone also makes a lease ineligible. */
export async function releaseRunnerLease(env: Env, leaseId: string, at = now()): Promise<boolean> {
  if (typeof leaseId !== 'string' || !/^lease_[A-Za-z0-9_-]{43}$/.test(leaseId) || !Number.isSafeInteger(at)) return false;
  const row = await env.MCP_DB.prepare('UPDATE runner_leases SET released_at=? WHERE lease_id=? AND released_at IS NULL RETURNING lease_id').bind(at, leaseId).first();
  return Boolean(row);
}

export async function adminProvisionRunner(env: Env, request: Request): Promise<Response> {
  try {
    const data = await readJson(request, 8192);
    const provisioned = await provisionRunner(env, { displayName: data.displayName, allowedCapabilities: data.capabilities, maxConcurrency: data.maxConcurrency });
    return json({ ok: true, ...provisioned }, 201);
  } catch (error) { return mapProtocolError(error); }
}

export async function adminRevokeRunner(env: Env, request: Request): Promise<Response> {
  try {
    const data = await readJson(request, 1024);
    if (typeof data.runnerId !== 'string' || !/^runner_[A-Za-z0-9_-]{43}$/.test(data.runnerId)) throw new RunnerRegistryError('invalid_request');
    const at = now();
    const changed = await env.MCP_DB.prepare('UPDATE runners SET enabled=0,updated_at=? WHERE runner_id=? AND enabled=1 RETURNING runner_id').bind(at, data.runnerId).first();
    if (!changed) throw new RunnerRegistryError('not_found');
    await env.MCP_DB.prepare('UPDATE runner_credentials SET revoked_at=? WHERE runner_id=? AND revoked_at IS NULL').bind(at, data.runnerId).run();
    await env.MCP_DB.prepare('UPDATE runner_leases SET released_at=? WHERE runner_id=? AND released_at IS NULL').bind(at, data.runnerId).run();
    return json({ ok: true });
  } catch (error) { return mapProtocolError(error); }
}

export async function listRunners(env: Env): Promise<Array<RunnerCapacity & { displayName: string }>> {
  const rows = (await env.MCP_DB.prepare('SELECT * FROM runners ORDER BY created_at DESC LIMIT 200').all()).results || [];
  return rows.map(row => ({...capacityFromRow(row as unknown as RunnerRow, now()), displayName:String(row.display_name)}));
}
