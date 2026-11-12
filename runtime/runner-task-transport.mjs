/**
 * Runner-side transport for the privately authenticated Runtime service.
 * It implements the existing RunnerTaskPort contract but NEVER receives the
 * task body or Coding Engine result; the trusted Runtime executes in place.
 */
function safeOrigin(input) {
  const url = new URL(input);
  const loopback = url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('runtime_service_origin_invalid');
  }
  return url.origin;
}

export function createRunnerRuntimeTaskPort({ origin, runnerRuntimeToken, transport = fetch }) {
  const base = safeOrigin(origin);
  if (typeof runnerRuntimeToken !== 'string' ||
      !/^[A-Za-z0-9._~-]{32,256}$/.test(runnerRuntimeToken)) {
    throw new TypeError('runtime_runner_token_invalid');
  }
  if (typeof transport !== 'function') throw new TypeError('runtime_transport_invalid');
  async function post(path, offer) {
    const body = {
      dispatchId: offer.dispatchId,
      taskRef: offer.taskRef,
      resourceKey: offer.resourceKey,
      leaseId: offer.leaseId,
    };
    const response = await transport(base + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + runnerRuntimeToken,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    // No raw error bodies: they may originate from misconfigured proxies.
    if (!response.ok) throw new Error('runtime_handoff_rejected_' + response.status);
    if (Number(response.headers.get('content-length') || 0) > 4096) {
      throw new Error('runtime_handoff_invalid_response');
    }
    const text = await response.text();
    if (text.length > 4096) throw new Error('runtime_handoff_invalid_response');
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('runtime_handoff_invalid_response'); }
    if (!data || data.dispatchId !== body.dispatchId ||
        !['completed','failed','reconciliation_pending','cancel_recorded'].includes(data.status)) {
      throw new Error('runtime_handoff_invalid_response');
    }
    return { status: data.status, dispatchId: data.dispatchId };
  }
  return {
    loadAcceptedTask(offer) { return post('/runtime/v1/tasks/execute', offer); },
    async cancellationRequested(offer) {
      await post('/runtime/v1/tasks/cancel', offer);
    },
  };
}
