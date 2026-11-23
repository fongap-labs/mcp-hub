# Agent Guide

## Documentation map

Read docs/README.md for the product documentation map.

## Shared governance

Follow Action Worker shared governance: [shared governance](https://github.com/fongap-labs/action-worker/blob/main/docs/01_SHARED_GOVERNANCE.md), [naming conventions](https://github.com/fongap-labs/action-worker/blob/main/docs/03_NAMING_CONVENTIONS.md), [changelog conventions](https://github.com/fongap-labs/action-worker/blob/main/docs/04_CHANGELOG_CONVENTIONS.md), and [development guide](https://github.com/fongap-labs/action-worker/blob/main/docs/DEVELOPMENT_GUIDE.md).

## Project boundaries

- Runtime modules, OAuth resources, and service contracts are documented in docs/MCP_MODULES.md, docs/RUNNER_PROTOCOL.md, and docs/RUNNER_DISPATCH.md.
- Production deployment follows docs/CENTRAL_DEPLOY.md through Action Worker; preserve the thin bridge and do not create a repository-local deployment workflow.
- Keep credentials out of files and logs. Existing encryption keys must not be regenerated over data; follow the migration and rotation procedure in README.md and the migration guides.
- Run npm run validate for local type and test validation when changing product behavior.

