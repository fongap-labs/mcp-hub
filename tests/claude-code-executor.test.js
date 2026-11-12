import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeExecutor } from '../runtime/claude-code-executor.mjs';

const repo = 'fongap-labs/example';
const sha = 'b'.repeat(40);
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'fongap-coding-cli-'));
  return { root, clean() { rmSync(root, { recursive: true, force: true }); } };
}
function task(overrides = {}) {
  return { repository: repo, prompt: 'Fix the exact failing unit test.', sourceSha: sha, ...overrides };
}
function fakeSpawn({ exitCode = 0, response = { is_error: false, result: 'Two files updated.' } } = {}) {
  const calls = [];
  function spawnProcess(exe, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { calls.at(-1).killed = true; return true; };
    const call = { exe, args, options, input: '', killed: false };
    calls.push(call);
    child.stdin.on('data', data => { call.input += data.toString('utf8'); });
    child.stdin.on('finish', () => {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify(response));
        child.stdout.end();
        child.emit('close', exitCode);
      });
    });
    return child;
  }
  return { calls, spawnProcess };
}

test('Claude CLI runs as pinned feature branch with fixed restricted tool arguments and prompt on stdin', async () => {
  const root = workspace();
  const fake = fakeSpawn();
  const inspections = [];
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'SHOULD_NOT_LEAK';
  try {
    const executor = createClaudeCodeExecutor({
      executablePath: '/opt/claude/claude',
      workspaceRoots: { [repo]: root.root },
      spawnProcess: fake.spawnProcess,
      inspectGit(cwd, args) {
        inspections.push({ cwd, args });
        return args[0] === 'symbolic-ref' ? 'feat/test-coding-agent' : sha;
      },
    });
    const result = await executor.execute(task(), { signal: new AbortController().signal });
    assert.deepEqual(result, { engine: 'claude-code', summary: 'Two files updated.' });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.exe, '/opt/claude/claude');
    assert.equal(call.options.cwd, root.root);
    assert.equal(call.options.shell, false);
    assert.equal(call.input, task().prompt);
    assert.ok(call.args.includes('dontAsk'));
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.ok(call.args.includes('--no-session-persistence'));
    assert.ok(call.args.includes('--tools'));
    assert.ok(call.args.includes('Read,Glob,Grep,Edit,Write'));
    assert.ok(!call.args.some(x => /dangerously-skip-permissions|bypassPermissions|Bash|GitHub/.test(x)));
    assert.ok(!call.args.includes(task().prompt), 'task content is never a process argument');
    assert.equal(call.options.env.GITHUB_TOKEN, undefined);
    assert.deepEqual(inspections.map(x => x.args[0]), ['symbolic-ref','rev-parse']);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
    root.clean();
  }
});

test('source SHA or branch drift fails before launching any coding engine', async () => {
  const root = workspace(), fake = fakeSpawn();
  try {
    const factory = state => createClaudeCodeExecutor({
      executablePath: '/opt/claude/claude',
      workspaceRoots: { [repo]: root.root },
      spawnProcess: fake.spawnProcess,
      inspectGit(_root, args) { return args[0] === 'symbolic-ref' ? state.branch : state.sha; },
    });
    await assert.rejects(factory({ branch: 'main', sha }).execute(task()), /approved_feature_branch_required/);
    await assert.rejects(factory({ branch: 'feat/test', sha: 'a'.repeat(40) }).execute(task()),
      /workspace_source_sha_mismatch/);
    await assert.rejects(factory({ branch: 'feat/test', sha }).execute(task({ repository: 'evil/other' })),
      /unapproved_coding_task/);
    await assert.rejects(factory({ branch: 'feat/test', sha }).execute(task({ prompt: 'x' })),
      /unapproved_coding_task/);
    assert.equal(fake.calls.length, 0);
  } finally { root.clean(); }
});

test('executor reports generic errors, not stderr or raw secrets', async () => {
  const root = workspace();
  try {
    const fake = fakeSpawn({ exitCode: 2, response: { detail: 'private provider secret' } });
    const executor = createClaudeCodeExecutor({
      executablePath: '/opt/claude/claude', workspaceRoots: { [repo]: root.root },
      spawnProcess: fake.spawnProcess,
      inspectGit(_root, args) { return args[0] === 'symbolic-ref' ? 'fix/test' : sha; },
    });
    await assert.rejects(executor.execute(task()), err => {
      assert.equal(err.message, 'coding_engine_failed');
      assert.ok(!err.message.includes('secret'));
      return true;
    });
  } finally { root.clean(); }
});

test('execution never starts when cancelled or executable path is unsafe', async () => {
  const root = workspace(), fake = fakeSpawn();
  try {
    assert.throws(() => createClaudeCodeExecutor({
      executablePath: 'claude', workspaceRoots: { [repo]: root.root },
    }), /absolute_claude_executable_required/);
    const executor = createClaudeCodeExecutor({
      executablePath: '/opt/claude/claude', workspaceRoots: { [repo]: root.root },
      spawnProcess: fake.spawnProcess,
      inspectGit(_root, args) { return args[0] === 'symbolic-ref' ? 'agent/safe' : sha; },
    });
    const signal = AbortSignal.abort();
    await assert.rejects(executor.execute(task(), { signal }), /coding_execution_aborted/);
    assert.equal(fake.calls.length, 0);
  } finally { root.clean(); }
});
