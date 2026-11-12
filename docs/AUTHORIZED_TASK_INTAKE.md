# GitHub-verified local Runtime task intake

This opt-in admission endpoint belongs ONLY to the trusted Node Runtime. It does not add a public MCP tool, Cloudflare Worker route or an Action Worker private Agent bypass.

## Admission

POST /runtime/v1/tasks/submit on the existing localhost trusted Runtime. The caller sends a GitHub-issued user token in the Authorization Bearer header and exactly four JSON fields: requestId, repository, sourceSha, prompt.

- GitHub GET /user must return the exact operator-approved numeric user ID and login. Caller-supplied actor identities are forbidden.
- GitHub GET /repos/OWNER/REPO must confirm repository identity, non-archived main default branch, and permissions.push=true for the same token.
- GitHub GET /repos/OWNER/REPO/commits/main must return the exact approved sourceSha.
- Repository must be in the already configured workspace allowlist. Runtime derives taskRef and resourceKey, and fixes capabilities to coding.patch.
- No task body, token, source files or executable credentials ever go to Hub or Runner.

## Optional local configuration

MCP_RUNTIME_ACTORS_JSON is an optional Runtime-only array of approved GitHub actors (numeric id and login), for example:

~~~json
[{"id":1001,"login":"authorized-dev"}]
~~~

When this variable is absent the endpoint is disabled (404); when present but empty/invalid the trusted Runtime refuses startup. This is a new LOCAL runtime setting only. It does not rename Cloudflare or Action Worker deployment variables and does not grant fongap-bot privileges.

Use a suitable GitHub user token directly against the local Runtime. It is used only to verify live user identity, repository permission and the current main SHA. It is not retained by Runtime or forwarded to Claude Code/Hub/Runner.

## Durable retry and response

1. Authenticated task is saved encrypted in Runtime SQLite with a deterministic actor+requestId reference.
2. Runtime invokes Hub with a stable idempotency key and metadata-only coding.patch dispatch.
3. Runtime attaches dispatchId after Hub acknowledgement and returns taskRef/dispatchId/status/replayed only.
4. A lost Hub response leaves a prepared task. Resubmit the SAME requestId and identical contents: the journal verifies the original digest and Hub deduplicates dispatch.
5. Reusing a requestId with changed contents, a moved main SHA, denied repository or unapproved user fails closed.
6. No automatic retry loop is added and no task is executed during submission.

The real local HTTP and SQLite regression tests are in tests/authorized-task-intake.test.js. Live GitHub token, Claude Code and GitHub PR E2E acceptance remain separate work.

Preparing Git worktrees and delivering a PR through Action Worker's existing identity and CI gate are later coding tasks; this local intake never bypasses them.


A completed and Hub-acknowledged task may be delivered by its original verified GitHub user through [Trusted GitHub PR delivery](GITHUB_PR_DELIVERY.md). The submission token is not persisted, and this does not bypass central governance.
