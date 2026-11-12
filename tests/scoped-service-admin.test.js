import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.ts';
import {moduleForAdminPath} from '../src/gateway/registry.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://mcp.example';
function makeDb(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of [
    '0001_init.sql','0002_refresh_token_rotation.sql',
    '0003_resource_tool_policy.sql','0003_runner_registry_leases.sql',
    '0004_runner_dispatch.sql','0005_admin_totp.sql'
  ])sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={prepare(sql){
    return {
      bind(...args){return {
        async first(){return sqlite.prepare(sql).get(...args)||null;},
        async all(){return {results:sqlite.prepare(sql).all(...args)};},
        async run(){return sqlite.prepare(sql).run(...args);}
      };},
      async first(){return sqlite.prepare(sql).get()||null;},
      async all(){return {results:sqlite.prepare(sql).all()};},
      async run(){return sqlite.prepare(sql).run();}
    };
  }};
  return {sqlite,db};
}

test('service admin paths resolve only registered modules, not arbitrary path segments',()=>{
  assert.equal(moduleForAdminPath('/admin/github')?.id,'github');
  assert.equal(moduleForAdminPath('/admin/github/')?.id,'github');
  for(const path of [
    '/unknown/admin','/admin','/github','/github/admin','/github/admin/',
    '/admin/unknown','/admin/github/api/status','/admin/github/other',
    '/admin%2Fgithub','/admin/githubister','/x/../admin/github'
  ])assert.equal(moduleForAdminPath(path),undefined,path);
});

test('Hub admin and GitHub admin expose separate views without weakening Access or OAuth resources',async()=>{
  const {sqlite,db}=makeDb();
  const fixture=await accessFixture();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(String(url),accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(fixture.jwks);
  };
  const env={MCP_DB:db,MCP_PUBLIC_URL:origin,MCP_ACCESS_ISSUER:accessIssuer,
    MCP_ACCESS_AUD:accessAud,MCP_AUTH_MODE:'cloudflare-mfa',MCP_COOKIE_KEY:'k'.repeat(48)};
  const authed=path=>new Request(origin+path,{headers:{
    'Cf-Access-Jwt-Assertion':fixture.assertion,'Accept':'text/html'
  }});
  try {
    const denied=await worker.fetch(new Request(origin+'/admin/github',{headers:{Accept:'text/html'}}),env);
    assert.equal(denied.status,403);
    assert.match(await denied.text(),/Cloudflare Access/);

    const hub=await worker.fetch(authed('/admin'),env);
    assert.equal(hub.status,200,await hub.clone().text());
    const hubHtml=await hub.text();
    assert.ok(hubHtml.includes('Hub 管理中心'));
    assert.match(hubHtml,/href="\/admin\/github"/);
    assert.ok(hubHtml.includes('授权 MCP 客户端'));
    assert.doesNotMatch(hubHtml,/id="add"/,'service credentials are not part of the global Hub dashboard');
    assert.ok(!hubHtml.includes('非 GitHub 官方 MCP Server'),'service disclaimer stays inside its module');

    const github=await worker.fetch(authed('/admin/github'),env);
    assert.equal(github.status,200,await github.clone().text());
    const githubHtml=await github.text();
    assert.ok(githubHtml.includes('GitHub 服务管理'));
    const sessionCookie=github.headers.get('Set-Cookie')?.split(';')[0];
    assert.match(sessionCookie,/^__Host-gmcp-admin=/);
    const publicKey=()=>worker.fetch(new Request(origin+'/admin/api/public-key',{
      headers:{'Cf-Access-Jwt-Assertion':fixture.assertion,Cookie:sessionCookie}
    }),env);
    assert.equal((await worker.fetch(authed('/admin/api/public-key'),env)).status,401,
      'Cloudflare identity alone must not bypass the Hub admin session');
    const missing=await publicKey();
    assert.equal(missing.status,503);
    assert.deepEqual(await missing.json(),{error:'ingestion_public_key_unavailable'});
    assert.equal(missing.headers.get('Cache-Control'),'no-store');
    env.MCP_INGEST_JWK=JSON.stringify({kty:'RSA',n:'invalid',e:'AQAB',d:'invalid'});
    assert.equal((await publicKey()).status,503,'Invalid private key must fail closed');
    const pair=await crypto.subtle.generateKey({
      name:'RSA-OAEP',modulusLength:2048,
      publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'
    },true,['encrypt','decrypt']);
    env.MCP_INGEST_JWK=JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey));
    const available=await publicKey();
    assert.equal(available.status,200);
    assert.equal(available.headers.get('Cache-Control'),'no-store');
    const jwk=await available.json();
    assert.equal(jwk.kty,'RSA');
    assert.ok(jwk.n&&jwk.e);
    assert.equal('d' in jwk,false,'The private exponent must never leave Runtime');

    assert.match(githubHtml,/GitHub Token/);
    assert.match(githubHtml,/id="add"/);
    assert.ok(githubHtml.includes('非 GitHub 官方 MCP Server'));
    assert.match(githubHtml,/href="\/admin"/);
    assert.doesNotMatch(githubHtml,/id="runner-add"/);
    assert.doesNotMatch(githubHtml,/id="rekey"/);

    assert.equal((await worker.fetch(authed('/admin/github/'),env)).status,200);
    // No compatibility route or redirect for the retired address.
    for(const oldPath of ['/github/admin','/github/admin/']){
      const old=await worker.fetch(authed(oldPath),env);
      assert.equal(old.status,404,oldPath);
      assert.equal(old.headers.get('Location'),null);
    }
    // The new nested path uses exactly the Hub's existing Access gate.
    const deniedNested=await worker.fetch(new Request(origin+'/admin/github',{
      headers:{Accept:'text/html'}
    }),env);
    assert.equal(deniedNested.status,403);
    assert.equal((await worker.fetch(authed('/unknown/admin'),env)).status,404);
    assert.equal((await worker.fetch(authed('/admin/github/api/delete'),env)).status,404);
    assert.equal((await worker.fetch(authed('/github'),env)).status,401,
      'The existing GitHub MCP resource remains a separate OAuth-protected endpoint');
    const js=await worker.fetch(authed('/admin/app.js'),env);
    assert.equal(js.status,200);
    assert.match(await js.text(),/getElementById\('add'\)\?\.addEventListener/);
  }finally{
    globalThis.fetch=originalFetch;
    sqlite.close();
  }
});
