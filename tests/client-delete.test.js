import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.ts';
import {getSession} from '../src/admin.ts';
import {sha,escapeHtml} from '../src/util.ts';
import {renderClientRow} from '../src/i18n/zh-CN.ts';
import {accessFixture,accessIssuer,accessAud} from './helpers/access.js';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

const origin='https://mcp.example';
const firstId='mcp_'+'A'.repeat(43);
const secondId='mcp_'+'B'.repeat(43);
const thirdId='mcp_'+'C'.repeat(43);
const now=Math.floor(Date.now()/1000);

function database(){
  const sqlite=new DatabaseSync(':memory:');
  for(const filename of [
    '0001_init.sql','0002_refresh_token_rotation.sql',
    '0003_resource_tool_policy.sql','0003_runner_registry_leases.sql',
    '0004_runner_dispatch.sql','0005_admin_totp.sql'
  ])sqlite.exec(readFileSync(new URL('../migrations/'+filename,import.meta.url),'utf8'));
  sqlite.exec('PRAGMA foreign_keys=ON');
  const statement=(sql,args=[])=>({
    sql,args,
    bind(...values){return statement(sql,values);},
    async first(){return sqlite.prepare(sql).get(...args)||null;},
    async all(){return{results:sqlite.prepare(sql).all(...args)};},
    async run(){return sqlite.prepare(sql).run(...args);}
  });
  const db={
    prepare:sql=>statement(sql),
    async batch(statements){
      sqlite.exec('BEGIN IMMEDIATE');
      try{
        const results=statements.map(st=>({success:true,meta:sqlite.prepare(st.sql).run(...st.args)}));
        sqlite.exec('COMMIT');
        return results;
      }catch(error){sqlite.exec('ROLLBACK');throw error;}
    }
  };
  return {sqlite,db};
}
function insertClient(sqlite,id,name='ChatGPT'){
  sqlite.prepare('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,approved,allowed_owners,allowed_resources,allowed_tools,grant_types,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,name,'["https://chatgpt.com/connector/oauth/callback"]',1,'[]','["default"]','["github:github_available_owners"]','["authorization_code","refresh_token"]',now);
}
function insertTokens(sqlite,id){
  const grant='grant-'+id;
  sqlite.prepare('INSERT INTO oauth_grants(grant_id,client_id,resource,scope,auth_version,created_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(grant,id,origin,'mcp:read',0,now,now+86400);
  sqlite.prepare('INSERT INTO oauth_refresh_tokens(token_hash,grant_id,client_id,issued_at,expires_at) VALUES(?,?,?,?,?)')
    .run('refresh-'+id,grant,id,now,now+3600);
  sqlite.prepare('INSERT INTO oauth_access_tokens(token_hash,client_id,resource,scope,expires_at,grant_id,auth_version) VALUES(?,?,?,?,?,?,?)')
    .run('access-'+id,id,origin,'mcp:read',now+3600,grant,0);
  sqlite.prepare('INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,resource,scope,code_challenge,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run('code-'+id,id,'https://chatgpt.com/connector/oauth/callback',origin,'mcp:read','x'.repeat(43),now+600);
  sqlite.prepare('INSERT INTO oauth_auth_requests(id_hash,cookie_hash,client_id,redirect_uri,resource,scope,code_challenge,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('auth-'+id,'cookie-'+id,id,'https://chatgpt.com/connector/oauth/callback',origin,'mcp:read','x'.repeat(43),now+600);
}
function insertApproval(sqlite,id,status){
  sqlite.prepare('INSERT INTO approval_requests(id,client_id,owner,repo,title,body,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('approval-'+id,id,'acme','repo','test','audit',status,now,now+600);
}
function count(sqlite,table,id){
  return sqlite.prepare('SELECT COUNT(*) AS n FROM '+table+' WHERE client_id=?').get(id).n;
}
test('MCP client deletion is authenticated, confirmed, CSRF-protected, atomic and preserves audit',async()=>{
  const {sqlite,db}=database();
  const auth=await accessFixture();
  const env={MCP_DB:db,MCP_PUBLIC_URL:origin,MCP_ACCESS_ISSUER:accessIssuer,
    MCP_ACCESS_AUD:accessAud,MCP_AUTH_MODE:'cloudflare-mfa',MCP_COOKIE_KEY:'Z'.repeat(48),
    GMC_WRITE_MODE:'disabled',GMC_CONTENT_MODE:'disabled'};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.equal(String(url),accessIssuer+'/cdn-cgi/access/certs');
    return Response.json(auth.jwks);
  };
  const jwt={'Cf-Access-Jwt-Assertion':auth.assertion};
  const api=(body,headers={})=>new Request(origin+'/admin/api/client-delete',{
    method:'POST',headers:{...jwt,Origin:origin,'Content-Type':'application/json',...headers},
    body:JSON.stringify(body)
  });
  try{
    insertClient(sqlite,firstId,'ChatGPT');
    insertClient(sqlite,secondId,'Second Client');
    insertTokens(sqlite,firstId);
    insertTokens(sqlite,secondId);
    insertApproval(sqlite,firstId,'pending');
    insertApproval(sqlite,secondId,'approved');
    const page=await worker.fetch(new Request(origin+'/admin',{headers:jwt}),env);
    assert.equal(page.status,200,await page.clone().text());
    const html=await page.text();
    assert.match(html,/delete-client danger/);
    assert.match(html,/data-client-name="ChatGPT"/);
    assert.match(html,/data-client="mcp_[A-Za-z0-9_-]{43}"/);
    const cookie=page.headers.get('Set-Cookie')?.split(';')[0];
    const session=await getSession(new Request(origin+'/admin',{headers:{...jwt,Cookie:cookie}}),env);
    assert.ok(session?.csrf);
    const body={clientId:firstId,confirmClientId:firstId};
    assert.equal((await worker.fetch(api(body,{Cookie:cookie,'X-CSRF-Token':session.csrf,'Cf-Access-Jwt-Assertion':''}),env)).status,403);
    assert.equal((await worker.fetch(api(body,{Cookie:cookie}),env)).status,403);
    assert.equal((await worker.fetch(api({...body,confirmClientId:secondId},{Cookie:cookie,'X-CSRF-Token':session.csrf}),env)).status,400);
    assert.equal(count(sqlite,'oauth_access_tokens',firstId),1);
    assert.equal((await worker.fetch(api(body,{Cookie:cookie,'X-CSRF-Token':session.csrf}),env)).status,200);
    assert.equal(count(sqlite,'oauth_clients',firstId),0);
    for(const table of ['oauth_access_tokens','oauth_refresh_tokens','oauth_codes','oauth_auth_requests','oauth_grants'])
      assert.equal(count(sqlite,table,firstId),0,table+' must not retain old credentials');
    assert.equal(sqlite.prepare('SELECT status FROM approval_requests WHERE client_id=?').get(firstId).status,'denied');
    for(const table of ['oauth_clients','oauth_access_tokens','oauth_refresh_tokens','oauth_codes','oauth_auth_requests','oauth_grants'])
      assert.equal(count(sqlite,table,secondId),1,'another client must remain intact: '+table);
    assert.equal(sqlite.prepare('SELECT status FROM approval_requests WHERE client_id=?').get(secondId).status,'approved');
    assert.equal((await worker.fetch(api(body,{Cookie:cookie,'X-CSRF-Token':session.csrf}),env)).status,404);
  }finally{globalThis.fetch=originalFetch;sqlite.close();}
});

test('in-flight GitHub writes block deletion; a D1 batch failure rolls back every credential deletion',async()=>{
  const {sqlite,db}=database();
  const auth=await accessFixture();
  const env={MCP_DB:db,MCP_PUBLIC_URL:origin,MCP_ACCESS_ISSUER:accessIssuer,
    MCP_ACCESS_AUD:accessAud,MCP_AUTH_MODE:'cloudflare-mfa',MCP_COOKIE_KEY:'Z'.repeat(48),
    GMC_WRITE_MODE:'disabled',GMC_CONTENT_MODE:'disabled'};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>Response.json(auth.jwks);
  try{
    insertClient(sqlite,thirdId);
    insertTokens(sqlite,thirdId);
    insertApproval(sqlite,thirdId,'processing');
    // A deliberately processing audit row must not require a working Admin
    // dashboard to exercise the independent deletion safety gate. Construct a
    // correctly signed session using a test-only key and a signed Access user.
    const csrf='C'.repeat(43);
    const payload={exp:now+1800,csrf,sub:'admin-identity'};
    const bytes=new TextEncoder().encode(JSON.stringify(payload));
    const body=Buffer.from(bytes).toString('base64url');
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.MCP_COOKIE_KEY),
      {name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body))).toString('base64url');
    const cookie='__Host-gmcp-admin='+body+'.'+signature;
    const session=await getSession(new Request(origin+'/admin',{headers:{Cookie:cookie,'Cf-Access-Jwt-Assertion':auth.assertion}}),env);
    assert.equal(session?.csrf,csrf);
    const request=()=>new Request(origin+'/admin/api/client-delete',{method:'POST',headers:{
      'Cf-Access-Jwt-Assertion':auth.assertion,Origin:origin,'Content-Type':'application/json',
      'X-CSRF-Token':session.csrf,Cookie:cookie
    },body:JSON.stringify({clientId:thirdId,confirmClientId:thirdId})});
    assert.equal((await worker.fetch(request(),env)).status,409);
    assert.equal(count(sqlite,'oauth_clients',thirdId),1);
    sqlite.prepare("UPDATE approval_requests SET status='pending' WHERE client_id=?").run(thirdId);
    const batch=db.batch.bind(db);
    db.batch=async statements=>batch([
      ...statements.slice(0,2),
      {sql:'THIS IS NOT VALID SQL',args:[]},
      ...statements.slice(2)
    ]);
    assert.equal((await worker.fetch(request(),env)).status,500);
    assert.equal(count(sqlite,'oauth_clients',thirdId),1);
    assert.equal(count(sqlite,'oauth_access_tokens',thirdId),1);
    assert.equal(count(sqlite,'oauth_refresh_tokens',thirdId),1);
    assert.equal(sqlite.prepare('SELECT status FROM approval_requests WHERE client_id=?').get(thirdId).status,'pending');
  }finally{globalThis.fetch=originalFetch;sqlite.close();}
});

test('client deletion UI escapes displayed client names and requires an explicit confirmation',()=>{
  const row=renderClientRow({
    client_id:firstId,client_name:'ChatGPT "Admin" & <script>',redirect_uris:'[]',
    approved:0,allowed_owners:'[]',allowed_resources:'[]',allowed_tools:'[]',allow_write:0
  },escapeHtml,[]);
  assert.match(row,/class="delete-client danger"/);
  assert.match(row,/data-client-name="ChatGPT &quot;Admin&quot; &amp; &lt;script&gt;"/);
  assert.doesNotMatch(row,/<script>/);
});
