# Local Coding Runner and Claude Code Engine

This is source-only and explicitly opt-in. It does not deploy the public Cloudflare Worker, provision credentials, or dispatch new tasks.

## Isolated processes

Run two distinct Node processes, each with its own environment:

| Trusted Runtime | Runner |
| --- | --- |
| MCP_RUNTIME_KEY | MCP_RUNNER_HUB_TOKEN |
| MCP_RUNTIME_JOURNAL_KEY_BASE64 | MCP_RUNNER_SEQUENCE_PATH |
| MCP_RUNTIME_DB_PATH | MCP_RUNTIME_LOCAL_ORIGIN |
| MCP_CLAUDE_EXECUTABLE | MCP_RUNNER_NAME (optional) |
| MCP_APPROVED_WORKSPACES_JSON | MCP_HUB_ORIGIN |
| MCP_RUNTIME_LOCAL_PORT | MCP_RUNNER_RUNTIME_TOKEN |
| MCP_RUNNER_ID, MCP_HUB_ORIGIN | No task body or encryption key |
| MCP_RUNNER_RUNTIME_TOKEN (verifier) | No MCP_RUNTIME_KEY or Claude executable |

Both processes use the same independently provisioned MCP_RUNNER_RUNTIME_TOKEN for local HTTP authentication. The Runtime refuses MCP_RUNNER_HUB_TOKEN; Runner refuses MCP_RUNTIME_KEY, MCP_RUNTIME_JOURNAL_KEY_BASE64 and MCP_CLAUDE_EXECUTABLE. The Runner must never have the Runtime's GitHub, encryption or Coding Engine credentials.

## Controlled startup

1. Install Node 22.16+ and an approved Claude Code CLI on an isolated local host. Prepare an allowlisted, non-main Git feature-branch worktree for each fongap-labs repository. Pin each task to the approved 40-hex source SHA.
2. Provision the stable 32-byte base64 journal key and the independent Runtime/Runner credentials via each process's secret manager. Do not commit them to GitHub or invent new production variable names.
3. Set MCP_APPROVED_WORKSPACES_JSON to an explicit object mapping repository names to absolute worktree paths. The Runtime uses the absolute MCP_CLAUDE_EXECUTABLE path; the Runner never sees it.
4. Start the trusted service using node --experimental-strip-types --experimental-sqlite runtime/start-trusted-runtime.mjs. It holds previous claimed or started work as uncertain and reconciles the journal before opening a localhost listener.
5. Start the Runner in a separate process using node --experimental-strip-types --experimental-sqlite runtime/start-coding-runner.mjs. Set MCP_RUNTIME_LOCAL_ORIGIN to the trusted localhost endpoint. The Runner registers, heartbeats, polls, accepts one task at a time, renews its lease, and relays cancellations.
6. Runtime verifies the authenticated Runner ID, Hub lease and task reference before decrypting a task and starting the CLI. Results remain encrypted in the Runtime journal; the Hub receives only status and sequence.
7. If the Runner is quarantined or execution is uncertain, do not auto-retry. Check Hub and the Runtime journal. A crashed Runner leaves a .lock file next to MCP_RUNNER_SEQUENCE_PATH; verify the old process and work state before manually removing the lock.

## Claude CLI security

- Fixed absolute executable and arguments; no task-supplied shell commands, arguments, CLI binary, repository path or workspace.
- Task must provide repository (allowlist), sourceSha (exact current HEAD), and prompt. Branch must be feat/, fix/, chore/, or agent/; main and detached HEAD are rejected.
- Claude CLI uses -p, JSON output, dontAsk, --no-session-persistence, --tools Read,Glob,Grep,Edit,Write, --strict-mcp-config and explicit mcp__* tool denial. No Bash, GitHub write tool or permission bypass.
- Prompt goes through stdin; stderr is discarded and stdout is bounded. Non-zero exit or timeouts leave potentially changed work held as uncertain and never automatically replayed.
- This is NOT an operating-system sandbox. Operators must still isolate the worktree, tool permissions and credentials using OS/container security.

## Remaining integration

The optional [GitHub-verified local task producer](AUTHORIZED_TASK_INTAKE.md) can now create Runtime journal tasks and dispatch them after independent GitHub user and repository checks. These files do not provide public task intake, GitHub actor bypass, repository cloning, PR publishing or a remote service. DSH Delta Code is a Harness plugin, not a standalone execution engine in this release.

Automated tests use simulated Claude child-process and Hub HTTP responses. Validate real Claude Code and GitHub end-to-end execution in an isolated workspace before production release.
