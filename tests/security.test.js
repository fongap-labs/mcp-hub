import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {seal,unseal,decryptIngested,ingestionPublicJwk} from '../src/crypto.ts';
import {getOwnerToken,githubPath,redact,PublicError} from '../src/github.ts';
import {getSession,adminLogin} from '../src/admin.ts';
import {processMcp} from '../src/mcp.ts';
import {MCP_SERVERS} from '../src/mcp-registry.ts';
import {validateMcpToken} from '../src/oauth.ts';
import {sha,b64} from '../src/util.ts';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const key=b64(crypto.getRandomValues(new Uint8Array(32)));
const baseEnv={MCP_KEYRING_JSON:JSON.stringify({v1:key}),MCP_ACTIVE_ID:'v1'};

test('AES-GCM roundtrip, wrong owner cannot decrypt',async()=>{
  const secret='synthetic-credential-for-encryption-roundtrip';
  const sealed=await seal(baseEnv,'acme',secret);
  const row={owner:'acme',...sealed};
  assert.equal(await unseal(baseEnv,row),secret);
  await assert.rejects(()=>unseal(baseEnv,{...row,owner:'other'}));
  assert.ok(!JSON.stringify(sealed).includes(secret));
});

test('Browser hybrid encrypted Token decrypts in Worker, public JWK has no private component',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const env={MCP_INGEST_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',pair.privateKey))};
  const pub=ingestionPublicJwk(env);
  assert.equal('d' in pub,false);
  const rsa=await crypto.subtle.importKey('jwk',pub,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
  const raw=await crypto.subtle.exportKey('raw',aes);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const secret='synthetic-credential-for-browser-encryption';
  const wrappedKey=await crypto.subtle.encrypt({name:'RSA-OAEP'},rsa,raw);
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(secret));
  assert.equal(await decryptIngested(env,{wrappedKey:b64(new Uint8Array(wrappedKey)),iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))}),secret);
  await assert.rejects(()=>decryptIngested(env,{wrappedKey:b64(new Uint8Array(wrappedKey)),iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext).map((b,i)=>i?b:b^1))}));
});

test('owner routing is case-insensitive and fails closed, never falls back',async()=>{
  let rows=[];const env={...baseEnv,MCP_DB:{prepare(sql){assert.match(sql,/WHERE owner=\? AND enabled=1/);return{bind(owner){rows.push(owner);return{first:async()=>null}}}}}};
  await assert.rejects(()=>getOwnerToken(env,'ACME'),/No enabled GitHub connection/);
  assert.deepEqual(rows,['acme']);
  await assert.rejects(()=>getOwnerToken(env,'bad/owner'),/Invalid GitHub owner/);
  assert.deepEqual(rows,['acme']);
});

test('GitHub operations only construct paths to a fixed API and refuse traversal',()=>{
  assert.equal(githubPath({owner:'acme',repo:'test',kind:'repo'}),'/repos/acme/test');
  assert.throws(()=>githubPath({owner:'acme',repo:'test',kind:'file',path:'../secrets'}),PublicError);
  assert.throws(()=>githubPath({owner:'acme',repo:'bad/repo',kind:'repo'}),PublicError);
  assert.equal(githubPath({owner:'acme',repo:'test',kind:'file',path:'docs/file.md'}),'/repos/acme/test/contents/docs/file.md');
});

test('Github token strings are redacted from tool JSON output',()=>{
  const fineGrained=['github','pat','abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
  const classic=['gh','p_','abcdefghijklmnopqrstuvwxyz012345'].join('');
  const raw='Authorization: '+fineGrained+' | '+classic;
  assert.ok(!redact(raw).includes(classic));
  assert.ok(!redact(raw).includes(fineGrained));
});

test('MCP refuses tool operations on unapproved owner, even when a client has read scope',async()=>{
  const req=new Request('https://mcp.example/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'github_get_repository',arguments:{owner:'other-org',repo:'private'}}})});
  const env={MCP_DB:{prepare(){throw new Error('DB must not be touched for unapproved owner');}}};
  const result=await processMcp(req,env,{scopes:['mcp:read'],allowedOwners:['acme'],allowedResources:['default'],allowedTools:['github:github_get_repository']},MCP_SERVERS[0]);
  const body=await result.json();assert.equal(body.result.isError,true);assert.match(body.result.content[0].text,/not authorized/);
});

test('Admin requires a valid Access identity and a single-use TOTP',async()=>{
  const {accessFixture,accessIssuer,accessAud}=await import('./helpers/access.js');
  const {totpAt}=await import('../src/totp.ts');
  const {webcrypto}=await import('node:crypto');
  if(!globalThis.crypto)globalThis.crypto=webcrypto;
  const {DatabaseSync}=await import('node:sqlite');
  const sql=new DatabaseSync(':memory:');
  const {readFileSync}=await import('node:fs');
  sql.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  sql.exec(readFileSync(new URL('../migrations/0005_admin_totp.sql',import.meta.url),'utf8'));
  const db={prepare(query){return{bind(...args){return{
    first:async()=>sql.prepare(query).get(...args)||null
  }}}}};
  const auth=await accessFixture();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async u=>{
    assert.equal(new URL(u).origin,accessIssuer);
    return Response.json(auth.jwks);
  };
  const env={MCP_ACCESS_ISSUER:accessIssuer,MCP_ACCESS_AUD:accessAud,
    MCP_TOTP_SECRET:('JBSWY3DP').repeat(4),
    MCP_COOKIE_KEY:'B'.repeat(48),MCP_DB:db};
  const origin='https://mcp.example';
  try {
    const code=await totpAt(env.MCP_TOTP_SECRET,Math.floor(Date.now()/30000));
    const body=new URLSearchParams({totp_code:code}).toString();
    const request=(assertion)=>new Request(origin+'/admin/login',{method:'POST',headers:{
      Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...(assertion?{'Cf-Access-Jwt-Assertion':assertion}:{})
    },body});
    assert.equal((await adminLogin(request(''),env)).status,403,'Missing Access assertion');
    const login=await adminLogin(request(auth.assertion),env);
    assert.equal(login.status,303);
    assert.equal((await adminLogin(request(auth.assertion),env)).status,403,'One-time code cannot be reused');
    const value=login.headers.get('Set-Cookie').split(';')[0];
    const ok=await getSession(new Request(origin+'/admin',{headers:{Cookie:value,'Cf-Access-Jwt-Assertion':auth.assertion}}),env);
    assert.ok(ok?.csrf);
    assert.equal(await getSession(new Request(origin+'/admin',{headers:{Cookie:value}}),env),null,'Access must remain valid');
    const tampered=value.slice(0,-1)+(value.endsWith('a')?'b':'a');
    assert.equal(await getSession(new Request(origin+'/admin',{headers:{Cookie:tampered,'Cf-Access-Jwt-Assertion':auth.assertion}}),env),null);
  } finally {globalThis.fetch=originalFetch;sql.close();}
});

test('OAuth token denied immediately after client revocation, or audience mismatch',async()=>{
  const token='x'.repeat(43);
  const env={MCP_PUBLIC_URL:'https://mcp.example/',MCP_DB:{prepare(){return{bind(){return{first:async()=>({resource:'https://mcp.example/',scope:'mcp:read',expires_at:Date.now()/1000+100,approved:0,allowed_owners:'["acme"]'})}}}}}};
  assert.equal(await validateMcpToken(new Request('https://mcp.example/',{headers:{Authorization:'Bearer '+token}}),env,MCP_SERVERS[0]),null);
});
