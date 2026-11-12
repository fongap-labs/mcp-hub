import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { TaskSubmissionError } from './authorized-task-producer.mjs';
import { createTrustedRuntimeTaskPort, flushRuntimeReconciliations } from './runtime-task-port.mjs';

const RUNNER_ID = /^runner_[A-Za-z0-9_-]{43}$/;
const DISPATCH_ID = /^dispatch_[A-Za-z0-9_-]{43}$/;
const LEASE_ID = /^lease_[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_BODY = 4096;
const MAX_SUBMISSION_BODY = 32768;
const ROUTES = new Set(['/runtime/v1/tasks/execute', '/runtime/v1/tasks/cancel']);

function hashCredential(credential) {
  if (typeof credential !== 'string' || !/^[A-Za-z0-9._~-]{32,256}$/.test(credential)) {
    throw new TypeError('invalid_runtime_runner_credential');
  }
  return createHash('sha256').update(credential).digest();
}

function buildAuthenticator(credentials) {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    throw new TypeError('runtime_runner_credentials_required');
  }
  const entries = [];
  const seen = new Set();
  for (const credential of credentials) {
    if (!credential || !RUNNER_ID.test(credential.runnerId)) throw new TypeError('invalid_runtime_runner_id');
    const digest = hashCredential(credential.token);
    if (seen.has(digest.toString('hex'))) throw new TypeError('duplicate_runtime_runner_credential');
    seen.add(digest.toString('hex'));
    entries.push({ runnerId: credential.runnerId, digest });
  }
  return authorization => {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') ||
        authorization.length > 280 || authorization.split(' ').length !== 2) return null;
    let candidate;
    try { candidate = hashCredential(authorization.slice(7)); } catch { return null; }
    // Compare hashed credentials with constant-time comparison, never expose raw tokens.
    let runnerId = null;
    for (const entry of entries) {
      if (timingSafeEqual(candidate, entry.digest)) runnerId = entry.runnerId;
    }
    return runnerId;
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'",
  });
  res.end(JSON.stringify(body));
}

async function readSubmission(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw new TypeError('invalid_task_content_type');
  }
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_SUBMISSION_BODY) throw new TypeError('task_submission_too_large');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function readOffer(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw new TypeError('invalid_runtime_content_type');
  }
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new TypeError('runtime_request_too_large');
    chunks.push(chunk);
  }
  let offer;
  try { offer = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new TypeError('invalid_runtime_request_json'); }
  const keys = ['dispatchId', 'leaseId', 'resourceKey', 'taskRef'];
  if (!offer || Array.isArray(offer) || typeof offer !== 'object' ||
      Object.keys(offer).length !== keys.length ||
      !keys.every(key => Object.hasOwn(offer, key)) ||
      !DISPATCH_ID.test(offer.dispatchId) || !LEASE_ID.test(offer.leaseId) ||
      !REF.test(offer.taskRef) || !REF.test(offer.resourceKey)) {
    throw new TypeError('invalid_runtime_offer');
  }
  return offer;
}

/**
 * Trusted Node-only Runtime service. It authenticates a Runner using a
 * Runtime-issued, per-Runner credential (separate from Hub Runner and Runtime
 * credentials). Task bodies and execution results never cross this API.
 *
 * executor.execute(task, context) is the separately provisioned Coding Engine.
 * No arbitrary commands, shell or GitHub permission is exposed by this module.
 */
function createRuntimeTaskService({ journal, runtimeClient, runnerCredentials, executor, taskProducer = null, taskDelivery = null }) {
  if (!journal || typeof journal.claimAcceptedTask !== 'function' ||
      typeof journal.beginSideEffects !== 'function' || typeof journal.complete !== 'function' ||
      !runtimeClient || typeof runtimeClient.get !== 'function' ||
      typeof runtimeClient.reconcile !== 'function' ||
      !executor || typeof executor.execute !== 'function') {
    throw new TypeError('runtime_components_required');
  }
  if (taskProducer !== null && typeof taskProducer.submit !== 'function') {
    throw new TypeError('invalid_task_producer');
  }
  if (taskDelivery !== null && typeof taskDelivery.deliver !== 'function') {
    throw new TypeError('invalid_task_delivery');
  }
  const authenticate = buildAuthenticator(runnerCredentials);
  const active = new Map();

  return createServer(async (req, res) => {
    // No CORS or cookies. User admission never shares Runner authentication.
    const target = req.url || '';
    if (target === '/runtime/v1/tasks/submit' && taskProducer !== null) {
      if (req.method !== 'POST') return send(res, 404, { error: 'runtime_route_not_found' });
      let body;
      try { body = await readSubmission(req); }
      catch { return send(res, 400, { error: 'invalid_task_request' }); }
      try {
        const result = await taskProducer.submit({ authorization: req.headers.authorization, body });
        return send(res, result.replayed ? 200 : 202, result);
      } catch (error) {
        if (error instanceof TaskSubmissionError) {
          return send(res, error.status, { error: error.code });
        }
        return send(res, 503, { error: 'runtime_task_submission_unavailable' });
      }
    }
    if (target === '/runtime/v1/tasks/deliver' && taskDelivery !== null) {
      if (req.method !== 'POST') return send(res, 404, { error: 'runtime_route_not_found' });
      let body;
      try { body = await readSubmission(req); }
      catch { return send(res, 400, { error: 'invalid_delivery_request' }); }
      try {
        const result = await taskDelivery.deliver({ authorization: req.headers.authorization, body });
        return send(res, 200, result);
      } catch (error) {
        if (error instanceof TaskSubmissionError) {
          return send(res, error.status, { error: error.code });
        }
        return send(res, 503, { error: 'runtime_delivery_unavailable' });
      }
    }
    if (!ROUTES.has(target) || req.method !== 'POST') {
      return send(res, 404, { error: 'runtime_route_not_found' });
    }
    const runnerId = authenticate(req.headers.authorization);
    if (!runnerId) return send(res, 401, { error: 'runtime_unauthorized' });

    let offer;
    try { offer = await readOffer(req); }
    catch { return send(res, 400, { error: 'invalid_runtime_offer' }); }

    const port = createTrustedRuntimeTaskPort({
      journal, runtimeClient, authenticatedRunnerId: runnerId,
    });

    if (target === '/runtime/v1/tasks/cancel') {
      try {
        await port.cancellationRequested(offer);
        active.get(offer.dispatchId)?.abort();
        try { await flushRuntimeReconciliations({ journal, runtimeClient }); }
        catch { return send(res, 202, { status: 'reconciliation_pending', dispatchId: offer.dispatchId }); }
        return send(res, 200, { status: 'cancel_recorded', dispatchId: offer.dispatchId });
      } catch { return send(res, 409, { error: 'runtime_task_conflict' }); }
    }

    if (active.has(offer.dispatchId)) return send(res, 409, { error: 'runtime_task_conflict' });
    const controller = new AbortController();
    active.set(offer.dispatchId, controller);
    try {
      // Independent Hub/lease check and atomic encrypted journal claim.
      let task;
      try { task = await port.loadAcceptedTask(offer); }
      catch { return send(res, 409, { error: 'runtime_task_conflict' }); }

      // Repeat Hub lease check and durably record intent BEFORE touching tools.
      try {
        await journal.beginSideEffects(offer.taskRef, runnerId, offer.leaseId, runtimeClient);
        // Do not start side effects unless Hub has committed "running".
        await flushRuntimeReconciliations({ journal, runtimeClient });
      } catch {
        // Claimed/started tasks remain held for explicit recovery, never replay.
        return send(res, 503, { error: 'runtime_execution_not_started_or_uncertain' });
      }
      let result;
      try {
        result = await executor.execute(task, {
          taskRef: offer.taskRef, resourceKey: offer.resourceKey,
          dispatchId: offer.dispatchId, runnerId, leaseId: offer.leaseId,
          signal: controller.signal,
        });
        if (result === undefined) result = { ok: true };
      } catch {
        // CLI failures, timeouts and cancellation may happen AFTER a file edit.
        // Never classify these as "not started" or safe to replay.
        try { journal.markExecutionUncertain(offer.taskRef, runnerId, offer.leaseId); }
        catch { return send(res, 409, { error: 'runtime_outcome_uncertain' }); }
        try { await flushRuntimeReconciliations({ journal, runtimeClient }); }
        catch { return send(res, 202, { status: 'reconciliation_pending', dispatchId: offer.dispatchId }); }
        return send(res, 202, { status: 'outcome_uncertain', dispatchId: offer.dispatchId });
      }
      // A concurrent cancellation can make completion ambiguous. Do not
      // overwrite its hold state or claim success in that case.
      try { journal.complete(offer.taskRef, runnerId, offer.leaseId, 'completed', result); }
      catch { return send(res, 409, { error: 'runtime_outcome_uncertain' }); }

      try { await flushRuntimeReconciliations({ journal, runtimeClient }); }
      catch {
        // Outcome was durably recorded. A retry must NOT run it again.
        return send(res, 202, { status: 'reconciliation_pending', dispatchId: offer.dispatchId });
      }
      return send(res, 200, { status: 'completed', dispatchId: offer.dispatchId });
    } finally {
      active.delete(offer.dispatchId);
    }
  });
}

/** Hard-bind to loopback. Public TLS exposure requires an independently
 * authenticated reverse proxy and a separate security review. */
export async function startLoopbackRuntimeTaskService(options, port = 0, host = '127.0.0.1') {
  if (host !== '127.0.0.1' && host !== '::1') throw new TypeError('runtime_loopback_only');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('invalid_runtime_port');
  const server = createRuntimeTaskService(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
