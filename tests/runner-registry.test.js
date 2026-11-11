import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.ts';
import {acquireRunnerLease,provisionRunner,releaseRunnerLease,renewRunnerLease} from '../src/control/runner-registry.ts';
import {getSession} from '../src/admin.ts';
import {now} from '../src/util.ts';
import {totpAt} from '../src/totp.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function d1(){
  const sqlite=new DatabaseSync(':memory:');
  for(const path of ['0001_init.sql','0002_refresh_token_rotation.sql','0003_resource_tool_policy.sql','0003_runner_registry_leases.sql','0004_runner_dispatch.sql','0005_admin_totp.sql'])
    sqlite.exec(readFileSync(new URL('../migrations/'+path,import.meta.url),'utf8'));
  const db={prepare(sql){
    const statement=args=>({
      async first(){return sqlite.prepare(sql).get(...args)||null;},
      async all(){return{results:sqlite.prepare(sql).all(...args)};},
      async run(){return sqlite.prepare(sql).run(...args);},
    });
    return{...statement([]),bind(...args){return statement(args);}};
  }};
  return{db,sqlite};
}
const origin='https://mcp.example';
const request=(path,body,token)=>new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
const registration={protocolVersion:'v1',displayName:'Codex local',capabilities:['coding.patch','coding.test'],maxConcurrency:2};

test('Runner bearer credential binds identity, registration limits and strictly increasing heartbeats',async()=>{
  const {db,sqlite}=d1();const env={MCP_DB:db};
  const provisioned=await provisionRunner(env,{displayName:'Provisioned',allowedCapabilities:['coding.patch','coding.test'],maxConcurrency:2});
  assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM runner_credentials').all()).includes(provisioned.token));
  assert.equal((await worker.fetch(request('/runner/register',registration),env)).status,401);
  const forged=await worker.fetch(request('/runner/register',{...registration,runnerId:'runner_attacker'},provisioned.token),env);
  assert.equal(forged.status,400);
  const registered=await worker.fetch(request('/runner/register',registration,provisioned.token),env);
  assert.equal(registered.status,200,await registered.clone().text());
  const disallowed=await worker.fetch(request('/runner/register',{...registration,capabilities:['system.admin']},provisioned.token),env);
  assert.equal(disallowed.status,403);
  const heartbeat=await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:1,activeConcurrency:0},provisioned.token),env);
  assert.equal(heartbeat.status,200,await heartbeat.clone().text());
  assert.equal((await heartbeat.json()).capacity.runnerId,provisioned.runnerId);
  const replay=await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:1,activeConcurrency:0},provisioned.token),env);
  assert.equal(replay.status,409);
  const injected=await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:2,activeConcurrency:0,runnerId:'other'},provisioned.token),env);
  assert.equal(injected.status,400);
  assert.equal(sqlite.prepare('SELECT heartbeat_sequence FROM runners WHERE runner_id=?').get(provisioned.runnerId).heartbeat_sequence,1);
});

test('Runner lease claims are capacity-bounded, idempotent and retained after release or expiry',async()=>{
  const {db}=d1();const env={MCP_DB:db};
  const provisioned=await provisionRunner(env,{displayName:'Lease Runner',allowedCapabilities:['coding.patch'],maxConcurrency:2});
  await worker.fetch(request('/runner/register',{protocolVersion:'v1',displayName:'Lease Runner',capabilities:['coding.patch'],maxConcurrency:2},provisioned.token),env);
  const pulse=await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:1,activeConcurrency:0},provisioned.token),env);
  assert.equal(pulse.status,200);
  const at=now();
  const a={runnerId:provisioned.runnerId,idempotencyKey:'job-a',resourceKey:'workspace:a',ttlSeconds:60};
  const b={runnerId:provisioned.runnerId,idempotencyKey:'job-b',resourceKey:'workspace:b',ttlSeconds:60};
  const c={runnerId:provisioned.runnerId,idempotencyKey:'job-c',resourceKey:'workspace:c',ttlSeconds:60};
  const outcomes=await Promise.allSettled([acquireRunnerLease(env,a,at),acquireRunnerLease(env,b,at),acquireRunnerLease(env,c,at)]);
  const claims=outcomes.filter(result=>result.status==='fulfilled').map(result=>result.value);
  assert.equal(claims.length,2);
  assert.equal(outcomes.filter(result=>result.status==='rejected'&&result.reason.code==='unavailable').length,1);
  const leaseA=claims.find(lease=>lease.idempotencyKey==='job-a');
  const leaseB=claims.find(lease=>lease.idempotencyKey==='job-b');
  assert.ok(leaseA&&leaseB);
  assert.notEqual(leaseA.leaseId,leaseB.leaseId);
  assert.equal((await acquireRunnerLease(env,a,at)).leaseId,leaseA.leaseId);
  await assert.rejects(acquireRunnerLease(env,{...a,resourceKey:'workspace:other'},at),error=>error.code==='conflict');
  await assert.rejects(acquireRunnerLease(env,{...b,idempotencyKey:'job-d'},at),error=>error.code==='unavailable');
  assert.equal(await renewRunnerLease(env,leaseA.leaseId,120,at),true);
  assert.equal(await releaseRunnerLease(env,leaseA.leaseId,at+1),true);
  assert.equal(await releaseRunnerLease(env,leaseA.leaseId,at+2),false);
  await assert.rejects(acquireRunnerLease(env,a,at+2),error=>error.code==='conflict');
  await assert.rejects(acquireRunnerLease(env,b,at+120),error=>error.code==='conflict');
});

test('revoking a Runner invalidates its credential and releases its lease',async()=>{
  const {db,sqlite}=d1();
  const auth=await accessFixture();
  const env={
    MCP_DB:db,
    MCP_ACCESS_ISSUER:accessIssuer,
    MCP_ACCESS_AUD:accessAud,
    MCP_TOTP_SECRET:'JBSWY3DP'.repeat(4),
    MCP_COOKIE_KEY:'c'.repeat(48),
  };
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(url,accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(auth.jwks);
  };
  const accessHeaders={'Cf-Access-Jwt-Assertion':auth.assertion};
  try {
    const code=await totpAt(env.MCP_TOTP_SECRET,Math.floor(Date.now()/30000));
    const login=await worker.fetch(new Request(origin+'/admin/login',{
      method:'POST',
      headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...accessHeaders},
      body:new URLSearchParams({totp_code:code}).toString(),
    }),env);
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const session=await getSession(new Request(origin+'/admin',{headers:{Cookie:cookie,...accessHeaders}}),env);
    assert.ok(session);
    const adminPost=(path,body)=>worker.fetch(new Request(origin+path,{
      method:'POST',
      headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json',...accessHeaders},
      body:JSON.stringify(body),
    }),env);
    const page=await worker.fetch(new Request(origin+'/admin',{headers:{Cookie:cookie,...accessHeaders}}),env);
    assert.match(await page.text(),/runner-add/);
    const provisionResponse=await adminPost('/admin/api/runners/provision',{displayName:'Revoked',capabilities:['coding.patch'],maxConcurrency:1});
    assert.equal(provisionResponse.status,201,await provisionResponse.clone().text());
    const provisioned=await provisionResponse.json();
    assert.ok(provisioned.token);
    const stored=sqlite.prepare('SELECT * FROM runner_credentials WHERE runner_id=?').get(provisioned.runnerId);
    assert.ok(!JSON.stringify(stored).includes(provisioned.token));
    await worker.fetch(request('/runner/register',{protocolVersion:'v1',displayName:'Revoked',capabilities:['coding.patch'],maxConcurrency:1},provisioned.token),env);
    await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:1,activeConcurrency:0},provisioned.token),env);
    const lease=await acquireRunnerLease(env,{runnerId:provisioned.runnerId,idempotencyKey:'revoke-me',resourceKey:'workspace:c',ttlSeconds:60});
    assert.equal((await adminPost('/admin/api/runners/revoke',{runnerId:provisioned.runnerId})).status,200);
    assert.equal((await worker.fetch(request('/runner/heartbeat',{protocolVersion:'v1',sequence:2,activeConcurrency:0},provisioned.token),env)).status,401);
    assert.ok(sqlite.prepare('SELECT released_at FROM runner_leases WHERE lease_id=?').get(lease.leaseId).released_at);
  } finally {globalThis.fetch=originalFetch;sqlite.close();}
});
