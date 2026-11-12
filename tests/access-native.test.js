import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker from '../src/index.ts';
import {accessIdentity,accessIdentityFromWorker} from '../src/access.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://mcp.135468.xyz';
const config={MCP_ACCESS_ISSUER:accessIssuer,MCP_ACCESS_AUD:accessAud,MCP_AUTH_MODE:'cloudflare-mfa'};
const identity={email:'Admin@Example.Test'};
const native={access:{aud:accessAud,getIdentity:async()=>identity}};

test('trusted Cloudflare Worker Access context authenticates exact AUD without forwarded JWT',async()=>{
  const req=new Request(origin+'/admin/login',{method:'POST'});
  assert.equal(await accessIdentity(req,config),null);
  const subject=await accessIdentityFromWorker(req,config,native);
  assert.match(subject,/^cf:[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(subject,/Admin|example\.test/i);
  assert.equal(await accessIdentity(req,config),subject,'downstream handler must see same authenticated identity');
  const response=await worker.fetch(new Request(origin+'/admin/login',{method:'POST'}),config,native);
  assert.equal(response.status,405,'local OTP login remains disabled for authenticated MFA mode');
  assert.equal((await worker.fetch(new Request(origin+'/admin/login',{method:'POST'}),config)).status,403);
});

test('native identity is fail-closed on wrong audience, absent email or invalid config',async()=>{
  const signed=await accessFixture();
  const withJwt=new Request(origin+'/admin/login',{method:'POST',headers:{'Cf-Access-Jwt-Assertion':signed.assertion}});
  assert.equal(await accessIdentityFromWorker(withJwt,config,{
    access:{aud:'other-app',getIdentity:async()=>identity}
  }),null,'a trusted context for a different app cannot use fallback JWT');
  assert.equal(await accessIdentityFromWorker(new Request(origin+'/admin'),config,{
    access:{aud:accessAud,getIdentity:async()=>({})}
  }),null,'an authenticated context without user identity is not an admin login');
  assert.equal(await accessIdentityFromWorker(new Request(origin+'/admin'),config,{
    access:{aud:accessAud,getIdentity:async()=>({email:'not-an-email'})}
  }),null);
  assert.equal(await accessIdentityFromWorker(new Request(origin+'/admin'),{
    ...config,MCP_ACCESS_AUD:'another-app'
  },native),null);
  const denied=await worker.fetch(new Request(origin+'/admin/login',{method:'POST'}),config,{
    access:{aud:'other-app',getIdentity:async()=>identity}
  });
  assert.equal(denied.status,403);
});

test('verified native identity is stable across same-user requests but not an unverified session',async()=>{
  const a=await accessIdentityFromWorker(new Request(origin+'/admin'),config,native);
  const b=await accessIdentityFromWorker(new Request(origin+'/admin'),config,{
    access:{aud:accessAud,getIdentity:async()=>({email:'admin@example.test'})}
  });
  assert.equal(a,b);
  const request=new Request(origin+'/admin');
  assert.equal(await accessIdentity(request,config),null);
  assert.equal((await worker.fetch(new Request(origin+'/admin'),config)).status,403);
});
