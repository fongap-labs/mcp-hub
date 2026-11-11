import {GATEWAY_DISCLAIMER} from '../src/i18n/zh-CN.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {BRAND_ICON,BRAND_NAME,BRAND_NOTE,BRAND_SOURCE,BRAND_VERSION} from '../src/brand.ts';
import {processMcp} from '../src/mcp.ts';
import {MCP_SERVERS} from '../src/mcp-registry.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';

const origin='https://test.example';
test('independent mark and administration UI cannot be confused with official GitHub MCP',async()=>{
  assert.equal(BRAND_NAME,'MCP Hub');
  assert.equal(BRAND_SOURCE,'Fongap Labs');
  assert.equal(BRAND_VERSION,'v0.1.0');
  assert.match(BRAND_ICON,/#[2][8]6F78/i);
  assert.doesNotMatch(BRAND_ICON,/octocat|invertocat|fontawesome/i);
  const icon=await worker.fetch(new Request(origin+'/brand/icon.svg'),{});
  assert.equal(icon.status,200);
  assert.match(icon.headers.get('Content-Type'),/image\/svg\+xml/);
  assert.match(await icon.text(),/MCP Hub independent mark/);
  const denied=await worker.fetch(new Request(origin+'/admin'),{});
  assert.equal(denied.status,403,'Admin UI requires a verified Access identity');
  const auth=await accessFixture();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(auth.jwks);
  };
  try {
    const env={MCP_ACCESS_ISSUER:accessIssuer,MCP_ACCESS_AUD:accessAud};
    const login=await worker.fetch(new Request(origin+'/admin',{headers:{'Cf-Access-Jwt-Assertion':auth.assertion}}),env);
    assert.equal(login.status,200);
    const html=await login.text();
    assert.match(html,/MCP Hub/);
    assert.ok(html.includes(GATEWAY_DISCLAIMER));
    assert.match(html,/Fongap Labs/);
    assert.match(html,/v0\.1\.0/);
    assert.match(html,/\/brand\/icon.svg/);
    assert.doesNotMatch(html,/<h1>GitHub MCP/);
    assert.ok(BRAND_NOTE.includes(GATEWAY_DISCLAIMER));
  } finally {globalThis.fetch=originalFetch;}
});

test('MCP initialize identifies an independent gateway, not the official server',async()=>{
  const request=new Request(origin+'/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}})});
  const response=await processMcp(request,{}, {scopes:['mcp:read'],allowedResources:[MCP_SERVERS[0].id],allowedTools:[]},MCP_SERVERS[0]);
  const payload=await response.json();
  assert.equal(payload.result.serverInfo.name,'mcp-hub');
  assert.match(payload.result.serverInfo.title,/Independent/);
  assert.match(payload.result.serverInfo.title,/Fongap Labs/);
  assert.equal(payload.result.serverInfo.version,'0.1.0');
  assert.match(payload.result.instructions,/NOT the official GitHub MCP Server/);
  assert.notEqual(payload.result.serverInfo.name,'github-mcp-server');
});

test('Admin browser script remains served after Access validation', async () => {
  const blocked=await worker.fetch(new Request(origin+'/admin/app.js'),{});
  assert.equal(blocked.status,403);
  const auth=await accessFixture();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(auth.jwks);
  };
  try {
    const response=await worker.fetch(new Request(origin+'/admin/app.js',{headers:{'Cf-Access-Jwt-Assertion':auth.assertion}}),
      {MCP_ACCESS_ISSUER:accessIssuer,MCP_ACCESS_AUD:accessAud});
    assert.equal(response.status,200);
    assert.match(response.headers.get('Content-Type'),/javascript/);
    assert.ok((await response.text()).includes('crypto.subtle'));
  } finally {globalThis.fetch=originalFetch;}
});
