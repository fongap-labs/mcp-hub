import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RuntimeTaskJournal } from './sqlite-task-journal.mjs';
import { RuntimeDispatchClient, RunnerDispatchClient } from '../src/control/runner-runtime-client.ts';
import { createRunnerRuntimeTaskPort } from './runner-task-transport.mjs';
import { startLoopbackRuntimeTaskService } from './authenticated-task-service.mjs';
import { flushRuntimeReconciliations } from './runtime-task-port.mjs';
import { createRunnerDaemon, createRunnerSequenceStore } from './runner-daemon.mjs';
import { createClaudeCodeExecutor } from './claude-code-executor.mjs';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error('missing_' + name);
  return value;
}

/**
 * Explicit opt-in entrypoint. No secret is generated here, and no deployment
 * or GitHub dispatch occurs. Operators provision credentials out of band.
 */
export async function startLocalCodingStack(env = process.env) {
  const hubOrigin = required(env, 'MCP_HUB_ORIGIN');
  const runnerId = required(env, 'MCP_RUNNER_ID');
  if (!/^runner_[A-Za-z0-9_-]{43}$/.test(runnerId)) throw new Error('invalid_runner_identity');
  const runtimeKey = required(env, 'MCP_RUNTIME_KEY');
  const runnerToken = required(env, 'MCP_RUNNER_HUB_TOKEN');
  const runnerRuntimeToken = required(env, 'MCP_RUNNER_RUNTIME_TOKEN');
  const key = Buffer.from(required(env, 'MCP_RUNTIME_JOURNAL_KEY_BASE64'), 'base64');
  if (key.length !== 32) throw new Error('invalid_runtime_journal_encryption_key');
  let roots;
  try { roots = JSON.parse(required(env, 'MCP_APPROVED_WORKSPACES_JSON')); }
  catch { throw new Error('invalid_approved_workspaces_json'); }
  const journal = new RuntimeTaskJournal({
    databasePath: required(env, 'MCP_RUNTIME_DB_PATH'),
    encryptionKey: key,
  });
  key.fill(0);
  try {
    const runtimeClient = new RuntimeDispatchClient(hubOrigin, runtimeKey);
    const runner = new RunnerDispatchClient(hubOrigin, runnerToken);
    const engine = createClaudeCodeExecutor({
      executablePath: required(env, 'MCP_CLAUDE_EXECUTABLE'),
      workspaceRoots: roots,
    });
    // Crash recovery is resolved *before* allowing any new Runner admission.
    journal.recoverAfterRestart();
    await flushRuntimeReconciliations({ journal, runtimeClient });
    const server = await startLoopbackRuntimeTaskService({
      journal, runtimeClient, executor: engine,
      runnerCredentials: [{ runnerId, token: runnerRuntimeToken }],
    });
    try {
      const origin = 'http://127.0.0.1:' + server.address().port;
      const runtimePort = createRunnerRuntimeTaskPort({ origin, runnerRuntimeToken });
      const daemon = createRunnerDaemon({
        runner, runtimePort, heartbeatSequence: createRunnerSequenceStore(
          required(env, 'MCP_RUNNER_SEQUENCE_PATH')),
        displayName: env.MCP_RUNNER_NAME || 'Fongap Coding Runner',
        capabilities: ['coding.patch','coding.test'], maxConcurrency: 1,
      });
      const controller = new AbortController();
      const abort = () => { daemon.stop(); controller.abort(); };
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      try {
        await daemon.run({ signal: controller.signal });
        if (daemon.status.quarantined) {
          throw new Error('runner_quarantined_recovery_required');
        }
      } finally {
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
      }
    } finally {
      await new Promise((accept, reject) => server.close(e => e ? reject(e) : accept()));
    }
  } finally {
    journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startLocalCodingStack().catch(() => {
    // Fail closed without logging a task body, token or internal exception.
    process.stderr.write('Coding Runner unavailable: verify local configuration and recovery state.\n');
    process.exitCode = 1;
  });
}
