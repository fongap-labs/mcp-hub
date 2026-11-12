import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const REPO = /^fongap-labs\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;
const TASK = /^task_[a-f0-9]{64}$/;

export function gitCommand(cwd, args, { binary = false } = {}) {
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PATHEXT: process.env.PATHEXT,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: nullPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
  try {
    return execFileSync('git', [
      '-c', 'credential.helper=',
      '-c', 'core.hooksPath=' + nullPath,
      '-c', 'protocol.ext.allow=never',
      ...args,
    ], { cwd, env: cleaned, encoding: binary ? undefined : 'utf8', timeout: 60_000,
      maxBuffer: 1024 * 1024, stdio: ['ignore','pipe','ignore'] });
    return binary ? output : output.trim();
  } catch {
    // Never expose Git stderr, task contents, credential helpers or URLs.
    throw new Error('workspace_git_operation_failed');
  }
}

function validDirectory(path) {
  try {
    if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) {
      throw new Error('workspace_symlink_forbidden');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!validDirectory(dirname(path))) throw new Error('workspace_parent_symlink_forbidden');
}

function gitRepoUrl(repository) {
  return 'https://github.com/' + repository + '.git';
}

export function worktreeKey(taskRef) {
  return createHash('sha256').update(taskRef).digest('hex').slice(0, 24);
}

/**
 * Trusted Runtime-only Git workspace preparation. A task cannot supply
 * an origin URL, arbitrary command, workspace path or branch.
 *
 * workspaceRoots maps an approved repository to a trusted local base checkout.
 * A missing base is cloned anonymously using the fixed HTTPS GitHub URL;
 * private repositories require an operator-provisioned base checkout.
 * Worktrees are separate siblings of the base checkout and never auto-reset.
 */
export function createGitWorktreePreparer({ workspaceRoots, runGit = gitCommand }) {
  if (!workspaceRoots || typeof workspaceRoots !== 'object' ||
      Array.isArray(workspaceRoots) || Object.keys(workspaceRoots).length === 0 ||
      typeof runGit !== 'function') {
    throw new TypeError('approved_git_workspaces_required');
  }
  const roots = new Map();
  const used = new Set();
  for (const [repository, path] of Object.entries(workspaceRoots)) {
    if (!REPO.test(repository) || typeof path !== 'string' || !isAbsolute(path)) {
      throw new TypeError('invalid_git_workspace_allowlist');
    }
    const root = resolve(path);
    if (used.has(root) || used.has(root + '.worktrees')) {
      throw new TypeError('duplicated_git_workspace_root');
    }
    used.add(root);
    roots.set(repository, root);
  }

  async function prepare(task, context) {
    if (!task || !REPO.test(task.repository) ||
        !roots.has(task.repository) || !SHA.test(task.sourceSha) ||
        !TASK.test(context?.taskRef) || context?.signal?.aborted) {
      throw new TypeError('unapproved_worktree_task');
    }
    const root = roots.get(task.repository);
    const expectedOrigin = gitRepoUrl(task.repository);
    // Refuse symlinked parents or unexpected existing targets. A missing
    // checkout may only be cloned from the fixed approved HTTPS origin.
    ensureParent(root);
    if (!validDirectory(root)) {
      runGit(dirname(root), [
        'clone', '--no-checkout', '--single-branch', '--branch', 'main',
        '--origin', 'origin', expectedOrigin, root,
      ]);
    }
    if (!validDirectory(root)) throw new Error('git_base_checkout_unavailable');
    const topLevel = runGit(root, ['rev-parse', '--show-toplevel']);
    if (resolve(topLevel) !== root) throw new Error('git_base_checkout_mismatch');
    const origin = runGit(root, ['remote', 'get-url', 'origin']);
    if (origin !== expectedOrigin) throw new Error('git_unapproved_origin');

    // Fetch only main. Never check out or reset the operator's base checkout.
    runGit(root, ['fetch', '--no-tags', 'origin', 'main']);
    const fetched = runGit(root, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (fetched !== task.sourceSha) throw new Error('git_source_sha_mismatch');
    if (context.signal?.aborted) throw new Error('worktree_preparation_cancelled');

    const home = root + '.worktrees';
    mkdirSync(home, { recursive: true, mode: 0o700 });
    if (!validDirectory(home)) throw new Error('workspace_parent_symlink_forbidden');
    const key = worktreeKey(context.taskRef);
    const worktree = join(home, key);
    const branch = 'agent/task-' + key;
    const existing = validDirectory(worktree);
    if (!existing) {
      // Exclusive new branch creation prevents silently reusing stale work.
      runGit(root, ['worktree', 'add', '--no-track', '-b', branch, worktree, task.sourceSha]);
    }
    if (!validDirectory(worktree)) throw new Error('workspace_preparation_failed');
    const common = runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const worktreeCommon = runGit(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const top = runGit(worktree, ['rev-parse', '--show-toplevel']);
    const currentBranch = runGit(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const head = runGit(worktree, ['rev-parse', '--verify', 'HEAD']);
    const dirty = runGit(worktree, ['status', '--porcelain', '--untracked-files=all']);
    if (resolve(common) !== resolve(worktreeCommon) || resolve(top) !== worktree ||
        currentBranch !== branch || head !== task.sourceSha || dirty) {
      throw new Error('git_worktree_integrity_mismatch');
    }
    return worktree;
  }

  return { prepare };
}
