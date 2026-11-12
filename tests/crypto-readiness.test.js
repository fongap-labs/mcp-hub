import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from '../src/index.ts';
import { runtimeCryptoReady, verifiedIngestionPublicJwk } from '../src/crypto.ts';
import { verifyDeployment } from '../scripts/deployment-config.mjs';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const sha='a'.repeat(40);

async function runtimeFixture() {
  const pair=await crypto.subtle.generateKey({
    name:'RSA-OAEP', modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256',
  },true,['encrypt','decrypt']);
  const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
  return {
    MCP_DB:{},
    MCP_PUBLIC_URL:'https://mcp.135468.xyz',
    MCP_ACCESS_ISSUER:'https://example.cloudflareaccess.com',
    MCP_ACCESS_AUD:'synthetic-audience',
    MCP_AUTH_MODE:'cloudflare-mfa',
    MCP_COOKIE_KEY:'c'.repeat(48),
    MCP_KEYRING_JSON:JSON.stringify({v1:Buffer.alloc(32,7).toString('base64')}),
    MCP_ACTIVE_ID:'v1',
    MCP_INGEST_JWK:JSON.stringify(privateJwk),
    MCP_BUILD_SHA:sha,
  };
}

async function health(env) {
  const response=await worker.fetch(new Request('https://mcp.135468.xyz/health'),env);
  const body=await response.json();
  assert.equal(body.build,sha);
  assert.equal(typeof body.ready,'boolean');
  assert.equal(JSON.stringify(body).includes('MCP_INGEST_JWK'),false);
  assert.equal(JSON.stringify(body).includes('privateJwk'),false);
  return {status:response.status,body};
}

test('valid original RSA private key and active AES keyring allow deploy readiness',async()=>{
  const env=await runtimeFixture();
  assert.equal(await runtimeCryptoReady(env),true);
  const pub=await verifiedIngestionPublicJwk(env);
  assert.equal(pub.kty,'RSA');
  assert.ok(pub.n && pub.e);
  assert.equal('d' in pub,false);
  const ready=await health(env);
  assert.equal(ready.status,200);
  assert.deepEqual([ready.body.status,ready.body.ready],['ok',true]);
});

test('invalid or absent RSA ingestion private key fails closed instead of green health',async()=>{
  const env=await runtimeFixture();
  const invalidCases=[
    undefined,
    '',
    '{not json',
    '{}',
    JSON.stringify({kty:'RSA',n:'abc',e:'AQAB'}),
    JSON.stringify({kty:'RSA',n:'abc',e:'AQAB',d:'bad-private-key'}),
  ];
  for(const key of invalidCases) {
    const candidate={...env,MCP_INGEST_JWK:key};
    assert.equal(await runtimeCryptoReady(candidate),false,String(key));
    const outcome=await health(candidate);
    assert.equal(outcome.status,503);
    assert.deepEqual([outcome.body.status,outcome.body.ready],['unavailable',false]);
  }
});

test('missing, malformed, wrong-size and wrong active-ID keyrings fail readiness',async()=>{
  const env=await runtimeFixture();
  const invalidCases=[
    {MCP_KEYRING_JSON:undefined},
    {MCP_KEYRING_JSON:'{not json'},
    {MCP_KEYRING_JSON:'{}'},
    {MCP_ACTIVE_ID:'v2'},
    {MCP_KEYRING_JSON:JSON.stringify({v1:Buffer.alloc(12).toString('base64')})},
    {MCP_ACTIVE_ID:'invalid/active/id'},
  ];
  for(const change of invalidCases) {
    const candidate={...env,...change};
    assert.equal(await runtimeCryptoReady(candidate),false,JSON.stringify(change));
    assert.equal((await health(candidate)).status,503);
  }
});

test('central deploy acceptance must reject real Worker with unusable RSA key',async()=>{
  const env=await runtimeFixture();
  env.MCP_INGEST_JWK='invalid';
  let count=0;
  await assert.rejects(()=>verifyDeployment('https://mcp.135468.xyz',sha,async url=>{
    count++;
    return worker.fetch(new Request(url),env);
  }),/Worker \/health is not ready \(HTTP 503\)/);
  assert.equal(count,1,'Do not advance to OAuth checks when encryption is broken');
});
