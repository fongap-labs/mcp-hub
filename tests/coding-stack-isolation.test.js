import test from 'node:test';
import assert from 'node:assert/strict';
import { startCodingRunner } from '../runtime/start-coding-runner.mjs';
import { startTrustedRuntime } from '../runtime/start-trusted-runtime.mjs';

test('Runner startup refuses to inherit Runtime keys or CLI executable', async () => {
  for (const secret of [
    { MCP_RUNTIME_KEY: 'runtime-only' },
    { MCP_RUNTIME_JOURNAL_KEY_BASE64: 'private-journal-key' },
    { MCP_CLAUDE_EXECUTABLE: '/opt/claude/claude' },
  ]) {
    await assert.rejects(startCodingRunner(secret), /runtime_secrets_must_not_enter_runner/);
  }
});

test('trusted Runtime refuses Hub Runner credential', async () => {
  await assert.rejects(startTrustedRuntime({
    MCP_RUNNER_HUB_TOKEN: 'private-runner-token',
  }), /runner_hub_token_must_not_enter_runtime/);
});

test('neither standalone entrypoint launches a process when imported', async () => {
  // Importing these scripts must not trigger a background daemon or access
  // production credentials. Rejected configuration proves no defaults.
  await assert.rejects(startCodingRunner({}), /missing_MCP_HUB_ORIGIN/);
  await assert.rejects(startTrustedRuntime({}), /missing_MCP_RUNNER_ID/);
});
