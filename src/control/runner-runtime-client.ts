import type { ResourceDispatchRequest, RunnerQuotaReport, RuntimeDispatchState } from './dispatch-protocol.ts';
import type { RunnerHeartbeatRequest, RunnerRegistrationRequest } from './runner-protocol.ts';

/**
 * Portable HTTP clients for a Runtime and a Runner, intentionally using
 * separate credentials. Neither client retrieves or stores task contents.
 * Importable by Node (type stripping) or other standards-based Runtimes.
 */
export class HubBridgeError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'HubBridgeError';
  }
}

type FetchPort = typeof fetch;
type JsonObject = Record<string, unknown>;

function baseOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('hub_url_must_be_https_origin');
  }
  return url.origin;
}

function validateBearer(value: string): string {
  if (typeof value !== 'string' || value.length < 16 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new TypeError('invalid_hub_bearer');
  }
  return value;
}

function dispatchId(value: string): string {
  if (typeof value !== 'string' || !/^dispatch_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError('invalid_dispatch_id');
  }
  return value;
}

function leaseId(value: string): string {
  if (typeof value !== 'string' || !/^lease_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new TypeError('invalid_lease_id');
  }
  return value;
}

class HubHttpClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly transport: FetchPort;

  constructor(origin: string, token: string, transport: FetchPort) {
    this.origin = baseOrigin(origin);
    this.token = validateBearer(token);
    this.transport = transport;
  }

  protected async request(path: string, body?: JsonObject): Promise<JsonObject> {
    const hasBody = body !== undefined;
    // Paths originate only from this module; URL arguments are encoded below.
    const response = await this.transport(this.origin + path, {
      method: hasBody ? 'POST' : 'GET',
      headers: {
        'Authorization': 'Bearer ' + this.token,
        'Accept': 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    // Never include response text, raw URLs, request body or tokens in errors.
    const raw = await response.text();
    if (raw.length > 65536) throw new HubBridgeError(502, 'hub_response_too_large');
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new HubBridgeError(502, 'invalid_hub_response'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HubBridgeError(502, 'invalid_hub_response');
    }
    const result = payload as JsonObject;
    if (!response.ok) {
      throw new HubBridgeError(response.status,
        typeof result.error === 'string' ? result.error : 'hub_request_rejected');
    }
    return result;
  }
}

/** Runtime-only client. Its secret must not be present in the Runner process. */
export class RuntimeDispatchClient extends HubHttpClient {
  constructor(origin: string, runtimeKey: string, transport: FetchPort = fetch) {
    super(origin, runtimeKey, transport);
  }
  create(input: ResourceDispatchRequest) {
    return this.request('/control/dispatch', input as unknown as JsonObject);
  }
  get(id: string) {
    return this.request('/control/dispatch?dispatchId=' + encodeURIComponent(dispatchId(id)));
  }
  cancel(id: string) {
    return this.request('/control/dispatch/cancel', { dispatchId: dispatchId(id) });
  }
  reconcile(id: string, sequence: number, state: RuntimeDispatchState) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('invalid_runtime_sequence');
    return this.request('/control/dispatch/reconcile', {
      dispatchId: dispatchId(id), sequence, state,
    });
  }
}

export interface RunnerOffer {
  dispatchId: string;
  taskRef: string;
  resourceKey: string;
  requiredCapabilities: string[];
  priority: number;
  quotaKey: string | null;
  leaseId: string;
  expiresAt: string | null;
  leaseExpiresAt: string | null;
}
export type RunnerPoll =
  | { action: 'offer' | 'cancel'; dispatch: RunnerOffer }
  | { dispatch: null };

function parsePoll(value: JsonObject): RunnerPoll {
  if (value.dispatch === null) return { dispatch: null };
  const offer = value.dispatch;
  if ((value.action !== 'offer' && value.action !== 'cancel') ||
      !offer || typeof offer !== 'object' || Array.isArray(offer)) {
    throw new HubBridgeError(502, 'invalid_runner_offer');
  }
  const record = offer as JsonObject;
  if (typeof record.dispatchId !== 'string' || typeof record.leaseId !== 'string' ||
      typeof record.taskRef !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(record.taskRef) ||
      typeof record.resourceKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(record.resourceKey) ||
      !Array.isArray(record.requiredCapabilities) ||
      !record.requiredCapabilities.every(x => typeof x === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(x)) ||
      !Number.isSafeInteger(record.priority) ||
      !(record.quotaKey === null || typeof record.quotaKey === 'string')) {
    throw new HubBridgeError(502, 'invalid_runner_offer');
  }
  try { dispatchId(record.dispatchId); leaseId(record.leaseId); }
  catch { throw new HubBridgeError(502, 'invalid_runner_offer'); }
  return { action: value.action, dispatch: record as unknown as RunnerOffer };
}

/** Runner-only client. It cannot reconcile Runtime execution or read task bodies. */
export class RunnerDispatchClient extends HubHttpClient {
  constructor(origin: string, runnerToken: string, transport: FetchPort = fetch) {
    super(origin, runnerToken, transport);
  }
  register(input: RunnerRegistrationRequest) {
    return this.request('/runner/register', input as unknown as JsonObject);
  }
  heartbeat(input: RunnerHeartbeatRequest) {
    return this.request('/runner/heartbeat', input as unknown as JsonObject);
  }
  quota(input: RunnerQuotaReport) {
    return this.request('/runner/quota', input as unknown as JsonObject);
  }
  async next(): Promise<RunnerPoll> {
    return parsePoll(await this.request('/runner/dispatches/next'));
  }
  accept(id: string, lease: string) {
    return this.request('/runner/dispatches/accept',
      { dispatchId: dispatchId(id), leaseId: leaseId(lease) });
  }
  reject(id: string, lease: string, reasonCode: string) {
    return this.request('/runner/dispatches/reject',
      { dispatchId: dispatchId(id), leaseId: leaseId(lease), reasonCode });
  }
  renew(id: string, lease: string, ttlSeconds: number) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
      throw new TypeError('invalid_lease_ttl');
    }
    return this.request('/runner/dispatches/renew',
      { dispatchId: dispatchId(id), leaseId: leaseId(lease), ttlSeconds });
  }
}

/**
 * Adapter boundary only: the Runtime owns task lookup and execution.
 * The callback MUST independently authenticate the Runner/lease with Runtime;
 * an opaque taskRef or Hub assignment alone grants no task access.
 * Cancellation callbacks must be idempotent. No task is ever executed here.
 */
export interface RunnerTaskPort<Task> {
  loadAcceptedTask(offer: RunnerOffer): Promise<Task>;
  cancellationRequested(offer: RunnerOffer): Promise<void>;
}
export type TaskHandoff<Task> =
  | { kind: 'idle' }
  | { kind: 'cancel_requested'; dispatchId: string }
  | { kind: 'accepted'; dispatchId: string; leaseId: string; task: Task };

export async function claimRunnerTask<Task>(
  runner: RunnerDispatchClient, runtimePort: RunnerTaskPort<Task>,
): Promise<TaskHandoff<Task>> {
  const pending = await runner.next();
  if (pending.dispatch === null) return { kind: 'idle' };
  const offer = pending.dispatch;
  if (pending.action === 'cancel') {
    await runtimePort.cancellationRequested(offer);
    return { kind: 'cancel_requested', dispatchId: offer.dispatchId };
  }
  // Do not load tasks until the Hub accepts this Runner/lease.
  await runner.accept(offer.dispatchId, offer.leaseId);
  // Failure after accept is ambiguous: no reject, requeue or auto-execute.
  // Runtime must inspect its own task and side-effect journal before recovery.
  const task = await runtimePort.loadAcceptedTask(offer);
  return { kind: 'accepted', dispatchId: offer.dispatchId, leaseId: offer.leaseId, task };
}
