import { collectApprovedWorktreeChanges } from './worktree-change-collector.mjs';
import { TaskSubmissionError } from './authorized-task-producer.mjs';

const REF = /^task_[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const API = 'https://api.github.com';

function reject(status, code) { throw new TaskSubmissionError(status, code); }
function userToken(header) {
  if (typeof header !== 'string' || header.length > 320 ||
      !/^Bearer [A-Za-z0-9_.-]{20,300}$/.test(header)) reject(401, 'github_identity_required');
  return header.slice(7);
}

async function request(fetcher, path, bearer, { method='GET', body, allowNotFound=false } = {}) {
  let response;
  try {
    response = await fetcher(API + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + bearer,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000),
    });
  } catch { reject(503, 'delivery_github_unavailable'); }
  if (allowNotFound && response.status === 404) return null;
  if (response.status === 401) reject(401, 'github_identity_required');
  if (response.status === 403 || response.status === 404) reject(403, 'github_delivery_denied');
  if (response.status === 409 || response.status === 422) reject(409, 'github_delivery_conflict');
  if (!response.ok) reject(503, 'delivery_github_unavailable');
  let payload;
  try { payload = await response.json(); } catch { reject(503, 'delivery_github_unavailable'); }
  if (!payload || typeof payload !== 'object') reject(503, 'delivery_github_unavailable');
  return payload;
}

/**
 * User-initiated PR delivery after the Runtime has safely completed and
 * reconciled a task. The user re-authenticates at delivery time: no user
 * GitHub token was stored in task data or given to Claude/Runner.
 * Commits use GitHub Git Data API; token never enters Git command argv/env.
 */
export function createAuthorizedGithubDelivery({
  journal, workspaceRoots, allowedActors, githubFetch = fetch,
  collectChanges = collectApprovedWorktreeChanges,
}) {
  if (!journal || typeof journal.taskForDelivery !== 'function' ||
      typeof githubFetch !== 'function' || typeof collectChanges !== 'function' ||
      !workspaceRoots || typeof workspaceRoots !== 'object' ||
      !Array.isArray(allowedActors) || allowedActors.length < 1 ||
      !allowedActors.every(a => Number.isSafeInteger(a.id) && a.id > 0 &&
        typeof a.login === 'string')) throw new TypeError('invalid_delivery_components');
  const approvedActors = new Map(allowedActors.map(a => [a.id, a.login.toLowerCase()]));
  const inFlight = new Set();

  return {
    async deliver({ authorization, body }) {
      if (!body || Array.isArray(body) || typeof body !== 'object' ||
          Object.keys(body).length !== 1 || !REF.test(body.taskRef)) {
        reject(400, 'invalid_delivery_request');
      }
      const taskRef = body.taskRef;
      if (inFlight.has(taskRef)) reject(409, 'delivery_already_running');
      inFlight.add(taskRef);
      try {
        // Complete AND reconciled state is required. Old tasks without the
        // originating user ID cannot be delivered and must be resubmitted.
        let task;
        try { task = journal.taskForDelivery(taskRef); }
        catch { reject(409, 'runtime_task_not_deliverable'); }
        if (!SHA.test(task.sourceSha) ||
            !Object.hasOwn(workspaceRoots, task.repository) ||
            !approvedActors.has(task.authorizedActorId)) reject(403, 'delivery_not_authorized');
        const token = userToken(authorization);
        const user = await request(githubFetch, '/user', token);
        if (user.type !== 'User' || user.id !== task.authorizedActorId ||
            typeof user.login !== 'string' ||
            approvedActors.get(user.id) !== user.login.toLowerCase()) {
          reject(403, 'delivery_not_authorized');
        }
        const repo = await request(githubFetch, '/repos/' + task.repository, token);
        if (repo.full_name !== task.repository || repo.default_branch !== 'main' ||
            repo.archived || repo.disabled || repo.permissions?.push !== true) {
          reject(403, 'github_repository_denied');
        }

        const plan = collectChanges({
          taskRef, repository: task.repository,
          sourceSha: task.sourceSha, workspaceRoots,
        });
        if (!plan || plan.repository !== task.repository ||
            plan.taskRef !== taskRef || plan.sourceSha !== task.sourceSha ||
            !Array.isArray(plan.changes) || !plan.changes.length) {
          reject(409, 'delivery_worktree_invalid');
        }

        const prefix = '/repos/' + task.repository;
        const marker = '<!-- fongap-task:' + taskRef + ' -->';
        const title = 'fix: 交付受控编程任务 ' + taskRef.slice(5, 13);
        const existing = await request(githubFetch,
          prefix + '/pulls?state=all&base=main&head=' +
          encodeURIComponent('fongap-labs:' + plan.branch) + '&per_page=50', token);
        if (!Array.isArray(existing)) reject(503, 'delivery_github_unavailable');
        const matching = existing.filter(p => p.head?.ref === plan.branch &&
          p.base?.ref === 'main' && typeof p.body === 'string' && p.body.includes(marker));
        if (existing.length && matching.length !== 1) reject(409, 'delivery_pr_conflict');
        if (matching.length === 1) {
          const pr = matching[0];
          if (pr.state !== 'open' || !Number.isSafeInteger(pr.number) ||
              !/^https:\/\/github\.com\/fongap-labs\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(pr.html_url)) {
            reject(409, 'delivery_pr_conflict');
          }
          return { taskRef, status: 'review_pending', pullRequest: pr.number,
            url: pr.html_url, replayed: true };
        }

        // A moved main may invalidate reviewed task content; do not publish
        // a new branch/PR against a different baseline.
        const main = await request(githubFetch, prefix + '/git/ref/heads/main', token);
        if (main.object?.sha !== task.sourceSha) reject(409, 'delivery_main_moved');
        const baseCommit = await request(githubFetch,
          prefix + '/git/commits/' + task.sourceSha, token);
        if (!SHA.test(baseCommit.tree?.sha)) reject(503, 'delivery_github_unavailable');

        const blobEntries = [];
        for (const change of plan.changes) {
          if (change.sha === null) {
            blobEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
          } else {
            const blob = await request(githubFetch, prefix + '/git/blobs', token, {
              method: 'POST', body: { content: change.content, encoding: 'base64' },
            });
            if (!SHA.test(blob.sha)) reject(503, 'delivery_github_unavailable');
            blobEntries.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob.sha });
          }
        }
        const tree = await request(githubFetch, prefix + '/git/trees', token, {
          method: 'POST', body: { base_tree: baseCommit.tree.sha, tree: blobEntries },
        });
        if (!SHA.test(tree.sha)) reject(503, 'delivery_github_unavailable');

        const expectedMessage = title + '\n\nTask: ' + taskRef + '\nBase: ' + task.sourceSha;
        let current = await request(githubFetch,
          prefix + '/git/ref/heads/' + plan.branch, token, { allowNotFound: true });
        if (!current) {
          const commit = await request(githubFetch, prefix + '/git/commits', token, {
            method: 'POST', body: {
              message: expectedMessage, tree: tree.sha, parents: [task.sourceSha],
            },
          });
          if (!SHA.test(commit.sha)) reject(503, 'delivery_github_unavailable');
          // Create ONLY a new refs/heads/agent/task-* ref; never update main
          // or force-push an existing branch.
          try {
            current = await request(githubFetch, prefix + '/git/refs', token, {
              method: 'POST', body: { ref: 'refs/heads/' + plan.branch, sha: commit.sha },
            });
          } catch (error) {
            // A lost create response is ambiguous; verify exact branch state.
            current = await request(githubFetch,
              prefix + '/git/ref/heads/' + plan.branch, token, { allowNotFound: true });
            if (!current) throw error;
          }
        }
        if (!SHA.test(current.object?.sha)) reject(409, 'delivery_branch_conflict');
        const committed = await request(githubFetch,
          prefix + '/git/commits/' + current.object.sha, token);
        if (committed.tree?.sha !== tree.sha ||
            committed.message !== expectedMessage ||
            committed.parents?.length !== 1 ||
            committed.parents[0].sha !== task.sourceSha) {
          reject(409, 'delivery_branch_conflict');
        }

        const bodyText = [
          '受控 Coding Runtime 提交，待中央 Action Worker 门禁与独立审查。',
          '',
          'Base: ' + task.sourceSha,
          'Task: ' + taskRef,
          'Files: ' + plan.changes.map(change => change.path).join(', '),
          '',
          marker,
        ].join('\n');
        let pr;
        try {
          pr = await request(githubFetch, prefix + '/pulls', token, {
            method: 'POST', body: {
              title, head: plan.branch, base: 'main', body: bodyText,
              maintainer_can_modify: false,
            },
          });
        } catch (error) {
          // The GitHub PR may have been created even when the response was
          // lost. Re-read and verify the task marker before reporting failure.
          const found = await request(githubFetch,
            prefix + '/pulls?state=open&base=main&head=' +
            encodeURIComponent('fongap-labs:' + plan.branch) + '&per_page=50', token);
          pr = Array.isArray(found) ? found.find(x => x.head?.ref === plan.branch &&
            x.body?.includes(marker)) : null;
          if (!pr) throw error;
        }
        if (!Number.isSafeInteger(pr.number) ||
            !/^https:\/\/github\.com\/fongap-labs\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(pr.html_url)) {
          reject(503, 'delivery_github_unavailable');
        }
        // The central PR Governance validates and may merge separately.
        return { taskRef, status: 'review_pending', pullRequest: pr.number,
          url: pr.html_url, replayed: false };
      } finally { inFlight.delete(taskRef); }
    },
  };
}
