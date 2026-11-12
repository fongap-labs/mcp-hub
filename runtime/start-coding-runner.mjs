import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openSync, closeSync, unlinkSync } from 'node:fs';
import { RunnerDispatchClient } from '../src/control/runner-runtime-client.ts';
import { createRunnerRuntimeTaskPort } from './runner-task-transport.mjs';
import { createRunnerDaemon, createRunnerSequenceStore } from './runner-daemon.mjs';

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error('missing_' + key);
  return value;
}

/**
 * Untrusted side: owns ONLY the Hub Runner credential and a separate
 * Runtime-issued per-Runner token, never the Hub Runtime key, journal key,
 * task body, Coding Engine or authorized GitHub credentials.
 */
export async function startCodingRunner(env = process.env) {
  if (env.MCP_RUNTIME_KEY || env.MCP_RUNTIME_JOURNAL_KEY_BASE64 ||
      env.MCP_CLAUDE_EXECUTABLE) {
    throw new Error('runtime_secrets_must_not_enter_runner');
  }
  const runner = new RunnerDispatchClient(
    required(env, 'MCP_HUB_ORIGIN'), required(env, 'MCP_RUNNER_HUB_TOKEN'));
  const port = createRunnerRuntimeTaskPort({
    origin: required(env, 'MCP_RUNTIME_LOCAL_ORIGIN'),
    runnerRuntimeToken: required(env, 'MCP_RUNNER_RUNTIME_TOKEN'),
  });
  const sequencePath = required(env, 'MCP_RUNNER_SEQUENCE_PATH');
  const sequenceStore = createRunnerSequenceStore(sequencePath);
  // One process per Runner identity. A crash leaves a lock to be inspected
  // manually; automatic stale-lock removal could permit duplicate execution.
  const lockPath = resolve(sequencePath) + '.lock';
  const lockHandle = openSync(lockPath, 'wx', 0o600);
  try {
    const daemon = createRunnerDaemon({
      runner,
      runtimePort: port,
      heartbeatSequence: sequenceStore,
      displayName: env.MCP_RUNNER_NAME || 'Fongap Coding Runner',
      capabilities: ['coding.patch'],
      maxConcurrency: 1,
    });
    const controller = new AbortController();
    const stop = () => { daemon.stop(); controller.abort(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await daemon.run({ signal: controller.signal });
      if (daemon.status.quarantined) throw new Error('runner_quarantined_manual_review_required');
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    closeSync(lockHandle);
    unlinkSync(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startCodingRunner().catch(() => {
    process.stderr.write('Coding Runner halted; inspect Hub lease and trusted Runtime journal before restart.\n');
    process.exitCode = 1;
  });
}
