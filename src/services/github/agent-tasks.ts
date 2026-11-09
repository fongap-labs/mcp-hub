import type { Env, McpAuth, DataObject } from '../../types.ts';
import type { McpTool } from '../../gateway/types.ts';
import { PublicError, getOwnerToken, apiFetch } from '../../github.ts';
import { now, sha, validRepo } from '../../util.ts';

// All agent clients use the same versioned, pre-existing Action Worker task contract.
// MCP callers cannot supply executable commands, credentials, capabilities, or branch SHAs.
const CONTROL_REPOSITORY = 'fongap-labs/action-worker';
const REQUEST_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

type TaskRecord = {
  client_id: string;
  request_id: string;
  repository: string;
  project: string;
  bootstrap_ref: string;
  execution_id: string;
  status: string;
  created_at: number;
  updated_at: number;
};

export function listAgentTaskTools(env: Env, auth: McpAuth): readonly McpTool[] {
  if (env.GMC_TASK_MODE !== 'enabled' || !auth.scopes.includes('mcp:write')) return [];
  return [
    {
      name: 'fongap_submit_task',
      description: 'Submit an existing, trusted-main project task to Fongap Action Worker. Does not accept prompts, commands, or credentials. Returns dispatch acceptance, NOT execution success.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', const: 'fongap-labs' },
          repo: { type: 'string', minLength: 1 },
          project: { type: 'string', minLength: 1 },
          request_id: { type: 'string', minLength: 1 },
        },
        required: ['owner', 'repo', 'project', 'request_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'fongap_task_dispatch_status',
      description: 'Read the MCP dispatch receipt for this client and request_id. Dispatch acceptance does not mean the Action Worker task completed.',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'string', minLength: 1 } },
        required: ['request_id'],
        additionalProperties: false,
      },
    },
  ];
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_PATTERN.test(value);
}

async function loadReceipt(env: Env, auth: McpAuth, requestId: string): Promise<TaskRecord | null> {
  return env.MCP_DB.prepare(
    'SELECT client_id,request_id,repository,project,bootstrap_ref,execution_id,status,created_at,updated_at FROM agent_task_dispatches WHERE client_id=? AND request_id=?'
  ).bind(auth.clientId, requestId).first<TaskRecord>();
}

function receipt(row: TaskRecord): Record<string, unknown> {
  return {
    request_id: row.request_id,
    repository: row.repository,
    project: row.project,
    source_sha: row.bootstrap_ref,
    execution_id: row.execution_id,
    dispatch_status: row.status,
    execution_status: 'not_available',
    message: 'This receipt only tracks GitHub dispatch, not Action Worker execution. Check central Actions for execution result.',
  };
}

async function setStatus(env: Env, auth: McpAuth, requestId: string, status: string): Promise<void> {
  await env.MCP_DB.prepare(
    'UPDATE agent_task_dispatches SET status=?,updated_at=? WHERE client_id=? AND request_id=?'
  ).bind(status, now(), auth.clientId, requestId).run();
}

export async function callAgentTaskTool(
  name: string,
  args: DataObject,
  env: Env,
  auth: McpAuth
): Promise<Record<string, unknown>> {
  if (env.GMC_TASK_MODE !== 'enabled' || !auth.scopes.includes('mcp:write')) {
    throw new PublicError('Task dispatch is disabled');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new PublicError('Invalid task arguments');
  }
  if (!validRequestId(args.request_id)) throw new PublicError('Invalid request_id');

  if (name === 'fongap_task_dispatch_status') {
    if (Object.keys(args).some(key => key !== 'request_id')) throw new PublicError('Unsupported task field');
    const row = await loadReceipt(env, auth, args.request_id);
    if (!row) throw new PublicError('Task request not available for this client');
    return receipt(row);
  }
  if (name !== 'fongap_submit_task') throw new PublicError('Unknown task tool');
  if (Object.keys(args).some(key => !['owner', 'repo', 'project', 'request_id'].includes(key))) {
    throw new PublicError('Unsupported task field');
  }
  if (args.owner !== 'fongap-labs' || !auth.allowedOwners.includes('fongap-labs')) {
    throw new PublicError('GitHub owner not authorized for this client');
  }
  if (!validRepo(args.repo) || typeof args.project !== 'string' || !PROJECT_PATTERN.test(args.project)) {
    throw new PublicError('Invalid repository or project');
  }

  const repository = 'fongap-labs/' + args.repo;
  const existing = await loadReceipt(env, auth, args.request_id);
  if (existing) {
    if (existing.repository !== repository || existing.project !== args.project) {
      throw new PublicError('request_id already used for a different task');
    }
    return receipt(existing);
  }

  // A trusted source SHA is determined from GitHub rather than supplied by an Agent.
  const token = await getOwnerToken(env, 'fongap-labs');
  const repo = await apiFetch<{ default_branch?: string }>(
    token, '/repos/fongap-labs/' + encodeURIComponent(args.repo)
  );
  if (!repo.default_branch || !/^[A-Za-z0-9._/-]{1,128}$/.test(repo.default_branch)) {
    throw new PublicError('Repository default branch is unavailable');
  }
  const head = await apiFetch<{ sha?: string }>(
    token, '/repos/fongap-labs/' + encodeURIComponent(args.repo) + '/commits/' + encodeURIComponent(repo.default_branch)
  );
  if (!head.sha || !SHA_PATTERN.test(head.sha)) {
    throw new PublicError('Trusted source commit is unavailable');
  }
  const executionId = 'mcp-' + await sha(auth.clientId + ':' + args.request_id);
  // First writer wins on concurrent duplicate requests. There is no automatic
  // resend of an uncertain GitHub POST: duplicate work is more dangerous than a held task.
  const inserted = await env.MCP_DB.prepare(
    "INSERT INTO agent_task_dispatches(client_id,request_id,repository,project,bootstrap_ref,execution_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'submitting',?,?) ON CONFLICT(client_id,request_id) DO NOTHING RETURNING request_id"
  ).bind(auth.clientId, args.request_id, repository, args.project, head.sha, executionId, now(), now()).first();
  const saved = await loadReceipt(env, auth, args.request_id);
  if (!saved) throw new PublicError('Unable to save dispatch receipt');
  if (saved.execution_id !== executionId || saved.repository !== repository || saved.project !== args.project) {
    throw new PublicError('request_id already used for a different task');
  }
  if (!inserted) return receipt(saved);

  let response: Response;
  try {
    response = await fetch('https://api.github.com/repos/' + CONTROL_REPOSITORY + '/dispatches', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mcp-hub',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'run-task',
        client_payload: {
          schema_version: '1',
          request_id: executionId,
          repository,
          project: args.project,
          bootstrap_ref: head.sha,
          agent_domain: 'coding',
          operation: 'task',
        },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    await setStatus(env, auth, args.request_id, 'uncertain');
    throw new PublicError('Dispatch result is uncertain. Inspect the receipt and central Actions; do not automatically retry.');
  }
  if (response.status !== 204) {
    const rejected = response.status >= 400 && response.status < 500;
    await setStatus(env, auth, args.request_id, rejected ? 'rejected' : 'uncertain');
    throw new PublicError('Central GitHub dispatch was not confirmed (HTTP ' + response.status + ').');
  }
  await setStatus(env, auth, args.request_id, 'dispatched');
  const confirmed = await loadReceipt(env, auth, args.request_id);
  if (!confirmed) throw new PublicError('Dispatch receipt is unavailable');
  return receipt(confirmed);
}
