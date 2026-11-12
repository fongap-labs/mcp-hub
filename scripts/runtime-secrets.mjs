#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only the centrally authorized GitHub Actions Secrets reach this deployment.
// Missing optional values are omitted, so existing Cloudflare Secrets survive.
const OPTIONAL = ['MCP_COOKIE_KEY', 'MCP_KEYRING_JSON', 'MCP_INGEST_JWK', 'MCP_RUNTIME_KEY'];

function jsonObject(value, name) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(name + ' must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(name + ' must be a JSON object');
  }
  return parsed;
}

export function selectRuntimeSecrets(env) {
  for (const name of ['MCP_ADMIN_KEY', 'MCP_APPROVAL_KEY']) {
    if (env[name]) throw new Error('Retired runtime Secret must not enter deploy: ' + name);
  }
  const totp = env.MCP_TOTP_SECRET;
  if (typeof totp !== 'string' || !/^[A-Z2-7]{32,}$/.test(totp)) {
    throw new Error('MCP_TOTP_SECRET must be a Base32 Secret of at least 32 characters');
  }
  const secrets = { MCP_TOTP_SECRET: totp };
  for (const name of OPTIONAL) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new Error('Invalid runtime Secret: ' + name);
    secrets[name] = value;
  }
  if (secrets.MCP_COOKIE_KEY && secrets.MCP_COOKIE_KEY.length < 32) {
    throw new Error('MCP_COOKIE_KEY must contain at least 32 characters');
  }
  if (secrets.MCP_RUNTIME_KEY && secrets.MCP_RUNTIME_KEY.length < 32) {
    throw new Error('MCP_RUNTIME_KEY must contain at least 32 characters');
  }
  const syncingKeyring = Boolean(secrets.MCP_KEYRING_JSON);
  const syncingJwk = Boolean(secrets.MCP_INGEST_JWK);
  if (syncingKeyring || syncingJwk) {
    if (!syncingKeyring || !syncingJwk || env.MCP_CRYPTO_SECRET_SYNC !== 'confirmed') {
      throw new Error('Crypto Secret sync requires both original keys and MCP_CRYPTO_SECRET_SYNC=confirmed');
    }
    const ring = jsonObject(secrets.MCP_KEYRING_JSON, 'MCP_KEYRING_JSON');
    if (!env.MCP_ACTIVE_ID || typeof ring[env.MCP_ACTIVE_ID] !== 'string') {
      throw new Error('MCP_KEYRING_JSON does not contain the active key ID');
    }
    const jwk = jsonObject(secrets.MCP_INGEST_JWK, 'MCP_INGEST_JWK');
    if (jwk.kty !== 'RSA' || typeof jwk.d !== 'string' || !jwk.d) {
      throw new Error('MCP_INGEST_JWK must contain the original RSA private JWK');
    }
  }
  return secrets;
}

export function writeRuntimeSecretsFile(filename, env) {
  if (!filename || !filename.startsWith('/')) throw new Error('A trusted absolute temporary path is required');
  const secrets = selectRuntimeSecrets(env);
  writeFileSync(filename, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
  return Object.keys(secrets).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'prepare') throw new Error('Usage: runtime-secrets.mjs prepare <absolute-temp-path>');
    const count = writeRuntimeSecretsFile(process.argv[3], process.env);
    console.log('Prepared ' + count + ' approved runtime Secret binding(s) for the current Worker deployment.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime Secret staging failed');
    process.exitCode = 1;
  }
}
