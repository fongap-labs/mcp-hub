import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.ts';
import {getSession} from '../src/admin.ts';
import {ingestionPublicJwk} from '../src/crypto.ts';
import {sha,b64} from '../src/util.ts';
if(!globalThis.crypto)globalThis.crypto=webcrypto;

function d1(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0002_refresh_token_rotation.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_resource_tool_policy.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../migrations/0003_runner_registry_leases.sql',import.meta.url),'utf8'));
  const db={
    prepare(sql){
      return {
        bind(...args){
          const stmt=()=>sqlite.prepare(sql);
          return {
            async first(){return stmt().get(...args)||null;},
            async all(){return {results:stmt().all(...args)};},
            async run(){return stmt().run(...args);}
          };
        }
      };
    }
  };
  return {db,sqlite};
}
async function hybrid(token,publicJwk){
  const rsa=await crypto.subtle.importKey('jwk',publicJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
  const raw=await crypto.subtle.exportKey('raw',aes),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode(token));
  const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP'},rsa,raw);
  return{wrappedKey:b64(new Uint8Array(wrapped)),iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))};
}
const origin='https://mcp.example';
const req=(path,method='GET',body=null,headers={})=>new Request(origin+path,{method,headers,body});
const post=(path,body,cookie,csrf)=>req(path,'POST',JSON.stringify(body),{'Content-Type':'application/json',Origin:origin,Cookie:cookie||'','X-CSRF-Token':csrf||''});

test('E2E: admin adds encrypted GitHub connection, approves client, OAuth PKCE, routes owner, revokes client',async()=>{
  const {db,sqlite}=d1();
  const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const secret=['github','pat','TEST_ONLY_CREDENTIAL_NEVER_ISSUED_BY_GITHUB_123456'].join('_');
  const env={MCP_DB:db,MCP_PUBLIC_URL:origin,MCP_ADMIN_KEY:'a'.repeat(48),MCP_APPROVAL_KEY:'b'.repeat(48),MCP_COOKIE_KEY:'c'.repeat(48),MCP_KEYRING_JSON:JSON.stringify({v1:b64(crypto.getRandomValues(new Uint8Array(32)))}),MCP_ACTIVE_ID:'v1',MCP_INGEST_JWK:JSON.stringify(await crypto.subtle.exportKey('jwk',rsa.privateKey)),GMC_WRITE_MODE:'disabled',GMC_CONTENT_MODE:'disabled',MCP_OAUTH_TTL:'900'};
  const originalFetch=globalThis.fetch;let remoteCount=0;
  globalThis.fetch=async (url,options)=>{
    assert.equal(new URL(url).origin,'https://api.github.com');
    assert.equal(options.headers.Authorization,'Bearer '+secret);
    remoteCount++;
    const path=new URL(url).pathname.toLowerCase();
    const value=path==='/user'?{login:'admin'}:path==='/users/acme'?{type:'Organization'}:path==='/repos/acme/demo'?{full_name:'acme/demo',private:true,description:'demo',default_branch:'main',html_url:'https://github.com/acme/demo'}:path==='/repos/acme/demo/issues'&&options.method==='POST'?{number:42,title:'Test issue',html_url:'https://github.com/acme/demo/issues/42'}:null;
    return new Response(JSON.stringify(value||{message:'not found'}),{status:value?200:404,headers:{'Content-Type':'application/json'}});
  };
  try{
    // Admin login (credentials only through the browser, never a MCP tool).
    const login=await worker.fetch(req('/admin/login','POST',new URLSearchParams({key:env.MCP_ADMIN_KEY}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:origin}),env);
    assert.equal(login.status,303);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const session=await getSession(req('/admin','GET',null,{Cookie:cookie}),env);
    const encrypted=await hybrid(secret,ingestionPublicJwk(env));
    const added=await worker.fetch(post('/admin/api/connections',{owner:'Acme',kind:'Organization',encrypted},cookie,session.csrf),env);
    assert.equal(added.status,200,await added.clone().text());
    const dbRow=sqlite.prepare('SELECT * FROM github_connections WHERE owner=?').get('acme');
    assert.ok(dbRow);assert.ok(!JSON.stringify(dbRow).includes(secret));
    assert.equal(remoteCount,2);
    const registration=await worker.fetch(req('/oauth/register','POST',JSON.stringify({client_name:'Test MCP',redirect_uris:['http://127.0.0.1:1234/callback']}),{'Content-Type':'application/json'}),env);
    assert.equal(registration.status,201);
    const {client_id}=await registration.json();
    const verifier='v'.repeat(48),challenge=await sha(verifier);
    const query=new URLSearchParams({response_type:'code',client_id,redirect_uri:'http://127.0.0.1:1234/callback',resource:origin,scope:'mcp:read',code_challenge:challenge,code_challenge_method:'S256',state:'test_state'});
    const denied=await worker.fetch(req('/authorize?'+query),env);assert.equal(denied.status,400);
    assert.match(await denied.text(),/客户端待批准/);
    const approved=await worker.fetch(post('/admin/api/client-approval',{clientId:client_id,approved:true,allowedOwners:['Acme'],allowedResources:['default','github'],allowedTools:['github:github_available_owners','github:github_get_repository','github:github_list_issues','github:github_get_issue','github:github_list_pull_requests','github:github_get_pull_request','github:github_read_file','github:github_create_issue','github:github_operation_status'],allowWrite:false},cookie,session.csrf),env);
    assert.equal(approved.status,200,await approved.clone().text());
    const authorize=await worker.fetch(req('/authorize?'+query),env);
    assert.equal(authorize.status,200);
    const authCookie=authorize.headers.get('set-cookie').split(';')[0];
    const page=await authorize.text();assert.ok(!page.includes(secret));
    const id=page.match(/name="request_id" value="([A-Za-z0-9_-]+)"/)[1];
    const accepted=await worker.fetch(req('/authorize','POST',new URLSearchParams({request_id:id,approval_key:env.MCP_APPROVAL_KEY}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Cookie:authCookie}),env);
    assert.equal(accepted.status,302);
    const redirect=new URL(accepted.headers.get('Location'));
    assert.equal(redirect.searchParams.get('state'),'test_state');
    const tokenForm=new URLSearchParams({grant_type:'authorization_code',code:redirect.searchParams.get('code'),redirect_uri:'http://127.0.0.1:1234/callback',client_id,code_verifier:verifier,resource:origin});
    const token=await worker.fetch(req('/oauth/token','POST',tokenForm.toString(),{'Content-Type':'application/x-www-form-urlencoded'}),env);
    assert.equal(token.status,200,await token.clone().text());
    const {access_token,expires_in}=await token.json();assert.equal(expires_in,900);assert.ok(!access_token.includes(secret));
    const repeat=await worker.fetch(req('/oauth/token','POST',tokenForm.toString(),{'Content-Type':'application/x-www-form-urlencoded'}),env);assert.equal(repeat.status,400);
    const headers={Authorization:'Bearer '+access_token,'Content-Type':'application/json'};
    const list=await worker.fetch(req('/','POST',JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),headers),env);
    assert.equal(list.status,200);
    const crossResource=await worker.fetch(req('/github','POST',JSON.stringify({jsonrpc:'2.0',id:87,method:'tools/list'}),headers),env);
    assert.equal(crossResource.status,401,'Default-resource token must not access the GitHub-specific resource');
    const rootMetadata=await worker.fetch(req('/.well-known/oauth-protected-resource'),env);
    const githubMetadata=await worker.fetch(req('/.well-known/oauth-protected-resource/github'),env);
    assert.equal((await rootMetadata.json()).resource,origin);
    assert.equal((await githubMetadata.json()).resource,origin+'/github');
    // A second authorization code must bind to the GitHub resource; it cannot reuse the default token.
    const githubQuery=new URLSearchParams(query);
    githubQuery.set('resource',origin+'/github');
    const githubPage=await worker.fetch(req('/authorize?'+githubQuery),env);
    assert.equal(githubPage.status,200);
    const githubCookie=githubPage.headers.get('set-cookie').split(';')[0];
    const githubRequestId=(await githubPage.text()).match(/name="request_id" value="([A-Za-z0-9_-]+)"/)[1];
    const githubAccepted=await worker.fetch(req('/authorize','POST',new URLSearchParams({request_id:githubRequestId,approval_key:env.MCP_APPROVAL_KEY}).toString(),{'Content-Type':'application/x-www-form-urlencoded',Origin:origin,Cookie:githubCookie}),env);
    assert.equal(githubAccepted.status,302);
    const githubCode=new URL(githubAccepted.headers.get('Location')).searchParams.get('code');
    const githubTokenForm=new URLSearchParams({grant_type:'authorization_code',code:githubCode,redirect_uri:'http://127.0.0.1:1234/callback',client_id,code_verifier:verifier,resource:origin+'/github'});
    const githubExchange=await worker.fetch(req('/oauth/token','POST',githubTokenForm.toString(),{'Content-Type':'application/x-www-form-urlencoded'}),env);
    assert.equal(githubExchange.status,200,await githubExchange.clone().text());
    const githubAccess=(await githubExchange.json()).access_token;
    const githubHeaders={Authorization:'Bearer '+githubAccess,'Content-Type':'application/json'};
    const rpc=JSON.stringify({jsonrpc:'2.0',id:89,method:'tools/list'});
    assert.equal((await worker.fetch(req('/github','POST',rpc,githubHeaders),env)).status,200);
    assert.equal((await worker.fetch(req('/','POST',rpc,githubHeaders),env)).status,401,'GitHub token must not access default resource');
    const legacyPath=await worker.fetch(req('/mcp','POST',JSON.stringify({jsonrpc:'2.0',id:88,method:'tools/list'}),headers),env);
    assert.equal(legacyPath.status,404,'Legacy /mcp path must not alias another OAuth resource');
    const listResult=await list.json();assert.ok(listResult.result.tools.some(t=>t.name==='github_get_repository'));
    assert.ok(!listResult.result.tools.some(t=>t.name==='github_create_issue'));
    assert.ok(!listResult.result.tools.some(t=>t.name==='github_read_file'));
    const getRepo=(owner,id)=>req('/','POST',JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'github_get_repository',arguments:{owner,repo:'demo'}}}),headers);
    const blocked=await worker.fetch(getRepo('another-org',2),env);assert.equal((await blocked.json()).result.isError,true);
    assert.equal(remoteCount,2,'Unknown owner must not trigger an outbound request');
    const ok=await worker.fetch(getRepo('Acme',3),env);const message=JSON.stringify(await ok.json());
    assert.ok(message.includes('acme/demo'));assert.ok(!message.includes(secret));assert.equal(remoteCount,3);
    // Enable optional writes. Even an authorized agent can only QUEUE a write.
    sqlite.prepare('UPDATE oauth_clients SET allow_write=1 WHERE client_id=?').run(client_id);
    sqlite.prepare('UPDATE oauth_access_tokens SET scope=?').run('mcp:read mcp:write');
    env.GMC_WRITE_MODE='approval';
    const create=await worker.fetch(req('/','POST',JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'github_create_issue',arguments:{owner:'acme',repo:'demo',title:'Test issue',body:'Reviewed by human'}}}),headers),env);
    const queued=JSON.parse((await create.json()).result.content[0].text);
    assert.equal(queued.status,'pending');assert.equal(remoteCount,3,'Queueing must NEVER perform a GitHub write');
    const approvedWrite=await worker.fetch(post('/admin/api/operation',{id:queued.request_id,action:'approve'},cookie,session.csrf),env);
    assert.equal(approvedWrite.status,200,await approvedWrite.clone().text());assert.equal(remoteCount,4);
    const poll=await worker.fetch(req('/','POST',JSON.stringify({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'github_operation_status',arguments:{request_id:queued.request_id}}}),headers),env);
    assert.equal(JSON.parse((await poll.json()).result.content[0].text).status,'approved');
    const secondApproval=await worker.fetch(post('/admin/api/operation',{id:queued.request_id,action:'approve'},cookie,session.csrf),env);
    assert.equal(secondApproval.status,409,'One-time approval cannot repeat a write');
    assert.equal(remoteCount,4);
    const revoke=await worker.fetch(post('/admin/api/client-approval',{clientId:client_id,approved:false},cookie,session.csrf),env);assert.equal(revoke.status,200);
    const forbidden=await worker.fetch(getRepo('Acme',4),env);assert.equal(forbidden.status,401);
    assert.equal(remoteCount,4);
  }finally{globalThis.fetch=originalFetch;sqlite.close();}
});
