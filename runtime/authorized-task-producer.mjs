import { createHash } from 'node:crypto';

const REPOSITORY = /^fongap-labs\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const REQUEST = /^[A-Za-z0-9._:-]{16,128}$/;
const DISPATCH = /^dispatch_[A-Za-z0-9_-]{43}$/;
const GITHUB_API = 'https://api.github.com';

export class TaskSubmissionError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'TaskSubmissionError';
    this.status = status;
    this.code = code;
  }
}

function reject(status, code) { throw new TaskSubmissionError(status, code); }
function parseTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'prompt,repository,requestId,sourceSha') {
    reject(400, 'invalid_task_request');
  }
  const { requestId, repository, sourceSha, prompt } = value;
  if (typeof requestId !== 'string' || !REQUEST.test(requestId) ||
      typeof repository !== 'string' || !REPOSITORY.test(repository) ||
      typeof sourceSha !== 'string' || !SHA.test(sourceSha) ||
      typeof prompt !== 'string' || prompt.trim().length < 4 ||
      Buffer.byteLength(prompt, 'utf8') > 16_384) {
    reject(400, 'invalid_task_request');
  }
  return { requestId, repository, sourceSha, prompt };
}

function githubBearer(authorization) {
  if (typeof authorization !== 'string' || authorization.length > 320 ||
      !/^Bearer [A-Za-z0-9_.-]{20,300}$/.test(authorization)) {
    reject(401, 'github_identity_required');
  }
  return authorization.slice(7);
}

async function githubJson(fetcher, path, token) {
  let response;
  try {
    response = await fetcher(GITHUB_API + path, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(10000),
    });
  } catch { reject(503, 'github_identity_unavailable'); }
  if (response.status === 401) reject(401, 'github_identity_required');
  if (response.status === 403 || response.status === 404) reject(403, 'github_repository_denied');
  if (!response.ok) reject(503, 'github_identity_unavailable');
  let value;
  try { value = await response.json(); }
  catch { reject(503, 'github_identity_unavailable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject(503, 'github_identity_unavailable');
  }
  return value;
}

/**
 * Local trusted Runtime intake. A caller must present a genuine GitHub user
 * token; only GitHub's /user response authenticates their user ID.
 * The separate actor+repo allowlists are an additional operator gate.
 *
 * This does NOT use Action Worker's private Agent ingress or fongap-bot.
 * It cannot impersonate the GitHub actor, create PRs, or deploy anything.
 */
export function createAuthorizedTaskProducer({
  journal, runtimeClient, allowedActors, allowedRepositories, githubFetch = fetch,
}) {
  if (!journal || typeof journal.createTask !== 'function' ||
      typeof journal.inspectSubmission !== 'function' ||
      typeof journal.attachDispatch !== 'function' ||
      !runtimeClient || typeof runtimeClient.create !== 'function' ||
      typeof githubFetch !== 'function') {
    throw new TypeError('trusted_task_producer_components_required');
  }
  if (!Array.isArray(allowedActors) || allowedActors.length < 1 ||
      !allowedActors.every(a => a && Number.isSafeInteger(a.id) && a.id > 0 &&
        typeof a.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(a.login)) ||
      new Set(allowedActors.map(a => a.id)).size !== allowedActors.length) {
    throw new TypeError('trusted_github_actors_required');
  }
  if (!Array.isArray(allowedRepositories) || allowedRepositories.length < 1 ||
      !allowedRepositories.every(r => typeof r === 'string' && REPOSITORY.test(r)) ||
      new Set(allowedRepositories).size !== allowedRepositories.length) {
    throw new TypeError('approved_task_repositories_required');
  }
  const actors = new Map(allowedActors.map(a => [a.id, a.login.toLowerCase()]));
  const repositories = new Set(allowedRepositories);

  return {
    async submit({ authorization, body }) {
      const task = parseTask(body);
      if (!repositories.has(task.repository)) reject(403, 'repository_not_allowlisted');
      const bearer = githubBearer(authorization);
      // Never trust a login, actor ID, or permission claim from the request.
      const user = await githubJson(githubFetch, '/user', bearer);
      if (!Number.isSafeInteger(user.id) || user.type !== 'User' ||
          typeof user.login !== 'string' || actors.get(user.id) !== user.login.toLowerCase()) {
        reject(403, 'github_actor_denied');
      }
      const repo = await githubJson(githubFetch, '/repos/' + task.repository, bearer);
      if (repo.full_name !== task.repository || repo.default_branch !== 'main' ||
          repo.archived === true || repo.disabled === true ||
          (!repo.permissions || repo.permissions.push !== true)) {
        reject(403, 'github_repository_denied');
      }
      const commit = await githubJson(githubFetch, '/repos/' + task.repository + '/commits/main', bearer);
      if (commit.sha !== task.sourceSha) reject(409, 'source_sha_changed');

      // A deterministic task identity prevents duplicate work after an
      // ambiguous Hub response. Hash includes verified GitHub numeric user ID.
      const taskRef = 'task_' + createHash('sha256').update(String(user.id) + ':' + task.requestId).digest('hex');
      const resourceKey = 'repo:' + task.repository.replace('/', '_');
      const savedTask = {
        repository: task.repository, sourceSha: task.sourceSha, prompt: task.prompt,
        authorizedActorId: user.id,
      };
      const digest = createHash('sha256').update(JSON.stringify(savedTask)).digest('hex');
      let created = false;
      try {
        journal.createTask({ taskRef, resourceKey, task: savedTask });
        created = true;
      } catch {
        // Only a prior matching durable submission is recoverable. Never
        // interpret an arbitrary SQLite or encryption error as success.
        let record;
        try { record = journal.inspectSubmission(taskRef); }
        catch { reject(503, 'runtime_journal_unavailable'); }
        if (record.digest !== digest || record.resourceKey !== resourceKey) {
          reject(409, 'task_idempotency_conflict');
        }
      }
      const saved = journal.inspectSubmission(taskRef);
      if (saved.digest !== digest || saved.resourceKey !== resourceKey) {
        reject(409, 'task_idempotency_conflict');
      }
      if (saved.state !== 'prepared') {
        if (saved.dispatchId && DISPATCH.test(saved.dispatchId)) {
          return { taskRef, dispatchId: saved.dispatchId, status: saved.state, replayed: true };
        }
        reject(409, 'task_idempotency_conflict');
      }

      const request = {
        protocolVersion: 'v1', idempotencyKey: taskRef, taskRef, resourceKey,
        requiredCapabilities: ['coding.patch'], priority: 50,
        quotaKey: null, leaseSeconds: 300,
      };
      let response;
      try { response = await runtimeClient.create(request); }
      catch {
        // Task stays encrypted/prepared for the caller to retry with the same
        // idempotency key; Hub dispatch deduplicates based on that key.
        reject(503, 'task_dispatch_pending_retry');
      }
      if (!response || typeof response.dispatchId !== 'string' ||
          !DISPATCH.test(response.dispatchId)) {
        reject(503, 'task_dispatch_response_invalid');
      }
      try { journal.attachDispatch(taskRef, response.dispatchId); }
      catch { reject(503, 'task_dispatch_attach_pending_retry'); }
      return { taskRef, dispatchId: response.dispatchId, status: 'dispatched', replayed: !created };
    },
  };
}
