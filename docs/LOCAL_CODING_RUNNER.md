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

1. Install Node 22.16+ and an approved Claude Code CLI on an isolated local host. Configure a trusted absolute base-checkout location for each allowed fongap-labs repository; Runtime now creates a separate agent/task-* Git worktree at execution time, pinned to the approved 40-hex source SHA.
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

The optional [GitHub-verified local task producer](AUTHORIZED_TASK_INTAKE.md) can now create Runtime journal tasks and dispatch them after independent GitHub user and repository checks. These files do not provide public task intake, GitHub actor bypass, PR publishing or a remote service. Runtime can now clone a missing approved public repository from its canonical GitHub HTTPS origin and prepare an isolated feature worktree; private repositories require a separately provisioned checkout with read access. DSH Delta Code is a Harness plugin, not a standalone execution engine in this release.

Automated tests use simulated Claude child-process and Hub HTTP responses. Validate real Claude Code and GitHub end-to-end execution in an isolated workspace before production release.

## Automatic Git worktree preparation

`runtime/git-worktree-preparer.mjs` now runs inside the trusted Runtime immediately before Claude execution. It uses `MCP_APPROVED_WORKSPACES_JSON` as an allowlist of canonical repository names and absolute **base checkout** paths (not per-task worktree paths).

- It inspects the approved base checkout and enforces the exact canonical HTTPS GitHub origin. If missing, it attempts an anonymous, noninteractive clone from the fixed `https://github.com/fongap-labs/<repo>.git` URL only. Private repositories need an operator-provisioned base checkout; no new token sources are introduced.
- It fetches only `main`, checks the fetched tip against the user-authorized `sourceSha`, and fails closed if the source has moved.
- It creates a distinct, deterministic `agent/task-*` branch and sibling worktree under `<base>.worktrees/<task-hash>`. The task cannot choose the origin, branch, target directory, checkout command or worktree name.
- An existing worktree must still be the same Git repository, branch, source commit and **clean** before it is reused. Dirty or mismatched worktrees are never reset, cleaned or overwritten. No worktree is automatically deleted after execution.
- The CLI remains confined to that task-specific worktree. It cannot act on the base checkout by supplying a different cwd.
- Only public anonymous HTTPS clone is automatic. Private source synchronization, tested GitHub credentials, PR creation and central merge gating remain separate code tasks. Git worktrees are not operating-system sandboxes; the local trusted host must still enforce filesystem isolation and permission boundaries.
