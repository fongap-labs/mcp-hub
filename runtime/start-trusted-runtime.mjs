import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { RuntimeTaskJournal } from './sqlite-task-journal.mjs';
import { RuntimeDispatchClient } from '../src/control/runner-runtime-client.ts';
import { startLoopbackRuntimeTaskService } from './authenticated-task-service.mjs';
import { flushRuntimeReconciliations } from './runtime-task-port.mjs';
import { createClaudeCodeExecutor } from './claude-code-executor.mjs';
import { createAuthorizedTaskProducer } from './authorized-task-producer.mjs';

function requireConfig(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error('missing_' + key);
  return value;
}

/** Node-only trusted side: contains Hub Runtime key and encrypted task store. */
export async function startTrustedRuntime(env = process.env) {
  if (env.MCP_RUNNER_HUB_TOKEN) throw new Error('runner_hub_token_must_not_enter_runtime');
  const runnerId = requireConfig(env, 'MCP_RUNNER_ID');
  if (!/^runner_[A-Za-z0-9_-]{43}$/.test(runnerId)) throw new TypeError('invalid_runner_id');
  const localPort = Number(requireConfig(env, 'MCP_RUNTIME_LOCAL_PORT'));
  if (!Number.isSafeInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new TypeError('invalid_runtime_port');
  }
  const key = Buffer.from(requireConfig(env, 'MCP_RUNTIME_JOURNAL_KEY_BASE64'), 'base64');
  if (key.length !== 32) throw new TypeError('invalid_runtime_encryption_key');
  let workspaceRoots;
  try { workspaceRoots = JSON.parse(requireConfig(env, 'MCP_APPROVED_WORKSPACES_JSON')); }
  catch { throw new TypeError('invalid_approved_workspaces'); }
  const journal = new RuntimeTaskJournal({
    databasePath: requireConfig(env, 'MCP_RUNTIME_DB_PATH'),
    encryptionKey: key,
  });
  key.fill(0);
  try {
    const runtimeClient = new RuntimeDispatchClient(
      requireConfig(env, 'MCP_HUB_ORIGIN'), requireConfig(env, 'MCP_RUNTIME_KEY'));
    const executor = createClaudeCodeExecutor({
      executablePath: requireConfig(env, 'MCP_CLAUDE_EXECUTABLE'),
      workspaceRoots,
    });
    // No new tasks until the previous process's incomplete work is safely held.
    journal.recoverAfterRestart();
    await flushRuntimeReconciliations({ journal, runtimeClient });
    // Local task admission is OFF unless the operator explicitly authorizes GitHub actors.
    let taskProducer = null;
    if (env.MCP_RUNTIME_ACTORS_JSON) {
      let allowedActors;
      try { allowedActors = JSON.parse(env.MCP_RUNTIME_ACTORS_JSON); }
      catch { throw new TypeError('invalid_runtime_actor_allowlist'); }
      taskProducer = createAuthorizedTaskProducer({
        journal, runtimeClient, allowedActors,
        allowedRepositories: Object.keys(workspaceRoots),
      });
    }
    const server = await startLoopbackRuntimeTaskService({
      journal, runtimeClient, executor, taskProducer,
      runnerCredentials: [{
        runnerId, token: requireConfig(env, 'MCP_RUNNER_RUNTIME_TOKEN'),
      }],
    }, localPort);
    try {
      await new Promise(resolveDone => {
        const terminate = () => {
          process.removeListener('SIGINT', terminate);
          process.removeListener('SIGTERM', terminate);
          resolveDone();
        };
        process.once('SIGINT', terminate);
        process.once('SIGTERM', terminate);
      });
    } finally {
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    }
  } finally {
    journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startTrustedRuntime().catch(() => {
    process.stderr.write('Trusted Coding Runtime unavailable; review configuration and recovery state.\n');
    process.exitCode = 1;
  });
}
