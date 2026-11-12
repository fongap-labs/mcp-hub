#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
: "${RUNNER_TEMP:?Action Worker deploy runner is required}"
: "${DEPLOY_SOURCE_SHA:?Missing immutable source SHA}"
: "${DEPLOY_ENVIRONMENT:?Missing approved deployment environment}"

# Central Action Worker is the sole deployment authority. It verifies the
# immutable source SHA, CI Evidence, Main Write Guard and environment policy.
if [[ "${GITHUB_REPOSITORY:-}" != "fongap-labs/action-worker" || "${DEPLOY_SOURCE_REPOSITORY:-}" != "fongap-labs/mcp-hub" ]]; then
  echo '::error::Deployments must be executed by the Action Worker control plane for MCP Hub.' >&2
  exit 77
fi
if [[ ! "$DEPLOY_SOURCE_SHA" =~ ^[0-9a-f]{40}$ || "$DEPLOY_ENVIRONMENT" != "production" ]]; then
  echo '::error::Deployment requires immutable source SHA and approved production environment.' >&2
  exit 65
fi
if [[ -z "${CLOUDFLARE_API_TOKEN_SECONDARY:-}" ]]; then
  echo '::error::Required Cloudflare deployment credential is unavailable.' >&2
  exit 77
fi
# The retired authentication Secrets are never legitimate deployment inputs.
# Active Worker Secrets are passed only through the central scoped Secret plan.
for name in MCP_ADMIN_KEY MCP_APPROVAL_KEY; do
  if [[ -n "${!name:-}" ]]; then
    echo "::error::Worker runtime Secret must not be passed to deployment: $name." >&2
    exit 77
  fi
done
# Keep deployment credentials and inherited runtime credentials out of tests.
safe_env=(env)
for name in CLOUDFLARE_API_TOKEN_SECONDARY MCP_ADMIN_KEY MCP_APPROVAL_KEY MCP_TOTP_SECRET MCP_COOKIE_KEY MCP_KEYRING_JSON MCP_INGEST_JWK MCP_RUNTIME_KEY; do
  safe_env+=("-u" "$name")
done
"${safe_env[@]}" npm install --ignore-scripts --no-audit --no-fund
"${safe_env[@]}" npm run validate

work="$(mktemp -d "${RUNNER_TEMP}/mcp-hub-deploy.XXXXXX")"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
config="$work/wrangler.jsonc"
secrets="$work/runtime-secrets.json"

if [[ ! -f node_modules/wrangler/bin/wrangler.js ]]; then
  echo '::error::Dependencies must be installed and validated before the Cloudflare deploy step.' >&2
  exit 77
fi
node scripts/deployment-config.mjs preflight
node scripts/deployment-config.mjs prepare "$config"

wrangler() { node scripts/with-secondary-cloudflare.mjs "$@"; }
wrangler deploy --dry-run --outdir "$work/build" --config "$config"
# Fail before touching D1 if the GitHub-managed TOTP or optional key material is missing/invalid.
node scripts/runtime-secrets.mjs prepare "$secrets"
# D1 migrations are additive and NOT reverted by a Worker rollback.
wrangler d1 migrations apply mcp-hub --remote --config "$config"
wrangler deploy --secrets-file "$secrets" --config "$config"

healthy=false
for attempt in 1 2 3; do
  if node scripts/deployment-config.mjs health-check; then
    healthy=true
    break
  fi
  if [ "$attempt" -lt 3 ]; then sleep 5; fi
done
if [ "$healthy" != true ]; then
  echo 'Worker verification failed; attempting code-only rollback (D1 is not rolled back).' >&2
  if ! wrangler rollback --yes --config "$config"; then
    echo 'Automatic Worker rollback failed or no prior version exists; manual recovery required.' >&2
  fi
  exit 1
fi

echo "MCP Hub deployment passed checks for commit $DEPLOY_SOURCE_SHA"
