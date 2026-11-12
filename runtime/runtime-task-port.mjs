/**
 * Trusted Runtime service-side adapter.
 * Never export a RuntimeDispatchClient or encryption key to the Runner.
 * The Runtime server must authenticate its caller independently and then
 * construct this port using the verified Runner ID, not a request body field.
 */
export function createTrustedRuntimeTaskPort({ journal, runtimeClient, authenticatedRunnerId }) {
  if (!journal || typeof journal.claimAcceptedTask !== 'function' ||
      typeof journal.requestCancellation !== 'function' ||
      !runtimeClient || typeof runtimeClient.get !== 'function' ||
      typeof authenticatedRunnerId !== 'string' ||
      !/^runner_[A-Za-z0-9_-]{43}$/.test(authenticatedRunnerId)) {
    throw new TypeError('invalid_trusted_runtime_port');
  }
  return {
    async loadAcceptedTask(offer) {
      return journal.claimAcceptedTask(offer, authenticatedRunnerId, runtimeClient);
    },
    async fenceRequested(offer) {
      // A Runner unable to renew or shutting down may fence ONLY its own
      // currently assigned task. Expired leases still need to be stoppable.
      if (!offer || typeof offer.dispatchId !== 'string' ||
          typeof offer.leaseId !== 'string') {
        throw new TypeError('invalid_runtime_fence');
      }
      const record = await runtimeClient.get(offer.dispatchId);
      if (record.dispatch_id !== offer.dispatchId ||
          record.runner_id !== authenticatedRunnerId ||
          record.lease_id !== offer.leaseId ||
          record.task_ref !== offer.taskRef ||
          record.resource_key !== offer.resourceKey) {
        throw new Error('runtime_fence_not_authorized');
      }
      journal.fenceOwnedTask(offer.taskRef, authenticatedRunnerId,
        offer.leaseId, offer.dispatchId);
    },
    async cancellationRequested(offer) {
      // The Runner cannot turn an arbitrary taskRef into a cancellation order.
      if (!offer || typeof offer.dispatchId !== 'string' || typeof offer.leaseId !== 'string') {
        throw new TypeError('invalid_runtime_cancellation');
      }
      const record = await runtimeClient.get(offer.dispatchId);
      if (record.status !== 'cancel_requested' || record.dispatch_id !== offer.dispatchId ||
          record.runner_id !== authenticatedRunnerId || record.lease_id !== offer.leaseId ||
          record.task_ref !== offer.taskRef || record.resource_key !== offer.resourceKey) {
        throw new Error('runtime_cancellation_not_authorized');
      }
      journal.requestCancellation(offer.taskRef);
    },
  };
}

const EXPECTED_STATUS = Object.freeze({
  running: 'accepted',
  side_effects_uncertain: 'held',
  completed: 'closed',
  failed: 'closed',
  cancelled: 'cancelled',
  not_started: 'queued',
});

/**
 * Runtime-only reconciliation outbox.
 * The task journal is durable; a network failure leaves the report pending.
 * A 409/invalid server response never marks a report acknowledged.
 */
export async function flushRuntimeReconciliations({ journal, runtimeClient }) {
  if (!journal || typeof journal.recoveryPlan !== 'function' ||
      typeof journal.acknowledge !== 'function' ||
      !runtimeClient || typeof runtimeClient.reconcile !== 'function') {
    throw new TypeError('invalid_runtime_reconciliation_port');
  }
  const acknowledged = [];
  for (const item of journal.recoveryPlan()) {
    if (!item.report) continue;
    const report = item.report;
    let valid = false;
    try {
      const answer = await runtimeClient.reconcile(report.dispatchId, report.sequence, report.state);
      valid = !!answer && answer.ok === true && answer.dispatchId === report.dispatchId &&
        answer.runtimeSequence === report.sequence && answer.status === EXPECTED_STATUS[report.state];
      if (!valid) throw new Error('unexpected_runtime_reconciliation');
    } catch (error) {
      // A lost success response or retry 409 is ambiguous. Re-query Hub using
      // the trusted Runtime key; acknowledge only an EXACT committed match.
      if (typeof runtimeClient.get !== 'function') throw error;
      let status;
      try { status = await runtimeClient.get(report.dispatchId); } catch { throw error; }
      valid = !!status && status.dispatch_id === report.dispatchId &&
        status.runtime_sequence === report.sequence && status.runtime_state === report.state &&
        status.status === EXPECTED_STATUS[report.state];
      if (!valid) throw error;
    }
    journal.acknowledge(item.taskRef, report.sequence);
    acknowledged.push({ taskRef: item.taskRef, sequence: report.sequence, state: report.state });
  }
  return acknowledged;
}
