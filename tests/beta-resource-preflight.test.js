import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBetaResources } from '../scripts/beta-resource-preflight.mjs';

const expected = {
  DEPLOY_ENVIRONMENT: 'mcp-hub-beta',
  DEPLOY_SOURCE_SHA: 'a'.repeat(40),
  MCP_D1_ID: '123e4567-e89b-42d3-a456-426614174000',
  MCP_PUBLIC_URL: 'https://mcp-beta.135468.xyz',
  GMC_WRITE_MODE: 'disabled',
  GMC_CONTENT_MODE: 'disabled',
};

test('Beta plans a separate Worker, D1 and queues, with no Cron or remote mutation', () => {
  const p = planBetaResources(expected);
  assert.equal(p.environment, 'mcp-hub-beta');
  assert.equal(p.worker_name, 'mcp-hub-beta');
  assert.equal(p.database_name, 'mcp-hub-beta');
  assert.equal(p.queue_name, 'mcp-hub-beta-dispatch');
  assert.equal(p.dead_letter_queue_name, 'mcp-hub-beta-dispatch-dlq');
  assert.equal(p.public_url, 'https://mcp-beta.135468.xyz');
  assert.deepEqual(p.cron_schedules, []);
  assert.equal(p.remote_mutations_authorized, false);
  assert.equal(Object.keys(p).some(k => /secret|token|credential/i.test(k)), false);
  for (const name of [p.worker_name, p.database_name, p.queue_name, p.dead_letter_queue_name]) {
    assert.notEqual(name, 'mcp-hub');
    assert.notEqual(name, 'mcp-hub-dispatch');
    assert.notEqual(name, 'mcp-hub-dispatch-dlq');
  }
});

test('Beta resource preflight fails closed for production identities, access and disabled operations', () => {
  for (const bad of [
    { DEPLOY_ENVIRONMENT: 'production' },
    { DEPLOY_ENVIRONMENT: 'mcp-hub-ops' },
    { DEPLOY_SOURCE_SHA: 'main' },
    { MCP_D1_ID: 'mcp-hub' },
    { MCP_PUBLIC_URL: 'https://mcp.135468.xyz' },
    { MCP_PUBLIC_URL: 'https://mcp-beta.135468.xyz/other' },
    { MCP_PUBLIC_URL: 'https://mcp-beta.135468.xyz/?admin=true' },
    { MCP_PUBLIC_URL: 'https://mcp-beta.135468.xyz:8443' },
    { MCP_PUBLIC_URL: 'https://mcp-beta.example.workers.dev' },
    { GMC_WRITE_MODE: 'approval' },
    { GMC_CONTENT_MODE: 'enabled' },
    { MCP_TOTP_SECRET: 'must-not-be-public' },
    { CLOUDFLARE_API_TOKEN_SECONDARY: 'must-not-be-public' },
  ]) {
    assert.throws(() => planBetaResources({ ...expected, ...bad }), JSON.stringify(Object.keys(bad)));
  }
});

test('No beta resource plan is accepted by the existing production-only deploy entrypoint', async () => {
  const { readFileSync } = await import('node:fs');
  const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');
  assert.match(script, /DEPLOY_ENVIRONMENT.*!=.*production/);
  assert.match(script, /Action Worker control plane/);
});
