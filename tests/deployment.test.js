import test from 'node:test';
import assert from 'node:assert/strict';
import {loadDeployConfig,buildWranglerConfig,verifyDeployment,SECRET_NAMES} from '../scripts/deployment-config.mjs';
const sha='a'.repeat(40);
function env(overrides={}){return {
  CLOUDFLARE_ACCOUNT_ID_SECONDARY:'b'.repeat(32),
  CLOUDFLARE_API_TOKEN_SECONDARY:'synthetic-credential-for-test',
  MCP_D1_ID:'12345678-1234-1234-1234-123456789abc',
  MCP_PUBLIC_URL:'https://mcp.135468.xyz',
  MCP_ACTIVE_ID:'v1',
  MCP_ACCESS_ISSUER:'https://test-team.cloudflareaccess.com',
  MCP_ACCESS_AUD:'test-audience',
  GMC_WRITE_MODE:'disabled',
  GMC_CONTENT_MODE:'disabled',
  MCP_OAUTH_TTL:'900',
  DEPLOY_SOURCE_SHA:sha,
  DEPLOY_ENVIRONMENT:'production', ...overrides};}
test('Generates exact approved MCP Hub bindings, no credentials or runtime secrets in config',()=>{
 const cfg=buildWranglerConfig(loadDeployConfig(env()));
 assert.equal(cfg.d1_databases[0].database_name,'mcp-hub');
 assert.ok(cfg.main.endsWith('/src/index.ts')||cfg.main.endsWith('\\src\\index.ts'));
 assert.ok(cfg.d1_databases[0].migrations_dir.endsWith('/migrations')||cfg.d1_databases[0].migrations_dir.endsWith('\\migrations'));
 assert.equal(cfg.d1_databases[0].binding,'MCP_DB');
 assert.equal(cfg.vars.MCP_BUILD_SHA,sha);
 assert.equal(cfg.vars.GMC_WRITE_MODE,'disabled');
 assert.equal(cfg.keep_vars,false);
 assert.equal(cfg.workers_dev,false);
 assert.equal(cfg.preview_urls,false);
 assert.deepEqual(cfg.routes,[{pattern:'mcp.135468.xyz',custom_domain:true}]);
 for(const s of SECRET_NAMES)assert.ok(!JSON.stringify(cfg).includes(s));
 assert.ok(!JSON.stringify(cfg).includes('synthetic-credential'));
 assert.equal(Object.keys(cfg.vars).length,8);
});
test('rejects invalid or incomplete deployment configurations',()=>{
 for(const x of [{MCP_D1_ID:''},{MCP_PUBLIC_URL:'http://mcp.135468.xyz'},{MCP_PUBLIC_URL:'https://mcp.example.workers.dev'},{MCP_PUBLIC_URL:'https://gmc.135468.xyz/mcp'},{GMC_WRITE_MODE:'true'},{GMC_CONTENT_MODE:'true'},{MCP_OAUTH_TTL:'120'},{MCP_ACTIVE_ID:''},{MCP_ACCESS_ISSUER:''},{MCP_ACCESS_ISSUER:'https://wrong.example'},{MCP_ACCESS_AUD:''},{DEPLOY_SOURCE_SHA:'main'},{DEPLOY_ENVIRONMENT:'mcp-hub'},{DEPLOY_ENVIRONMENT:'mcp-hub-staging'},{DEPLOY_ENVIRONMENT:'mcp-hub-ops'},{CLOUDFLARE_API_TOKEN_SECONDARY:''}]){
   assert.throws(()=>loadDeployConfig(env(x)));
 }
});
test('rejects cross-origin URLs and deployment paths',()=>{
 for(const u of ['https://x.test','https://x.test/oauth','https://mcp.135468.xyz/?key=1','https://u:p@x.test/mcp','https://mcp.135468.xyz/#hash'])
  assert.throws(()=>loadDeployConfig(env({MCP_PUBLIC_URL:u})));
});
test('checks build SHA, OAuth origin and unauthorized MCP access',async()=>{
 const f=async (url)=>{
  if(url.endsWith('/.well-known/oauth-protected-resource/github')) return Response.json({resource:'https://mcp.135468.xyz/github'});
  if(url.endsWith('/.well-known/oauth-protected-resource')) return Response.json({resource:'https://mcp.135468.xyz'});
  if(url.endsWith('/health')) return Response.json({status:'ok',ready:true,build:sha});
  if(url.includes('/.well-known/'))return Response.json({issuer:'https://mcp.135468.xyz'});
  if(url.endsWith('/github') || url==='https://mcp.135468.xyz/')return new Response('Unauthorized',{status:401});
  throw Error('Unexpected request');
 };
 await verifyDeployment(env().MCP_PUBLIC_URL,sha,f);
 await assert.rejects(()=>verifyDeployment(env().MCP_PUBLIC_URL,'b'.repeat(40),f),/SHA/);
});

test('committed Wrangler defaults keep workers.dev and preview URLs closed',async()=>{
 const {readFileSync}=await import('node:fs');
 const base=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.equal(base.workers_dev,false);
 assert.equal(base.preview_urls,false);
 assert.deepEqual(base.routes,[{pattern:'mcp.135468.xyz',custom_domain:true}]);
});


test('central entrypoint rejects source-owned independent deployment before Cloudflare',async()=>{
  if(process.platform==='win32')return;
  const {spawnSync}=await import('node:child_process');
  const script=new URL('../scripts/deploy.sh',import.meta.url);
  const vars={...process.env,RUNNER_TEMP:'/tmp',DEPLOY_SOURCE_SHA:sha,
    DEPLOY_SOURCE_REPOSITORY:'fongap-labs/mcp-hub',DEPLOY_ENVIRONMENT:'production',
    GITHUB_REPOSITORY:'fongap-labs/mcp-hub'};
  const r=spawnSync('bash',[script.pathname],{env:vars,encoding:'utf8'});
  assert.equal(r.status,77);
  assert.match(r.stderr,/Action Worker control plane/);
  assert.doesNotMatch(r.stdout+r.stderr,/wrangler deploy|migrations apply/);
});
test('central entrypoint requires Cloudflare credentials, not runtime secrets',async()=>{
  if(process.platform==='win32')return;
  const {spawnSync}=await import('node:child_process');
  const script=new URL('../scripts/deploy.sh',import.meta.url);
  const vars={...process.env,RUNNER_TEMP:'/tmp',DEPLOY_SOURCE_SHA:sha,
    DEPLOY_SOURCE_REPOSITORY:'fongap-labs/mcp-hub',DEPLOY_ENVIRONMENT:'production',
    GITHUB_REPOSITORY:'fongap-labs/action-worker'};
  for(const name of ['CLOUDFLARE_API_TOKEN_SECONDARY','MCP_ADMIN_KEY','MCP_APPROVAL_KEY','MCP_TOTP_SECRET',
    'MCP_COOKIE_KEY','MCP_KEYRING_JSON','MCP_INGEST_JWK','MCP_RUNTIME_KEY'])delete vars[name];
  const r=spawnSync('bash',[script.pathname],{env:vars,encoding:'utf8'});
  assert.equal(r.status,77);
  assert.match(r.stderr,/Required Cloudflare deployment credential is unavailable/);
  assert.doesNotMatch(r.stdout+r.stderr,/npm install|wrangler deploy|migrations apply/);
});
test('central entrypoint still rejects retired authentication keys',async()=>{
  if(process.platform==='win32')return;
  const {spawnSync}=await import('node:child_process');
  const script=new URL('../scripts/deploy.sh',import.meta.url);
  const vars={...process.env,RUNNER_TEMP:'/tmp',DEPLOY_SOURCE_SHA:sha,
    DEPLOY_SOURCE_REPOSITORY:'fongap-labs/mcp-hub',DEPLOY_ENVIRONMENT:'production',
    GITHUB_REPOSITORY:'fongap-labs/action-worker',
    CLOUDFLARE_API_TOKEN_SECONDARY:'synthetic-credential'};
  for(const name of ['MCP_ADMIN_KEY','MCP_APPROVAL_KEY','MCP_TOTP_SECRET',
    'MCP_COOKIE_KEY','MCP_KEYRING_JSON','MCP_INGEST_JWK','MCP_RUNTIME_KEY'])delete vars[name];
  for(const name of ['MCP_ADMIN_KEY','MCP_APPROVAL_KEY']){
    const r=spawnSync('bash',[script.pathname],{env:{...vars,[name]:'synthetic-secret'},encoding:'utf8'});
    assert.equal(r.status,77,name);
    assert.match(r.stderr,/Worker runtime Secret must not be passed to deployment/,name);
    assert.doesNotMatch(r.stdout+r.stderr,/npm install|wrangler deploy|migrations apply/,name);
  }
});
test('source manifest scopes GitHub-managed Worker Secrets',async()=>{
  const {readFileSync}=await import('node:fs');
  const required=readFileSync(new URL('../.github/deploy.secrets.required',import.meta.url),'utf8');
  const allowed=readFileSync(new URL('../.github/deploy.secrets.allowed',import.meta.url),'utf8');
  assert.deepEqual(required.trim().split(/\r?\n/),['CLOUDFLARE_API_TOKEN_SECONDARY','MCP_TOTP_SECRET']);
  for(const name of ['MCP_COOKIE_KEY','MCP_KEYRING_JSON','MCP_INGEST_JWK','MCP_RUNTIME_KEY'])
    assert.match(allowed,new RegExp('^'+name+'$', 'm'));
  assert.doesNotMatch(allowed,/^MCP_ADMIN_KEY$|^MCP_APPROVAL_KEY$/m);
  const manifest=JSON.parse(readFileSync(new URL('../.github/deploy.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(manifest.environments),['production']);
  const script=readFileSync(new URL('../scripts/deploy.sh',import.meta.url),'utf8');
  assert.match(script,/runtime-secrets\.mjs prepare/);
  assert.match(script,/wrangler deploy --secrets-file "\$secrets" --config "\$config"/);
  assert.match(script,/rm -rf "\$work"/);
  const cfg=buildWranglerConfig(loadDeployConfig(env()));
  for(const name of SECRET_NAMES)assert.equal(Object.hasOwn(cfg.vars,name),false);
  const types=readFileSync(new URL('../src/types.ts',import.meta.url),'utf8');
  for(const name of SECRET_NAMES)assert.match(types,new RegExp(name+'\\??: string'));
  const runtime=readFileSync(new URL('../src/control/dispatch.ts',import.meta.url),'utf8');
  assert.match(runtime,/env\.MCP_RUNTIME_KEY/);
  assert.match(runtime,/runtimeAuth\(request, env\)/);
});
test('GitHub runtime Secret bundle is minimal, validated and never prints values',async()=>{
  const {selectRuntimeSecrets,writeRuntimeSecretsFile}=await import('../scripts/runtime-secrets.mjs');
  const {mkdtempSync,readFileSync,statSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const secret='A'.repeat(32);
  const base={MCP_TOTP_SECRET:secret,MCP_ACTIVE_ID:'v1'};
  assert.deepEqual(selectRuntimeSecrets(base),{MCP_TOTP_SECRET:secret});
  assert.throws(()=>selectRuntimeSecrets({...base,MCP_TOTP_SECRET:'short'}),/MCP_TOTP_SECRET/);
  assert.throws(()=>selectRuntimeSecrets({...base,MCP_ADMIN_KEY:'deprecated'}),/MCP_ADMIN_KEY/);
  assert.throws(()=>selectRuntimeSecrets({...base,MCP_COOKIE_KEY:'too-short'}),/MCP_COOKIE_KEY/);
  assert.throws(()=>selectRuntimeSecrets({...base,MCP_RUNTIME_KEY:'too-short'}),/MCP_RUNTIME_KEY/);
  const keyring=JSON.stringify({v1:Buffer.alloc(32).toString('base64')});
  const jwk=JSON.stringify({kty:'RSA',d:'test-private-exponent'});
  const crypto={...base,MCP_KEYRING_JSON:keyring,MCP_INGEST_JWK:jwk};
  assert.throws(()=>selectRuntimeSecrets(crypto),/MCP_CRYPTO_SECRET_SYNC/);
  assert.throws(()=>selectRuntimeSecrets({...base,MCP_KEYRING_JSON:keyring,MCP_CRYPTO_SECRET_SYNC:'confirmed'}),/both original keys/);
  assert.deepEqual(selectRuntimeSecrets({...crypto,MCP_CRYPTO_SECRET_SYNC:'confirmed'}),{
    MCP_TOTP_SECRET:secret,MCP_KEYRING_JSON:keyring,MCP_INGEST_JWK:jwk});
  const temp=mkdtempSync(join(tmpdir(),'mcp-deploy-secrets-'));
  try {
    const file=join(temp,'worker-secrets.json');
    assert.equal(writeRuntimeSecretsFile(file,base),1);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{MCP_TOTP_SECRET:secret});
    if(process.platform!=='win32')assert.equal(statSync(file).mode&0o077,0);
    assert.throws(()=>writeRuntimeSecretsFile(file,base),/EEXIST/);
  }finally{rmSync(temp,{recursive:true,force:true})}
});
test('central deploy removes credentials from npm child processes',async()=>{
  const {readFileSync}=await import('node:fs');
  const script=readFileSync(new URL('../scripts/deploy.sh',import.meta.url),'utf8');
  assert.match(script,/safe_env=\(env\)/);
  assert.match(script,/npm install --ignore-scripts/);
  assert.match(script,/npm run validate/);
  for(const name of ['CLOUDFLARE_API_TOKEN_SECONDARY','MCP_ADMIN_KEY','MCP_APPROVAL_KEY','MCP_TOTP_SECRET',
    'MCP_COOKIE_KEY','MCP_KEYRING_JSON','MCP_INGEST_JWK','MCP_RUNTIME_KEY'])
    assert.match(script,new RegExp(name));
});

test('central deploy uses supported Wrangler D1 remote migration arguments',async()=>{
  const {readFileSync}=await import('node:fs');
  const script=readFileSync(new URL('../scripts/deploy.sh',import.meta.url),'utf8');
 const migration=script.split('\n').find(line=>line.startsWith('wrangler d1 migrations apply '))?.trimEnd();
  assert.equal(migration,'wrangler d1 migrations apply mcp-hub --remote --config "$config"');
  assert.doesNotMatch(migration,/--yes\b/);
});
