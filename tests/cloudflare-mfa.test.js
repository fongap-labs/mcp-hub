import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.ts';
import {getSession} from '../src/admin.ts';
import {cloudflareMfaOnly} from '../src/auth-mode.ts';
import {sha} from '../src/util.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const origin='https://mcp.example';

function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const filename of [
    '0001_init.sql','0002_refresh_token_rotation.sql',
    '0003_resource_tool_policy.sql','0003_runner_registry_leases.sql','0005_admin_totp.sql'
  ])sqlite.exec(readFileSync(new URL('../migrations/'+filename,import.meta.url),'utf8'));
  const db={prepare(query){return{
    bind(...args){return{
      first:async()=>sqlite.prepare(query).get(...args)||null,
      all:async()=>({results:sqlite.prepare(query).all(...args)}),
      run:async()=>sqlite.prepare(query).run(...args)
    }},
    first:async()=>sqlite.prepare(query).get()||null,
    all:async()=>({results:sqlite.prepare(query).all()}),
    run:async()=>sqlite.prepare(query).run()
  }}};
  return {sqlite,db};
}

test('Cloudflare MFA mode requires an explicit setting and rejects invalid modes',()=>{
  assert.equal(cloudflareMfaOnly({}),false);
  assert.equal(cloudflareMfaOnly({MCP_AUTH_MODE:'access-totp'}),false);
  assert.equal(cloudflareMfaOnly({MCP_AUTH_MODE:'cloudflare-mfa'}),true);
  assert.throws(()=>cloudflareMfaOnly({MCP_AUTH_MODE:'unsafe'}),/Invalid MCP_AUTH_MODE/);
});

test('Access MFA mode enters Admin without another OTP while retaining session/CSRF and OAuth consent',async()=>{
  const {sqlite,db}=database();
  const auth=await accessFixture();
  const env={
    MCP_DB:db,MCP_PUBLIC_URL:origin,MCP_ACCESS_ISSUER:accessIssuer,
    MCP_ACCESS_AUD:accessAud,MCP_AUTH_MODE:'cloudflare-mfa',
    MCP_COOKIE_KEY:'C'.repeat(48),MCP_OAUTH_TTL:'900',
    GMC_WRITE_MODE:'disabled',GMC_CONTENT_MODE:'disabled'
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(new URL(url).origin,accessIssuer);
    return Response.json(auth.jwks);
  };
  const headers={'Cf-Access-Jwt-Assertion':auth.assertion};
  const authRequest=(path,method='GET',body=null,extra={})=>
    new Request(origin+path,{method,headers:{...headers,...extra},body});
  try{
    assert.equal((await worker.fetch(new Request(origin+'/admin'),env)).status,403);
    assert.equal((await worker.fetch(new Request(origin+'/authorize'),env)).status,403);
    const initial=await worker.fetch(authRequest('/admin'),env);
    assert.equal(initial.status,200);
    const page=await initial.text();
    assert.match(page,/MCP Hub/);
    assert.doesNotMatch(page,/name="totp_code"/);
    const cookie=initial.headers.get('Set-Cookie')?.split(';')[0];
    assert.match(cookie,/^__Host-gmcp-admin=/);
    assert.match(initial.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Strict/);
    const session=await getSession(authRequest('/admin','GET',null,{Cookie:cookie}),env);
    assert.ok(session?.csrf);
    assert.equal(await getSession(new Request(origin+'/admin',{headers:{Cookie:cookie}}),env),null);
    assert.equal((await worker.fetch(authRequest('/admin/login','POST','totp_code=123456',{
      Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie
    }),env)).status,405);
    const noCsrf=await worker.fetch(authRequest('/admin/api/status','POST',
      JSON.stringify({owner:'acme',enabled:true}),{
      Origin:origin,Cookie:cookie,'Content-Type':'application/json'
    }),env);
    assert.equal(noCsrf.status,403);

    const register=await worker.fetch(new Request(origin+'/oauth/register',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client_name:'Test MFA client',
        redirect_uris:['http://127.0.0.1:9876/callback']})
    }),env);
    assert.equal(register.status,201);
    const {client_id}=await register.json();
    // This test exercises consent and CSRF, not token encryption. An enabled
    // synthetic owner satisfies the independent administrator policy gate.
    const ts=Math.floor(Date.now()/1000);
    sqlite.prepare('INSERT INTO github_connections(owner,owner_kind,key_id,iv,ciphertext,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)')
      .run('acme','Organization','v1','synthetic-iv','synthetic-ciphertext',ts,ts);
    const approval=await worker.fetch(authRequest('/admin/api/client-approval','POST',
      JSON.stringify({clientId:client_id,approved:true,allowedOwners:['acme'],
        allowedResources:['default','github'],allowedTools:[
          'github:github_available_owners','github:github_get_repository'
        ],
        allowWrite:false}),{
        Origin:origin,Cookie:cookie,'Content-Type':'application/json',
        'X-CSRF-Token':session.csrf
      }),env);
    assert.equal(approval.status,200,await approval.clone().text());
    {
      const verifier='v'.repeat(48);
      const query=new URLSearchParams({response_type:'code',client_id,
        redirect_uri:'http://127.0.0.1:9876/callback',resource:origin,scope:'mcp:read',
        code_challenge:await sha(verifier),code_challenge_method:'S256',state:'mfa_state'});
      const consent=await worker.fetch(authRequest('/authorize?'+query),env);
      assert.equal(consent.status,200);
      const consentPage=await consent.text();
      assert.doesNotMatch(consentPage,/name="totp_code"/);
      assert.match(consentPage,/Cloudflare Access/);
      const id=consentPage.match(/name="request_id" value="([A-Za-z0-9_-]+)"/)?.[1];
      assert.ok(id);
      const bind=consent.headers.get('Set-Cookie')?.split(';')[0];
      const submit=new URLSearchParams({request_id:id});
      const denied=await worker.fetch(new Request(origin+'/authorize',{
        method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:bind},
        body:submit.toString()
      }),env);
      assert.equal(denied.status,403,'MFA-mode consent still requires signed Access identity');
      const accepted=await worker.fetch(authRequest('/authorize','POST',submit.toString(),{
        Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:bind
      }),env);
      assert.equal(accepted.status,302);
      const redirect=new URL(accepted.headers.get('Location'));
      assert.equal(redirect.searchParams.get('state'),'mfa_state');
    }
    const logout=await worker.fetch(authRequest('/admin/logout','POST',
      new URLSearchParams({csrf:session.csrf}).toString(),{
      Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie
    }),env);
    assert.equal(logout.status,303);
    assert.equal(logout.headers.get('Location'),'/cdn-cgi/access/logout');
    assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
  }finally{globalThis.fetch=originalFetch;sqlite.close();}
});
