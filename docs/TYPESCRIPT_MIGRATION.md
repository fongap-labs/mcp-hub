# TypeScript Migration

This change converts the Cloudflare Worker runtime modules from JavaScript to strict TypeScript while preserving public HTTP paths, MCP tool identifiers, OAuth grant fields, and D1 migrations.

- Worker entrypoint: `src/index.ts` (Wrangler builds the TypeScript worker directly).
- Browser-served `/admin/app.js` remains JavaScript emitted from a template literal, preserving existing browser behavior.
- Developer scripts remain Node.js `.mjs` and the existing tests remain `.js`, running with the central Node.js 26.13.1 runtime for imported TypeScript modules.
- `src/types.ts` defines the Worker environment, D1 API surface, OAuth and MCP auth contracts without `any`.
- `npm run typecheck` runs `tsc --noEmit` with strict and `noUncheckedIndexedAccess`.
- `npm run validate` runs type checking and all Node integration/security tests.
- No schema migration, token re-encryption, token rotation, or client reauthorization is required solely for the language migration.
- Do not deploy until the central Action Worker `CI Evidence`, `PR Governance` and `validate-merge` pass.

The TypeScript declarations do not replace runtime input validation or server-side access control.
