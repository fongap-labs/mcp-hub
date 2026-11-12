# Trusted GitHub PR delivery

The optional delivery service opens a review-only GitHub pull request after a Coding Runtime task completes. It does not merge, deploy, bypass Action Worker governance or grant Claude GitHub credentials.

## Endpoint

POST /runtime/v1/tasks/deliver on the localhost trusted Runtime, with a fresh GitHub USER bearer token and JSON containing exactly one taskRef.

The endpoint is disabled unless the existing Runtime-local MCP_RUNTIME_ACTORS_JSON is configured. The Runner credential cannot authorize delivery.

1. Runtime reads its encrypted SQLite journal. The task must be completed and Hub-acknowledged, have a verified original GitHub numeric actor ID, and its repository must remain on the workspace allowlist.
2. The delivering user re-authenticates through GitHub /user and must match the original actor and explicit allowlist. GitHub must confirm push rights, non-archived state and main as default branch.
3. Runtime verifies canonical GitHub origin, Git common directory, the agent/task-* branch and original source SHA. It collects only unstaged modified/deleted files and new regular UTF-8 text files (maximum 40 files, 256 KiB/file, 1 MiB total).
4. Renames, staged changes, symlinks, binaries, credential files, and changes in GitHub workflow/action directories are rejected; no worktree is reset or deleted.
5. Runtime confirms remote main is unchanged, then uses the GitHub Git Data API to create blobs, a tree, a commit with the original SHA as sole parent, and a NEW refs/heads/agent/task-* ref. It never updates or force-pushes an existing branch.
6. Runtime opens a PR against main and returns review_pending, PR number and URL. Central Action Worker PR Governance controls the subsequent review, CI, merge and release.
7. A deterministic task branch, PR body marker and verified Git commit/tree/parent enable recovery from lost responses. Conflicting branch or PR state fails closed.

## Returned data

The response includes taskRef, status=review_pending, pullRequest, url, replayed. It contains no task prompt, access token, source code or executor result.

## Security and remaining validation

The caller explicitly supplies a fresh GitHub user token per delivery. Repository Contents write and Pull requests write permissions are needed. The token is never stored in Runtime SQLite or sent to Claude, Runner or Hub. Submission stores only the original verified numeric actor ID inside encrypted task JSON; old ownerless tasks cannot be delivered.

Reuse existing MCP_RUNTIME_ACTORS_JSON and MCP_APPROVED_WORKSPACES_JSON; introduce NO Cloudflare/Action Worker secrets or variable renames.

Tests use real local Git worktrees and mocked GitHub Git Data API responses. Live GitHub and Claude end-to-end execution is separate, and a PR in review_pending is NOT a passed gate or production deployment.
