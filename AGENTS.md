# AGENTS

## Common rules

- Inspect the requested branch, source SHA, relevant code and existing contracts before editing. Do not read unrelated trees or expand the task.
- Reuse existing implementations; fix the root cause. Delete obsolete code. No speculative features, duplicate abstractions, unnecessary dependencies, fallback stacking or new workflows.
- Own boolean variables and parameters must use is/has/can/should: `enabled` -> `isEnabled`, `retry` -> `shouldRetry`; Python/Rust: `is_enabled`. Preserve external protocol names.
- Use precise language-native identifiers. Governed file names: `helper.ts` -> `validate-token-format.ts`. Own external configuration: `AW_TOKEN` -> `AW_STATUS_TOKEN`. Use three semantic segments; preserve standard platform names.
- Comments: add or retain only if omission would cause a concrete foreseeable error. Delete optional explanations, code narration, decorative separators and commented-out code. Preserve required legal notices, machine directives and external contracts.
- Tests: verify necessary observable behavior, security and regressions. Extend existing coverage before adding tests. Delete redundant or retired tests; never weaken useful coverage. Externalizable tests belong in the central test packs; local tests require an existing approved exception.
- Update existing authoritative documentation; no duplicate guides, task summaries or speculative plans.
- Commit and PR titles: only feat/fix/chore, in English (e.g. `fix(auth): reject invalid token`). Every commit requires a blank line and a substantive Chinese body explaining why and what changed. No AI attribution.
- Update only the Unreleased section of CHANGELOG.md with matching Chinese entries (feat=addition, fix=correction, chore=maintenance); do not rewrite released history.
- Verify live branch existence before edits. When main and enabled dev coexist, all changes start from dev and target dev by PR; main accepts only maintainer-authorized dev-to-main PR transfers. Never create a parallel main fix. With main only, target main by PR. If branch facts are uncertain or dev is unavailable/disabled despite existing, stop; never fall back. No direct protected-branch writes or unauthorized transfers or history rewrites.
- No secrets in code, logs or untrusted execution. No bypass of security, CI, merge or release gates. Never change tests merely to obtain green status.
- Run the applicable central preflight before submission; fix introduced failures. Verify the final diff and actual outcomes. Report unverified checks and blockers; never claim success without fresh evidence.

## Branch rules

- Dev is disabled; use main PRs only when dev is absent. If dev exists, stop for maintainer resolution; do not initialize, target, publish or deploy from dev.

## Repository rules

- Preserve MCP modules, OAuth resources and Runner service contracts in docs/MCP_MODULES.md, docs/RUNNER_PROTOCOL.md and docs/RUNNER_DISPATCH.md.
- Deploy production only through Action Worker; preserve the thin bridge defined in docs/CENTRAL_DEPLOY.md. No repository-local deployment workflow.
- Keep credentials out of files and logs; never regenerate existing encryption keys over stored data. Follow the documented migration and rotation procedure.
- Run npm run validate for product behavior changes.
