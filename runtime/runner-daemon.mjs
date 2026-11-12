import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const SAFE_CAPABILITY = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_SAFE_TIME_SEQUENCE = Number.MAX_SAFE_INTEGER - 100000;

/**
 * Monotonic heartbeat/quota sequences across process restarts. The sequence
 * is persisted before network submission, so an ambiguous response cannot
 * cause the same number to be reused. One process per Runner identity only.
 */
export function createRunnerSequenceStore(file) {
  if (typeof file !== 'string' || !file.trim()) throw new TypeError('runner_sequence_path_required');
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let previous = 0;
  try {
    const saved = readFileSync(path, 'utf8').trim();
    if (!/^[1-9]\d{0,15}$/.test(saved) || !Number.isSafeInteger(Number(saved))) {
      throw new Error('corrupt_runner_sequence');
    }
    previous = Number(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    next() {
      const epoch = Math.floor(Date.now() * 1000);
      const next = Math.max(previous + 1, epoch);
      if (!Number.isSafeInteger(next) || next > MAX_SAFE_TIME_SEQUENCE) {
        throw new Error('runner_sequence_exhausted');
      }
      const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        writeFileSync(temporary, String(next) + '\n', { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      previous = next;
      return next;
    },
  };
}

const WAIT_DEFAULT = 1500;
function validateOptions({ runner, runtimePort, displayName, capabilities,
                           heartbeatSequence, maxConcurrency, pollMs, heartbeatMs, renewMs }) {
  if (!runner || !['register','heartbeat','next','accept','reject','renew'].every(k => typeof runner[k] === 'function') ||
      !runtimePort || typeof runtimePort.loadAcceptedTask !== 'function' ||
      typeof runtimePort.cancellationRequested !== 'function' ||
      typeof runtimePort.fenceTask !== 'function') {
    throw new TypeError('runner_client_and_runtime_port_required');
  }
  if (typeof heartbeatSequence?.next !== 'function') throw new TypeError('durable_runner_sequence_required');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80) {
    throw new TypeError('invalid_runner_display_name');
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0 ||
      !capabilities.every(c => typeof c === 'string' && SAFE_CAPABILITY.test(c)) ||
      new Set(capabilities).size !== capabilities.length) {
    throw new TypeError('invalid_runner_capabilities');
  }
  if (maxConcurrency !== 1) throw new TypeError('runner_single_flight_required');
  for (const [n, value] of [['pollMs',pollMs],['heartbeatMs',heartbeatMs],['renewMs',renewMs]]) {
    if (!Number.isSafeInteger(value) || value < 100 || value > 60000) {
      throw new TypeError('invalid_runner_' + n);
    }
  }
}

export function createRunnerDaemon({
  runner, runtimePort, heartbeatSequence, displayName, capabilities,
  maxConcurrency = 1, pollMs = WAIT_DEFAULT, heartbeatMs = 20000,
  renewMs = 30000, leaseSeconds = 300, quota = null,
  clock = Date.now, notify = () => {},
}) {
  validateOptions({ runner, runtimePort, heartbeatSequence, displayName, capabilities,
    maxConcurrency, pollMs, heartbeatMs, renewMs });
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 900) {
    throw new TypeError('invalid_runner_lease_seconds');
  }
  if (typeof clock !== 'function' || typeof notify !== 'function') {
    throw new TypeError('invalid_runner_callbacks');
  }
  if (quota && (typeof runner.quota !== 'function' ||
      typeof quota.quotaKey !== 'string' || !quota.quotaKey.trim() ||
      !Number.isSafeInteger(quota.limit) || quota.limit < 1 ||
      !Number.isSafeInteger(quota.remaining) || quota.remaining < 0 ||
      quota.remaining > quota.limit)) throw new TypeError('invalid_runner_quota');

  let registered = false;
  let active = null;
  let locked = false;
  let stopped = false;
  let quarantined = null;
  let nextHeartbeat = -1;
  let nextRenew = 0;
  const seenCancellations = new Set();
  let requiresReview = false;
  let fencing = null;

  function fenceActive() {
    if (!active) return Promise.resolve();
    requiresReview = true;
    if (!fencing) {
      const offer = active.offer;
      // Do not trust the control plane after a lost renewal or stop signal.
      // If the Runtime fence cannot be confirmed, preserve the process lock.
      fencing = Promise.resolve().then(() => runtimePort.fenceTask(offer))
        .catch(() => { requiresReview = true; });
    }
    return fencing;
  }

  const quarantine = () => {
    if (quarantined) return;
    quarantined = 'runner_control_plane_unavailable';
    if (active) void fenceActive();
    // No secrets, task text or upstream error strings in log events.
    notify({ type: 'quarantined' });
  };

  async function tick() {
    if (locked || stopped || quarantined) return;
    locked = true;
    try {
      if (!registered) {
        const response = await runner.register({
          protocolVersion: 'v1', displayName, capabilities, maxConcurrency,
        });
        if (!response || response.ok !== true) throw new Error('runner_registration_rejected');
        registered = true;
      }
      const now = clock();
      if (now >= nextHeartbeat) {
        const sequence = heartbeatSequence.next();
        const response = await runner.heartbeat({
          protocolVersion: 'v1', sequence, activeConcurrency: active ? 1 : 0,
        });
        if (!response || response.ok !== true) throw new Error('runner_heartbeat_rejected');
        if (quota) {
          await runner.quota({
            protocolVersion: 'v1', quotaKey: quota.quotaKey,
            sequence: heartbeatSequence.next(),
            remaining: quota.remaining, limit: quota.limit, cooldownSeconds: 0,
          });
        }
        nextHeartbeat = now + heartbeatMs;
      }
      if (active && now >= nextRenew && !active.cancelling) {
        const response = await runner.renew(active.offer.dispatchId, active.offer.leaseId, leaseSeconds);
        if (!response || response.ok !== true) throw new Error('runner_lease_renew_rejected');
        nextRenew = now + renewMs;
      }
      const next = await runner.next();
      if (!next || typeof next !== 'object') throw new Error('invalid_dispatch_response');
      if (!next.dispatch) return;
      const offer = next.dispatch;
      if (next.action === 'cancel') {
        if (!seenCancellations.has(offer.dispatchId)) {
          await runtimePort.cancellationRequested(offer);
          seenCancellations.add(offer.dispatchId);
          if (active?.offer.dispatchId === offer.dispatchId) active.cancelling = true;
          notify({ type: 'cancel_requested', dispatchId: offer.dispatchId });
        }
        return;
      }
      if (next.action !== 'offer') throw new Error('invalid_dispatch_action');
      if (active) {
        await runner.reject(offer.dispatchId, offer.leaseId, 'busy');
        return;
      }

      // Once acceptance has been attempted, any failure is ambiguous.
      // Never retry acceptance or task execution automatically.
      // Acceptance may succeed remotely even when its response is lost.
      // Keep the offer locally *before* the request so failure can fence it.
      const flight = { offer, cancelling: false };
      active = flight;
      const acceptance = await runner.accept(offer.dispatchId, offer.leaseId);
      if (!acceptance || acceptance.ok !== true) throw new Error('runner_accept_rejected');
      nextRenew = now + renewMs;
      notify({ type: 'accepted', dispatchId: offer.dispatchId });
      if (stopped || quarantined) {
        quarantine();
        await fenceActive();
        return;
      }
      void Promise.resolve().then(() => runtimePort.loadAcceptedTask(offer)).then(result => {
        if (result?.status === 'reconciliation_pending') {
          quarantine(new Error('runtime_reconciliation_pending'));
          return;
        }
        if (!result || !['completed','failed'].includes(result.status)) {
          quarantine(new Error('runtime_execution_status_unknown'));
          return;
        }
        notify({ type: 'finished', dispatchId: offer.dispatchId, status: result.status });
      }).catch(() => {
        quarantine(new Error('runtime_outcome_unknown'));
      }).finally(() => {
        if (active === flight) active = null;
      });
    } catch {
      quarantine();
      await fenceActive();
    } finally {
      locked = false;
    }
  }

  async function run({ signal } = {}) {
    if (signal?.aborted) return;
    while (!stopped && !quarantined && !signal?.aborted) {
      await tick();
      if (stopped || quarantined || signal?.aborted) break;
      await new Promise(resolve => {
        const timeout = setTimeout(done, pollMs);
        function done() { clearTimeout(timeout); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    }
  }

  return {
    tick, run,
    stop() {
      stopped = true;
      if (active) void fenceActive();
    },
    async shutdown() {
      stopped = true;
      await fenceActive();
      // Review required even if the HTTP request returned 'outcome_uncertain':
      // a side effect may have occurred before the task was fenced.
    },
    get status() {
      return Object.freeze({ registered, stopped, quarantined: !!quarantined,
        requiresReview, activeDispatchId: active?.offer.dispatchId ?? null });
    },
  };
}
