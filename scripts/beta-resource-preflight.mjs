#!/usr/bin/env node
// Offline Beta target declaration. Does not read Tokens, call Cloudflare,
// mutate resources, or authorize a deploy. The production deploy stays untouched.
import { pathToFileURL } from 'node:url';

const betaEnvironment = 'mcp-hub-beta';
const betaWorker = 'mcp-hub-beta';
const betaDatabase = 'mcp-hub-beta';
const betaQueue = 'mcp-hub-beta-dispatch';
const betaDeadLetterQueue = 'mcp-hub-beta-dispatch-dlq';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{40}$/;

export function planBetaResources(vars) {
  if (vars.DEPLOY_ENVIRONMENT !== betaEnvironment) {
    throw new Error('Beta preflight requires the approved mcp-hub-beta environment');
  }
  if (!sha.test(vars.DEPLOY_SOURCE_SHA ?? '')) {
    throw new Error('Beta preflight requires an immutable source SHA');
  }
  if (!uuid.test(vars.MCP_D1_ID ?? '')) {
    throw new Error('Beta preflight requires a dedicated D1 UUID');
  }
  // Configuration is explicitly Beta-only: never let production URL or a
  // Workers.dev preview become the OAuth issuer or public custom domain.
  let url;
  try { url = new URL(vars.MCP_PUBLIC_URL ?? ''); } catch {
    throw new Error('Beta MCP_PUBLIC_URL must be an approved HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'mcp-beta.135468.xyz' ||
      url.pathname !== '/' || url.port || url.search || url.hash ||
      url.username || url.password) {
    throw new Error('Beta MCP_PUBLIC_URL must be the dedicated mcp-beta.135468.xyz origin');
  }
  if ((vars.GMC_WRITE_MODE ?? 'disabled') !== 'disabled' ||
      (vars.GMC_CONTENT_MODE ?? 'disabled') !== 'disabled') {
    throw new Error('Beta must disable privileged write and content operations');
  }
  // Never allow an embedded secret in the public variables bundle.
  for (const name of Object.keys(vars)) {
    if (/^(?:CLOUDFLARE_API_TOKEN|MCP_TOTP_SECRET|MCP_COOKIE_KEY|MCP_KEYRING_JSON|MCP_INGEST_JWK|MCP_RUNTIME_KEY)/.test(name)) {
      throw new Error('Beta public resource plan must not receive Secrets');
    }
  }
  return Object.freeze({
    environment: betaEnvironment,
    source_sha: vars.DEPLOY_SOURCE_SHA,
    worker_name: betaWorker,
    database_name: betaDatabase,
    database_id: vars.MCP_D1_ID,
    queue_name: betaQueue,
    dead_letter_queue_name: betaDeadLetterQueue,
    public_url: url.origin,
    cron_schedules: Object.freeze([]),
    remote_mutations_authorized: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    planBetaResources(process.env);
    console.log('MCP Hub Beta resource identities passed offline isolation checks; deployment remains disabled.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid Beta resource plan');
    process.exitCode = 77;
  }
}
