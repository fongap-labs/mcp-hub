import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker from '../src/index.ts';
import {accessIdentity} from '../src/access.ts';
import {renderAccessDenied} from '../src/i18n/zh-CN.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://mcp.135468.xyz';

test('Access permits a signed application cookie only when the assertion header is absent',async()=>{
  const auth=await accessFixture();
  const env={MCP_ACCESS_ISSUER:accessIssuer,MCP_ACCESS_AUD:accessAud};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(auth.jwks);
  };
  try {
    const cookie='CF_Authorization='+auth.assertion;
    const signedCookie=new Request(origin+'/admin',{headers:{Cookie:cookie}});
    const signedHeader=new Request(origin+'/admin',{headers:{'Cf-Access-Jwt-Assertion':auth.assertion}});
    assert.equal(await accessIdentity(signedCookie,env),'admin-identity');
    const quotedCookie=new Request(origin+'/admin',{headers:{Cookie:'CF_Authorization="'+auth.assertion+'"'}});
    assert.equal(await accessIdentity(quotedCookie,env),'admin-identity');
    assert.equal((await worker.fetch(quotedCookie,env)).status,200);
    assert.equal(await accessIdentity(signedHeader,env),'admin-identity');
    assert.equal((await worker.fetch(signedCookie,env)).status,200);
    const login=await worker.fetch(signedHeader,env);
    assert.equal(login.status,200);
    assert.match(await login.text(),/totp_code/);

    assert.equal(await accessIdentity(new Request(origin+'/admin',{
      headers:{Cookie:cookie,'Cf-Access-Jwt-Assertion':'malformed-assertion'}
    }),env),null,'A present invalid assertion must not fall back to a valid cookie');

    assert.equal(await accessIdentity(new Request(origin+'/admin',{headers:{Cookie:cookie}}),{
      ...env,MCP_ACCESS_AUD:'another-app'
    }),null,'Cookie must match the expected application audience');
    assert.equal(await accessIdentity(new Request(origin+'/admin',{
      headers:{Cookie:'CF_Authorization=unsigned.fake.token'}
    }),env),null,'Unsigned or forged cookies are rejected');
    assert.equal(await accessIdentity(new Request(origin+'/admin',{
      headers:{Cookie:'CF_Authorization="malformed.jwt"'}
    }),env),null,'Malformed quoted cookies cannot bypass Access validation');
    assert.equal(await accessIdentity(new Request(origin+'/admin',{
      headers:{Cookie:'CF_Authorization="'+auth.assertion+'"','Cf-Access-Jwt-Assertion':'invalid'}
    }),env),null,'Invalid assertion header remains authoritative over quoted Cookie');
    assert.equal(await accessIdentity(new Request(origin+'/admin',{
      headers:{Cookie:'CF_Authorization='}
    }),env),null,'Missing cookies fail closed');
  } finally {globalThis.fetch=originalFetch;}
});

test('Browser Access denial is explanatory; machine APIs retain JSON and both fail closed',async()=>{
  const request=(path,method='GET',accept='text/html')=>new Request(origin+path,{
    method,headers:{Accept:accept}
  });
  const browser=await worker.fetch(request('/admin'),{});
  assert.equal(browser.status,403);
  assert.match(browser.headers.get('Content-Type'),/text\/html/);
  assert.equal(browser.headers.get('Cache-Control'),'no-store');
  assert.match(browser.headers.get('Content-Security-Policy'),/default-src 'none'/);
  const page=await browser.text();
  assert.match(page,/Cloudflare Access/);
  assert.equal(page,renderAccessDenied());
  assert.doesNotMatch(page,/MCP_TOTP_SECRET|CF_Authorization=/);
  assert.equal((await worker.fetch(request('/authorize'),{})).status,403);

  const api=await worker.fetch(request('/admin/api/status','GET','application/json'),{});
  assert.equal(api.status,403);
  assert.deepEqual(await api.json(),{error:'Cloudflare Access required'});
  const post=await worker.fetch(request('/admin/login','POST'),{});
  assert.equal(post.status,403);
  assert.deepEqual(await post.json(),{error:'Cloudflare Access required'});
});
