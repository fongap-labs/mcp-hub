import type { Env, McpAuth, DataObject } from '../../types.ts';
import type { McpTool } from '../../gateway/types.ts';
import { callAgentTaskTool, listAgentTaskTools } from './agent-tasks.ts';
import { PublicError, githubPath, getOwnerToken, apiFetch, summarize } from '../../github.ts';
import { now, randomId, validOwner, validRepo } from '../../util.ts';

const S = { type: 'string' };
const N = { type: 'integer', minimum: 1 };

function spec(name: string, description: string, props: Record<string, unknown>, required: string[] = ['owner', 'repo']): McpTool {
  return { name, description, inputSchema: { type: 'object', properties: props, required, additionalProperties: false } };
}

export function listGitHubTools(env: Env, auth: McpAuth): readonly McpTool[] {
  const tools = [
    spec('github_available_owners', 'List GitHub usernames/organizations configured in this MCP; NEVER reveals tokens.', {}, []),
    spec('github_get_repository', 'Read GitHub repository metadata using the token mapped to owner.', { owner: S, repo: S }),
    spec('github_list_issues', 'List issues, excluding pull requests.', { owner: S, repo: S, state: { type: 'string', enum: ['open', 'closed', 'all'] }, per_page: { type: 'integer', minimum: 1, maximum: 50 } }),
    spec('github_get_issue', 'Read one issue.', { owner: S, repo: S, number: N }, ['owner', 'repo', 'number']),
    spec('github_list_pull_requests', 'List pull requests.', { owner: S, repo: S, state: { type: 'string', enum: ['open', 'closed', 'all'] }, per_page: { type: 'integer', minimum: 1, maximum: 50 } }),
    spec('github_get_pull_request', 'Read one pull request.', { owner: S, repo: S, number: N }, ['owner', 'repo', 'number']),
  ];
  if (env.GMC_CONTENT_MODE === 'enabled') {
    tools.push(spec('github_read_file', 'Read a repository file; CONTENT MAY CONTAIN SECRETS. Disabled by default.', { owner: S, repo: S, path: S, ref: S }, ['owner', 'repo', 'path']));
  }
  if (env.GMC_WRITE_MODE === 'approval' && auth.scopes.includes('mcp:write')) {
    tools.push(spec('github_create_issue', 'Request creating a GitHub issue; executes ONLY after independent administrator approval.', { owner: S, repo: S, title: S, body: S }, ['owner', 'repo', 'title']));
  }
  tools.push(...listAgentTaskTools(env, auth));
  tools.push(spec('github_operation_status', 'Check the status of a write request submitted by this MCP client.', { request_id: S }, ['request_id']));
  return tools;
}

export async function callGitHubTool(name: string, args: DataObject, env: Env, auth: McpAuth): Promise<unknown> {
  if (name === 'fongap_submit_task' || name === 'fongap_task_dispatch_status') {
    return callAgentTaskTool(name, args, env, auth);
  }
  const scopes = auth.scopes;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new PublicError('Invalid arguments');
  if (name === 'github_available_owners') {
    const { results = [] } = await env.MCP_DB.prepare('SELECT owner,owner_kind FROM github_connections WHERE enabled=1 ORDER BY owner LIMIT 100').all();
    return results.filter(x => auth.allowedOwners.includes(x.owner.toLowerCase())).map(({ owner, owner_kind }) => ({ owner, kind: owner_kind }));
  }
  if (name === 'github_operation_status') {
    if (typeof args.request_id !== 'string' || !/^[-_A-Za-z0-9]{43}$/.test(args.request_id)) throw new PublicError('Invalid request id');
    const row = await env.MCP_DB.prepare('SELECT owner,repo,title,status,result_json,expires_at FROM approval_requests WHERE id=? AND client_id=?').bind(args.request_id, auth.clientId).first();
    if (!row || !auth.allowedOwners.includes(row.owner) || (row.expires_at as number) <= now() && row.status === 'pending') throw new PublicError('Operation not available');
    return { owner: row.owner, repo: row.repo, title: row.title, status: row.status, result: row.result_json ? JSON.parse(row.result_json as string) : null };
  }

  const types: Record<string, 'repo' | 'issues' | 'issue' | 'pulls' | 'pull' | 'file' | undefined> = {
    github_get_repository: 'repo',
    github_list_issues: 'issues',
    github_get_issue: 'issue',
    github_list_pull_requests: 'pulls',
    github_get_pull_request: 'pull',
    github_read_file: 'file',
  };
  const kind = types[name];
  if (kind === 'file' && env.GMC_CONTENT_MODE !== 'enabled') throw new PublicError('File reading is disabled');
  if (!kind && name !== 'github_create_issue') throw new PublicError('Unknown tool');
  if (name === 'github_create_issue' && !(env.GMC_WRITE_MODE === 'approval' && scopes.includes('mcp:write'))) throw new PublicError('Write access is disabled');
  if (!validOwner(args.owner) || !auth.allowedOwners.includes(args.owner.toLowerCase())) throw new PublicError('Owner not authorized for this MCP client');
  if (!validRepo(args.repo)) throw new PublicError('Invalid repository name');

  const path = githubPath({
    owner: args.owner,
    repo: args.repo,
    kind: kind || 'repo',
    number: typeof args.number === 'number' ? args.number : undefined,
    path: typeof args.path === 'string' ? args.path : undefined,
    ref: typeof args.ref === 'string' ? args.ref : undefined,
    state: typeof args.state === 'string' ? args.state : undefined,
    per_page: typeof args.per_page === 'number' ? args.per_page : undefined,
  });
  if (name === 'github_create_issue') {
    if (typeof args.title !== 'string' || args.title.length < 1 || args.title.length > 256 || typeof (args.body ?? '') !== 'string' || String(args.body ?? '').length > 10000) {
      throw new PublicError('Invalid issue title or body');
    }
    const requestId = randomId();
    await env.MCP_DB.prepare('INSERT INTO approval_requests(id,client_id,owner,repo,title,body,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?, ?,?)')
      .bind(requestId, auth.clientId, args.owner.toLowerCase(), args.repo, args.title, String(args.body || ''), 'pending', now(), now() + 600).run();
    return { status: 'pending', request_id: requestId, message: 'Administrator approval is required. Use github_operation_status to check later.' };
  }
  const token = await getOwnerToken(env, args.owner);
  const data = await apiFetch(token, path);
  return summarize(kind || 'repo', data);
}
