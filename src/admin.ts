import type { Env, AdminSession, McpAuth } from './types.ts';
import {now,b64u,unb64u,encoder,randomId,equals,cookie,originOk,form,bodyJson,json,html,escapeHtml,validOwner} from './util.ts';
import {ingestionPublicJwk,decryptIngested,seal,unseal} from './crypto.ts';
import {apiFetch,githubPath,getOwnerToken,PublicError} from './github.ts';
import {ADMIN_SCRIPT,ADMIN_CSS} from './admin-ui.ts';
import {BRAND_NAME,BRAND_HEAD,BRAND_HEADER} from './brand.ts';
import {rateLimit} from './oauth.ts';
import {accessIdentity} from './access.ts';
import {verifyTotp} from './totp.ts';
import {cloudflareMfaOnly} from './auth-mode.ts';
import {revokeClientTokens} from './tokens.ts';
import {renderAdminLogin,renderAdminDocument,renderClientRow,renderPendingRow,renderConnectionRow,renderRunnerSection,renderServiceDirectoryCard} from './i18n/zh-CN.ts';
import {renderServiceAdminDocument} from './i18n/service-admin.ts';
import type {McpModule} from './gateway/types.ts';
import {adminProvisionRunner,adminRevokeRunner,listRunners} from './control/runner-registry.ts';
import {MCP_MODULES,MCP_SERVERS,toolPolicyId} from './gateway/registry.ts';

const COOKIE='__Host-gmcp-admin';
const locked=()=>html(renderAdminLogin({BRAND_HEAD,BRAND_NAME,BRAND_HEADER}));
function policyCatalog(env: Env) {
  const catalogEnv: Env={...env,GMC_WRITE_MODE:'approval',GMC_CONTENT_MODE:'enabled'};
  const policyAuth: McpAuth={clientId:'admin-catalog',scopes:['mcp:read','mcp:write'],allowedOwners:[],allowedResources:[],allowedTools:[]};
  return MCP_MODULES.map(module=>({
    id:module.id,
    description:module.description,
    resources:MCP_SERVERS.filter(server=>server.module.id===module.id).map(server=>({id:server.id,path:server.path,title:server.title})),
    tools:module.listTools(catalogEnv,policyAuth).map(tool=>({id:toolPolicyId(module.id,tool.name),name:tool.name,description:tool.description})),
  }));
}
function sessionKey(env: Env) { if(!env.MCP_COOKIE_KEY||env.MCP_COOKIE_KEY.length<32) throw new Error('MCP_COOKIE_KEY too short');return encoder.encode(env.MCP_COOKIE_KEY); }
async function sign(env: Env,body: string) {const key=await crypto.subtle.importKey('raw',sessionKey(env),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64u(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(body))));}
export async function getSession(request: Request,env: Env): Promise<AdminSession | null> {
  try {
    const [body,signature,extra]=(cookie(request,COOKIE)||'').split('.');if(!body||!signature||extra)return null;
    const decoded=JSON.parse(new TextDecoder().decode(unb64u(body))) as unknown;
    const accessSubject=await accessIdentity(request,env);
    if(!accessSubject)return null;
    if(!decoded || typeof decoded!=='object' || !('exp' in decoded) || !('csrf' in decoded) || !('sub' in decoded) || typeof decoded.exp!=='number')return null;
    if(!decoded.exp||decoded.exp<=now()||typeof decoded.csrf!=='string'||decoded.csrf.length!==43||decoded.sub!==accessSubject)return null;
    if(!(await equals(await sign(env,body),signature)))return null;
    return {exp: decoded.exp, csrf: decoded.csrf};
  }catch{return null;}
}
function redirect(path: string,headers: Record<string, string>={}){return new Response(null,{status:303,headers:{'Location':path,'Cache-Control':'no-store',...headers}});}
async function issueAdminSession(env: Env,subject: string): Promise<{session:AdminSession;cookie:string}> {
  const session: AdminSession={exp:now()+1800,csrf:randomId()};
  const body=b64u(encoder.encode(JSON.stringify({...session,sub:subject})));
  const value=body+'.'+await sign(env,body);
  return {session,cookie:`${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1800`};
}
export async function adminLogin(request: Request,env: Env): Promise<Response> {
  // Cloudflare MFA mode has no local password or OTP login endpoint.
  if(cloudflareMfaOnly(env)) return json({error:'Login is managed by Cloudflare Access'},405);
  if(!originOk(request))return json({error:'Forbidden'},403);
  if(!(await rateLimit(env,request,'admin-login',15)))return json({error:'Rate limited'},429);
  const subject=await accessIdentity(request,env);
  if(!subject)return json({error:'Cloudflare Access required'},403);
  const p=await form(request);
  if(!(await verifyTotp(env,request,p.get('totp_code')||'')))return html('<p>动态验证码错误、过期或已使用。</p>',403);
  const issued=await issueAdminSession(env,subject);
  return redirect('/admin',{'Set-Cookie':issued.cookie});
}
export async function adminPage(request: Request,env: Env,service?: McpModule): Promise<Response> {
  let session=await getSession(request,env);
  let sessionCookie: string|undefined;
  if(!session && cloudflareMfaOnly(env)){
    // Signed Access identity is still mandatory; the dedicated Admin cookie
    // binds a short-lived CSRF nonce and cannot replace Access authorization.
    const subject=await accessIdentity(request,env);
    if(!subject)return json({error:'Cloudflare Access required'},403);
    const issued=await issueAdminSession(env,subject);
    session=issued.session;
    sessionCookie=issued.cookie;
  }
  if(!session)return locked();
  if(service){
    const results=service.id==='github'
      ?(await env.MCP_DB.prepare('SELECT owner,owner_kind,enabled,updated_at FROM github_connections ORDER BY owner').all()).results||[]
      :[];
    const serviceRows=results.map(r=>renderConnectionRow(r,escapeHtml)).join('');
    return html(renderServiceAdminDocument({session,BRAND_HEAD,BRAND_NAME,BRAND_HEADER,
      service,rows:serviceRows}),200,sessionCookie?{'Set-Cookie':sessionCookie}:{});
  }
  const clients=(await env.MCP_DB.prepare('SELECT client_id,client_name,redirect_uris,approved,allowed_owners,allow_write,allowed_resources,allowed_tools FROM oauth_clients ORDER BY created_at DESC LIMIT 100').all()).results||[];
  const catalog=policyCatalog(env);
  const clientRows=clients.map(c=>renderClientRow(c,escapeHtml,catalog)).join('');
  const pending=(await env.MCP_DB.prepare("SELECT id,client_id,owner,repo,title,body,expires_at FROM approval_requests WHERE status='pending' AND expires_at>? ORDER BY created_at ASC LIMIT 50").bind(now()).all()).results||[];
  const pendingRows=pending.map(r=>renderPendingRow(r,escapeHtml)).join('');
  const runnerRows=(await listRunners(env)).map(r=>{
    const seen=r.observedAt?new Date(r.observedAt).toISOString().slice(0,19).replace('T',' ')+' UTC':'从未上报';
    const action=r.availability==='unavailable'
      ? '<span>已停用</span>'
      : `<button type="button" class="revoke-runner danger" data-runner="${escapeHtml(r.runnerId)}">撤销</button>`;
    return `<tr><td><strong>${escapeHtml(r.displayName)}</strong><div><code>${escapeHtml(r.runnerId)}</code></div></td><td>${escapeHtml(r.capabilities.join(', '))}</td><td>${r.activeConcurrency}/${r.maxConcurrency}</td><td>${escapeHtml(r.availability)}</td><td>${escapeHtml(seen)}</td><td>${action}</td></tr>`;
  }).join('');
  const serviceCards=MCP_MODULES.map(module=>renderServiceDirectoryCard(module,escapeHtml)).join('');
  const page=renderAdminDocument({session,BRAND_HEAD,BRAND_NAME,BRAND_HEADER,clientRows,pendingRows,serviceCards});
  const runnerSection=renderRunnerSection(runnerRows);
  return html(page.replace('</main>',runnerSection+'</main>'),200,
    sessionCookie?{'Set-Cookie':sessionCookie}:{});

}
async function guard(request: Request,env: Env): Promise<AdminSession | null> {
  const session=await getSession(request,env);if(!session||!originOk(request))return null;
  const csrf=request.headers.get('X-CSRF-Token')||'';
  return await equals(csrf,session.csrf)?session:null;
}
export async function adminApi(request: Request,env: Env,path: string): Promise<Response> {
  if(!(await getSession(request,env)))return json({error:'Unauthorized'},401);
  if(path==='/admin/api/public-key'&&request.method==='GET')return json(ingestionPublicJwk(env));
  if(path==='/admin/api/runners'&&request.method==='GET')return json({runners:await listRunners(env)});
  if(request.method!=='POST'||!await guard(request,env))return json({error:'Forbidden'},403);
  if(path==='/admin/api/runners/provision')return adminProvisionRunner(env,request);
  if(path==='/admin/api/runners/revoke')return adminRevokeRunner(env,request);
  if(path==='/admin/api/connections'){
    let data;try{data=await bodyJson(request,13000);}catch{return json({error:'Invalid request'},400);}
    if(!validOwner(data.owner)||(typeof data.kind!=='string'||!['User','Organization'].includes(data.kind)))return json({error:'Invalid owner or kind'},400);
    const owner=data.owner.toLowerCase();
    let token;
    try {token=await decryptIngested(env,data.encrypted);}catch{return json({error:'Unable to decrypt token'},400);}
    try {
      const [user, identity]=await Promise.all([
        apiFetch(token,'/user'),apiFetch(token,githubPath({owner,kind:'owner_identity'}))
      ]);
      if(!user?.login||identity?.type!==data.kind) return json({error:'Owner kind mismatch or invalid credential'},400);
    } catch(e) {return json({error:e instanceof PublicError?e.message:'Token validation failed'},400);}
    const sealed=await seal(env,owner,token);token=undefined;
    const ts=now();
    await env.MCP_DB.prepare(`INSERT INTO github_connections(owner,owner_kind,key_id,iv,ciphertext,enabled,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(owner) DO UPDATE SET owner_kind=excluded.owner_kind,key_id=excluded.key_id,iv=excluded.iv,ciphertext=excluded.ciphertext,enabled=1,updated_at=excluded.updated_at`).bind(owner,data.kind,sealed.key_id,sealed.iv,sealed.ciphertext,ts,ts).run();
    return json({ok:true,owner});
  }
  if(path==='/admin/api/status'||path==='/admin/api/delete'){
    let body;try{body=await bodyJson(request,1024);}catch{return json({error:'Invalid request'},400);}
    if(!validOwner(body.owner))return json({error:'Invalid owner'},400);
    if(path.endsWith('/delete')) await env.MCP_DB.prepare('DELETE FROM github_connections WHERE owner=?').bind(body.owner.toLowerCase()).run();
    else {
      if(typeof body.enabled!=='boolean')return json({error:'Invalid status'},400);
      await env.MCP_DB.prepare('UPDATE github_connections SET enabled=?,updated_at=? WHERE owner=?').bind(body.enabled?1:0,now(),body.owner.toLowerCase()).run();
    }
    return json({ok:true});
  }
  if(path==='/admin/api/client-delete'){
    let data;try{data=await bodyJson(request,1024);}catch{return json({error:'Invalid request'},400);}
    const clientId=data.clientId;
    if(typeof clientId!=='string'||!/^mcp_[A-Za-z0-9_-]{43}$/.test(clientId)||
      data.confirmClientId!==clientId)return json({error:'Confirm the exact client ID before deletion'},400);
    const client=await env.MCP_DB.prepare('SELECT client_id FROM oauth_clients WHERE client_id=?').bind(clientId).first();
    if(!client)return json({error:'Client not found'},404);
    // Do not delete a client while its approved write is still running.
    const processing=await env.MCP_DB.prepare("SELECT id FROM approval_requests WHERE client_id=? AND status='processing' LIMIT 1").bind(clientId).first();
    if(processing)return json({error:'A client write operation is still processing; retry after it completes'},409);
    // D1 executes this batch atomically, leaving no usable credentials after
    // deletion. Preserve historical write audit records, deny pending writes.
    await env.MCP_DB.batch([
      env.MCP_DB.prepare("UPDATE approval_requests SET status='denied' WHERE client_id=? AND status='pending'").bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_refresh_tokens WHERE client_id=?').bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_access_tokens WHERE client_id=?').bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_codes WHERE client_id=?').bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_auth_requests WHERE client_id=?').bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_grants WHERE client_id=?').bind(clientId),
      env.MCP_DB.prepare('DELETE FROM oauth_clients WHERE client_id=?').bind(clientId),
    ]);
    return json({ok:true,deleted:true});
  }
  if(path==='/admin/api/client-approval'){
    let data;try{data=await bodyJson(request,32768);}catch{return json({error:'Invalid request'},400);}
    if(typeof data.clientId!=='string'||data.clientId.length>100)return json({error:'Invalid client'},400);
    if(data.approved===false){
      await revokeClientTokens(env,data.clientId);
      await env.MCP_DB.prepare('UPDATE oauth_clients SET approved=0,allowed_owners=?,allow_write=0,allowed_resources=?,allowed_tools=?,auth_version=auth_version+1 WHERE client_id=?').bind('[]','[]','[]',data.clientId).run();
      return json({ok:true});
    }
    const catalog=policyCatalog(env);
    const validResources=new Map(MCP_SERVERS.map(server=>[server.id,server.module.id]));
    const toolModules=new Map(catalog.flatMap(module=>module.tools.map(tool=>[tool.id,module.id] as const)));
    const validTools=new Set(toolModules.keys());
    const allowedResources=data.allowedResources;
    const allowedTools=data.allowedTools;
    if(!Array.isArray(allowedResources)||allowedResources.length<1||allowedResources.length>50||allowedResources.some(x=>typeof x!=='string'||!validResources.has(x))||new Set(allowedResources).size!==allowedResources.length)return json({error:'Select one or more registered MCP Resources'},400);
    if(!Array.isArray(allowedTools)||allowedTools.length<1||allowedTools.length>500||allowedTools.some(x=>typeof x!=='string'||!validTools.has(x))||new Set(allowedTools).size!==allowedTools.length)return json({error:'Select one or more registered tools'},400);
    const resourceModules=new Set(allowedResources.map(id=>validResources.get(id)));
    if(allowedTools.some(id=>!resourceModules.has(toolModules.get(id) as string)))return json({error:'A tool requires an authorized Resource from the same MCP'},400);
    if(typeof data.allowWrite!=='boolean')return json({error:'Invalid write permission'},400);
    const githubTools=allowedTools.some(id=>toolModules.get(id)==='github');
    const allowed=data.allowedOwners;
    if(githubTools&&(!Array.isArray(allowed)||allowed.length<1||allowed.length>30||allowed.some(x=>!validOwner(x))))return json({error:'At least one valid GitHub Owner is required for GitHub tools'},400);
    const distinct=githubTools?[...new Set((allowed as string[]).map(x=>x.toLowerCase()))]:[];
    for(const owner of distinct){const exists=await env.MCP_DB.prepare('SELECT enabled FROM github_connections WHERE owner=?').bind(owner).first();if(!exists?.enabled)return json({error:'Owner missing or disabled: '+owner},400);}
    if(data.allowWrite&&!allowedTools.includes(toolPolicyId('github','github_create_issue')))return json({error:'Write permission requires the GitHub create issue tool'},400);
    // Any permission update invalidates the previous authorization grant family,
    // even if the client is later re-approved.
    await revokeClientTokens(env,data.clientId);
    const row=await env.MCP_DB.prepare('UPDATE oauth_clients SET approved=1,allowed_owners=?,allow_write=?,allowed_resources=?,allowed_tools=?,auth_version=auth_version+1 WHERE client_id=? RETURNING client_id').bind(JSON.stringify(distinct),data.allowWrite?1:0,JSON.stringify(allowedResources),JSON.stringify(allowedTools),data.clientId).first();
    if(!row)return json({error:'Client not found'},404);
    return json({ok:true});
  }
  if(path==='/admin/api/operation'){
    let data;try{data=await bodyJson(request,2048);}catch{return json({error:'Invalid request'},400);}
    if(typeof data.id!=='string'||!/^[a-zA-Z0-9_-]{43}$/.test(data.id)||typeof data.action!=='string'||!['approve','deny'].includes(data.action))return json({error:'Invalid operation'},400);
    if(data.action==='deny'){
      const row=await env.MCP_DB.prepare("UPDATE approval_requests SET status='denied' WHERE id=? AND status='pending' RETURNING id").bind(data.id).first();
      return row?json({ok:true,status:'denied'}):json({error:'Request already handled'},409);
    }
    if(env.GMC_WRITE_MODE!=='approval')return json({error:'Write operations disabled in Worker configuration'},403);
    const req=await env.MCP_DB.prepare("SELECT r.* FROM approval_requests r JOIN oauth_clients c ON r.client_id=c.client_id WHERE r.id=? AND r.status='pending' AND r.expires_at>? AND c.approved=1 AND c.allow_write=1").bind(data.id,now()).first();
    if(!req)return json({error:'Request not eligible for approval'},409);
    const client=await env.MCP_DB.prepare('SELECT allowed_owners FROM oauth_clients WHERE client_id=?').bind(req.client_id).first();
    if(!client||!JSON.parse(client.allowed_owners).includes(req.owner))return json({error:'Client lost owner permission'},403);
    const claimed=await env.MCP_DB.prepare("UPDATE approval_requests SET status='processing' WHERE id=? AND status='pending' AND expires_at>? RETURNING id").bind(data.id,now()).first();
    if(!claimed)return json({error:'Request already handled'},409);
    try {
      const token=await getOwnerToken(env,req.owner);
      const path=githubPath({owner:req.owner,repo:req.repo,kind:'repo'});
      const response=await apiFetch(token,path+'/issues',{method:'POST',body:{title:req.title,body:req.body}});
      const result={number:response.number,title:response.title,url:response.html_url};
      await env.MCP_DB.prepare("UPDATE approval_requests SET status='approved',result_json=? WHERE id=? AND status='processing'").bind(JSON.stringify(result),req.id).run();
      return json({ok:true,status:'approved',result});
    } catch {
      // Do not automatically retry a non-idempotent GitHub write operation.
      await env.MCP_DB.prepare("UPDATE approval_requests SET status='failed' WHERE id=? AND status='processing'").bind(req.id).run();
      return json({error:'Approval action failed. Check GitHub before retrying.'},502);
    }
  }
  if(path==='/admin/api/rekey'){
    const {results=[]}=await env.MCP_DB.prepare('SELECT * FROM github_connections WHERE key_id<>? LIMIT 50').bind(env.MCP_ACTIVE_ID).all();
    for(const row of results) {
      const token=await unseal(env,row);const sealed=await seal(env,row.owner,token);
      await env.MCP_DB.prepare('UPDATE github_connections SET key_id=?,iv=?,ciphertext=?,updated_at=? WHERE owner=? AND key_id=?').bind(sealed.key_id,sealed.iv,sealed.ciphertext,now(),row.owner,row.key_id).run();
    }
    const remaining=await env.MCP_DB.prepare('SELECT COUNT(*) AS cnt FROM github_connections WHERE key_id<>?').bind(env.MCP_ACTIVE_ID).first();
    return json({ok:true,processed:results.length,remaining:remaining?.cnt??0});
  }
  return json({error:'Not found'},404);
}
export async function adminRoute(request: Request,env: Env): Promise<Response> {
  const path=new URL(request.url).pathname;
  if(path==='/admin/app.js'&&request.method==='GET')return new Response(ADMIN_SCRIPT,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(path==='/admin/app.css'&&request.method==='GET')return new Response(ADMIN_CSS,{headers:{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(path==='/admin/login'&&request.method==='POST')return adminLogin(request,env);
  if(path==='/admin/logout'&&request.method==='POST'){
    if(!originOk(request))return json({error:'Forbidden'},403);
    const p=await form(request);const s=await getSession(request,env);
    if(!s||!(await equals(p.get('csrf')||'',s.csrf)))return json({error:'Forbidden'},403);
    // Without a local login form, logging out must also clear the Access
    // session or the next GET would silently create a new local session.
    return redirect(cloudflareMfaOnly(env)?'/cdn-cgi/access/logout':'/admin',
      {'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});
  }
  if(path==='/admin'&&request.method==='GET')return adminPage(request,env);
  if(path.startsWith('/admin/api/'))return adminApi(request,env,path);
  return json({error:'Not found'},404);
}
