import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createGitWorktreePreparer } from '../runtime/git-worktree-preparer.mjs';
import { createClaudeCodeExecutor } from '../runtime/claude-code-executor.mjs';

const REPO = 'fongap-labs/demo';
const REF = 'task_' + 'a'.repeat(64);
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-worktree-'));
  const root = join(dir, 'base');
  mkdirSync(root, { mode: 0o700 });
  git(dir, ['init', '-b', 'main', root]);
  writeFileSync(join(root, 'README.md'), '# Source\n');
  git(root, ['add', 'README.md']);
  git(root, ['-c', 'user.name=Test User', '-c', 'user.email=runner@example.invalid',
    'commit', '-m', 'baseline']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/fongap-labs/demo.git']);
  const sha = git(root, ['rev-parse', 'HEAD']);
  const task = { repository: REPO, sourceSha: sha, prompt: 'Fix a test without changing permissions.' };
  const calls = [];
  let upstreamSha = sha;
  function runner(cwd, args) {
    calls.push({ cwd, args });
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse' && args.includes('FETCH_HEAD^{commit}')) return upstreamSha;
    return git(cwd, args);
  }
  return { dir, root, task, calls, runner,
    getSha: () => upstreamSha, moveRemote: value => { upstreamSha = value; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('real Git worktree is created from approved origin and pinned source SHA, and reused cleanly', async () => {
  const env = setup();
  try {
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    const target = await preparer.prepare(env.task, { taskRef: REF });
    const key = createHash('sha256').update(REF).digest('hex').slice(0, 24);
    assert.equal(target, join(env.root + '.worktrees', key));
    assert.equal(git(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']), 'agent/task-' + key);
    assert.equal(git(target, ['rev-parse', 'HEAD']), env.task.sourceSha);
    assert.equal(git(target, ['status', '--porcelain']), '');
    assert.equal(await preparer.prepare(env.task, { taskRef: REF }), target);
    assert.equal(env.calls.filter(c => c.args[0] === 'worktree' && c.args[1] === 'add').length, 1,
      'Existing clean worktree must never be rebuilt or reset');
  } finally { env.cleanup(); }
});

test('dirty worktrees cannot be silently re-used, reset or overwritten', async () => {
  const env = setup();
  try {
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    const target = await preparer.prepare(env.task, { taskRef: REF });
    writeFileSync(join(target, 'README.md'), '# User changes must survive\n');
    await assert.rejects(preparer.prepare(env.task, { taskRef: REF }),
      /git_worktree_integrity_mismatch/);
    assert.match(git(target, ['diff', '--', 'README.md']), /User changes must survive/);
  } finally { env.cleanup(); }
});

test('a moved upstream main SHA is refused before any worktree is created', async () => {
  const env = setup();
  try {
    env.moveRemote('b'.repeat(40));
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    await assert.rejects(preparer.prepare(env.task, { taskRef: REF }), /git_source_sha_mismatch/);
    assert.equal(env.calls.filter(c => c.args[0] === 'worktree').length, 0);
  } finally { env.cleanup(); }
});

test('unapproved origin, repository, malformed task reference and pre-aborted job are rejected', async () => {
  const env = setup();
  try {
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    await assert.rejects(preparer.prepare({ ...env.task, repository: 'evil/repo' }, { taskRef: REF }),
      /unapproved_worktree_task/);
    await assert.rejects(preparer.prepare(env.task, { taskRef: '../unsafe' }),
      /unapproved_worktree_task/);
    await assert.rejects(preparer.prepare(env.task, { taskRef: REF, signal: AbortSignal.abort() }),
      /unapproved_worktree_task/);
    git(env.root, ['remote', 'set-url', 'origin', 'https://github.com/another/repo.git']);
    await assert.rejects(preparer.prepare(env.task, { taskRef: REF }), /git_unapproved_origin/);
    assert.equal(env.calls.some(x => x.args[0] === 'worktree'), false);
  } finally { env.cleanup(); }
});

test('symlinked approved base and target directories are rejected', async () => {
  const env = setup();
  try {
    const alias = join(env.dir, 'alias');
    symlinkSync(env.root, alias, 'dir');
    const bad = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: alias }, runGit: env.runner,
    });
    await assert.rejects(bad.prepare(env.task, { taskRef: REF }), /workspace_symlink_forbidden/);
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    const worktreeHome = env.root + '.worktrees';
    mkdirSync(worktreeHome);
    const key = createHash('sha256').update(REF).digest('hex').slice(0, 24);
    symlinkSync(env.root, join(worktreeHome, key), 'dir');
    await assert.rejects(preparer.prepare(env.task, { taskRef: REF }), /workspace_symlink_forbidden/);
  } finally { env.cleanup(); }
});

test('Claude executor runs in newly prepared task-specific worktree, never base checkout', async () => {
  const env = setup();
  const calls = [];
  function fakeSpawn(exe, args, options) {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', () => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ is_error: false, result: 'Changed isolated worktree' }));
        child.stdout.end();
        child.emit('close', 0);
      });
    });
    return child;
  }
  try {
    const preparer = createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root }, runGit: env.runner,
    });
    const executor = createClaudeCodeExecutor({
      executablePath: '/opt/claude/claude',
      workspaceRoots: { [REPO]: env.root },
      workspacePreparer: preparer, spawnProcess: fakeSpawn,
      inspectGit: git,
    });
    const answer = await executor.execute(env.task, { taskRef: REF });
    assert.equal(answer.summary, 'Changed isolated worktree');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].options.cwd.startsWith(env.root + '.worktrees' + sep));
    assert.notEqual(calls[0].options.cwd, env.root);
    assert.equal(calls[0].options.shell, false);
    assert.equal(git(env.root, ['rev-parse', 'HEAD']), env.task.sourceSha,
      'Base checkout must not be reset or updated');
  } finally { env.cleanup(); }
});

test('malformed or duplicate roots fail before Git initialization', () => {
  const env = setup();
  try {
    assert.throws(() => createGitWorktreePreparer({
      workspaceRoots: { [REPO]: 'relative/path' },
    }), /invalid_git_workspace_allowlist/);
    assert.throws(() => createGitWorktreePreparer({
      workspaceRoots: { [REPO]: env.root, 'fongap-labs/other': env.root },
    }), /duplicated_git_workspace_root/);
  } finally { env.cleanup(); }
});
