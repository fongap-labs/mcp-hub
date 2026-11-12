import { spawn, execFileSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const REPO = /^fongap-labs\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_BRANCH = /^(?:feat|fix|chore|agent)\/[A-Za-z0-9._/-]{1,140}$/;

/**
 * A concrete, opt-in Claude Code CLI backend. No command or argument from a
 * task is executed directly. Claude is restricted to file read/write tools,
 * no Bash, external MCP, or permission bypass. This is not an OS sandbox.
 */
export function createClaudeCodeExecutor({
  executablePath, workspaceRoots, maxTurns = 12, timeoutMs = 20 * 60_000,
  gitExecutable = 'git', spawnProcess = spawn, inspectGit = null,
}) {
  if (typeof executablePath !== 'string' || !isAbsolute(executablePath)) {
    throw new TypeError('absolute_claude_executable_required');
  }
  if (!workspaceRoots || typeof workspaceRoots !== 'object' ||
      Array.isArray(workspaceRoots) || !Object.keys(workspaceRoots).length) {
    throw new TypeError('approved_workspaces_required');
  }
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 24 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2 * 60 * 60_000) {
    throw new TypeError('invalid_coding_engine_limits');
  }
  const approved = new Map();
  for (const [repo, workspace] of Object.entries(workspaceRoots)) {
    if (!REPO.test(repo) || typeof workspace !== 'string' || !isAbsolute(workspace)) {
      throw new TypeError('invalid_approved_workspace');
    }
    approved.set(repo, resolve(workspace));
  }
  const getGit = inspectGit ?? ((cwd, args) => execFileSync(gitExecutable, args, {
    cwd, timeout: 5000, encoding: 'utf8', stdio: ['ignore','pipe','ignore'],
  }).trim());

  return {
    async execute(task, context) {
      if (!task || typeof task !== 'object' || !REPO.test(task.repository) ||
          !approved.has(task.repository) ||
          typeof task.prompt !== 'string' || task.prompt.trim().length < 4 ||
          task.prompt.length > 30000 || !SHA.test(task.sourceSha)) {
        throw new TypeError('unapproved_coding_task');
      }
      const workspace = approved.get(task.repository);
      const physical = realpathSync(workspace);
      if (physical !== workspace) throw new Error('workspace_symlink_forbidden');
      const branch = getGit(workspace, ['symbolic-ref','--quiet','--short','HEAD']);
      if (!SAFE_BRANCH.test(branch) || branch.includes('..') || branch.includes('//')) {
        throw new Error('approved_feature_branch_required');
      }
      const checkedOut = getGit(workspace, ['rev-parse','HEAD']);
      if (checkedOut !== task.sourceSha) throw new Error('workspace_source_sha_mismatch');
      if (context?.signal?.aborted) throw new Error('coding_execution_aborted');

      const args = [
        '-p', '--output-format', 'json',
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Glob,Grep,Edit,Write',
        '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write',
        '--strict-mcp-config', '--disallowedTools', 'mcp__*',
        '--no-session-persistence', '--max-turns', String(maxTurns),
      ];
      // Pass only a small set of host configuration variables. Do not forward
      // GITHUB_TOKEN, cloud secrets or arbitrary environment variables.
      const allowedEnv = [
        'PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME',
        'ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN',
        'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','SSL_CERT_FILE',
      ];
      const env = Object.fromEntries(allowedEnv.filter(k => typeof process.env[k] === 'string')
        .map(k => [k, process.env[k]]));
      const signal = context?.signal
        ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const output = await new Promise((resolveDone, rejectDone) => {
        let child;
        try {
          child = spawnProcess(executablePath, args, {
            cwd: workspace, env, shell: false, windowsHide: true, signal,
            stdio: ['pipe','pipe','pipe'],
          });
        } catch { rejectDone(new Error('coding_engine_spawn_failed')); return; }
        const chunks = [];
        let length = 0;
        let overflow = false;
        child.stdout?.on('data', chunk => {
          length += chunk.length;
          if (length > 1024 * 1024) { overflow = true; child.kill(); }
          else chunks.push(chunk);
        });
        child.stderr?.resume(); // Do not print or persist secret-containing stderr.
        child.on('error', () => rejectDone(new Error('coding_engine_spawn_failed')));
        child.on('close', code => {
          if (overflow) return rejectDone(new Error('coding_engine_output_too_large'));
          if (signal.aborted) return rejectDone(new Error('coding_engine_cancelled_or_timed_out'));
          if (code !== 0) return rejectDone(new Error('coding_engine_failed'));
          resolveDone(Buffer.concat(chunks).toString('utf8'));
        });
        try { child.stdin?.end(task.prompt); }
        catch { child.kill(); rejectDone(new Error('coding_engine_input_failed')); }
      });
      let result;
      try { result = JSON.parse(output); }
      catch { throw new Error('invalid_coding_engine_json'); }
      if (!result || result.is_error === true || typeof result.result !== 'string') {
        throw new Error('coding_engine_result_unavailable');
      }
      // Stored only in the encrypted Runtime journal, never returned to Runner.
      return { engine: 'claude-code', summary: result.result.slice(0, 20000) };
    },
  };
}
