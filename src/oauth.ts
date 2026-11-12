import type { Env, McpAuth } from './types.ts';
import type { McpServer } from './gateway/registry.ts';
import {baseOrigin,resourceForServer,serverForResource} from './gateway/registry.ts';
import {renderOAuthForm,OAUTH_TITLE,OAUTH_DENIED_TITLE,OAUTH_DENIED_BODY} from './i18n/zh-CN.ts';
import {now,json,html,escapeHtml,randomId,sha,equals,cookie,originOk,form,bodyJson} from './util.ts';
import {issueAuthorizationTokens,rotateRefreshToken,revokeOAuthToken,cleanOAuthGrants} from './tokens.ts';
import {BRAND_NAME,BRAND_HEAD,BRAND_HEADER} from './brand.ts';
import {verifyTotp} from './totp.ts';
import {cloudflareMfaOnly} from './auth-mode.ts';
import {accessIdentity} from './access.ts';

const SCOPES=['mcp:read','mcp:write'];
const BIND='__Host-mcp-auth-binding';
const b64urlRe=/^[A-Za-z0-9_-]{43}$/;
const sanitizeName=(s: unknown)=>typeof s==='string' ? s.slice(0,100) : '';
const oauthError=(error: string,status=400)=>json({error},status);
export function resource(env: Env, server: McpServer): string { return resourceForServer(env,server); }
function policyList(value: unknown): string[] {
  try {
    const parsed=JSON.parse(String(value));
    return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];
  } catch { return []; }
}
export function protectedMetadata(env: Env, server: McpServer) {return json({resource:resource(env,server),authorization_servers:[baseOrigin(env)],scopes_supported:['mcp:read']});}
export function serverMetadata(env: Env) {const base=baseOrigin(env);return json({issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/oauth/token',registration_endpoint:base+'/oauth/register',revocation_endpoint:base+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:SCOPES});}
export function challenge(env: Env, server: McpServer) {return json({error:'Authentication required'},401,{'WWW-Authenticate':'Bearer resource_metadata="'+baseOrigin(env)+server.metadataPath+'", scope="mcp:read"'});}
function validRedirect(value: unknown): value is string {
  if(typeof value!=='string'||value.length>1024) return false;
  try {
    const u=new URL(value);
    if(u.username||u.password||u.hash) return false;
    if(u.protocol==='https:') return true;
    return u.protocol==='http:'&&['localhost','127.0.0.1','[::1]','::1'].includes(u.hostname);
  } catch {return false;}
}
function validClientName(s: unknown): s is string {return typeof s==='string'&&s.length>=1&&s.length<=100&& !/[\r\n\x00-\x1f]/.test(s);}
export async function rateLimit(env: Env,request: Request,kind: string,max=30): Promise<boolean> {
  const ip=request.headers.get('CF-Connecting-IP')||'local';
  const ts=Math.floor(now()/3600);const bucket=await sha(kind+':'+ip+':'+ts);
  const row=await env.MCP_DB.prepare('INSERT INTO rate_limits(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits').bind(bucket,(ts+2)*3600).first();
  return (row?.hits||999999)<=max;
}
export async function registerClient(request: Request,env: Env): Promise<Response> {
  if(!(await rateLimit(env,request,'oauth-register',15))) return oauthError('rate_limited',429);
  let body;try{body=await bodyJson(request,4096);}catch{return oauthError('invalid_client_metadata');}
  if(body.token_endpoint_auth_method && body.token_endpoint_auth_method!=='none')return oauthError('invalid_client_metadata');
  if(!validClientName(body.client_name)||!Array.isArray(body.redirect_uris)||body.redirect_uris.length<1||body.redirect_uris.length>8||!body.redirect_uris.every(validRedirect)) return oauthError('invalid_redirect_uri');
  const requestedGrants=body.grant_types===undefined?['authorization_code']:body.grant_types;
  if(!Array.isArray(requestedGrants)||!requestedGrants.includes('authorization_code')||
     new Set(requestedGrants).size!==requestedGrants.length||
     requestedGrants.some(g=>!['authorization_code','refresh_token'].includes(g)))return oauthError('invalid_client_metadata');
  const clientId='mcp_'+randomId();
  await env.MCP_DB.prepare('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,grant_types,created_at) VALUES(?,?,?,?,?)')
    .bind(clientId,body.client_name,JSON.stringify(body.redirect_uris),JSON.stringify(requestedGrants),now()).run();
  return json({client_id:clientId,client_name:body.client_name,redirect_uris:body.redirect_uris,grant_types:requestedGrants,response_types:['code'],token_endpoint_auth_method:'none'},201);
}
function errorPage(){return html('<!doctype html><meta charset="utf-8"><title>Invalid request</title><p>Authorization request rejected.</p>',400);}
const page=(title: string,body: string)=>`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${BRAND_HEAD}<title>${BRAND_NAME} · ${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/app.css"><main>${BRAND_HEADER}<h2>${escapeHtml(title)}</h2>${body}</main></html>`;
export async function authorizeGet(request: Request,env: Env): Promise<Response> {
  if(!(await rateLimit(env,request,'oauth-authorize',60)))return errorPage();
  const u=new URL(request.url);const p=u.searchParams;
  const clientId=p.get('client_id')||'';const redirectUri=p.get('redirect_uri')||'';
  const client=await env.MCP_DB.prepare('SELECT client_name,redirect_uris,approved,allowed_owners,allow_write,allowed_resources,allowed_tools,auth_version FROM oauth_clients WHERE client_id=?').bind(clientId).first();
  if(!client || !JSON.parse(client.redirect_uris).includes(redirectUri) || !validRedirect(redirectUri)) return errorPage();
  if(!client.approved) return html(page('客户端待批准', '<p>此 MCP 客户端尚未获得管理员批准。</p><p>请打开 <a href="/admin">管理后台</a>，在“授权 MCP 客户端”中批准该客户端，并选择对应的 GitHub Owner、Resource 和工具。保存后重新连接。</p>'),400);
  const state=p.get('state')||'';const codeChallenge=p.get('code_challenge')||'';
  const asked=(p.get('scope')||'mcp:read').trim().split(/\s+/);
  const requestedResource=p.get('resource') ?? '';
  const server=serverForResource(env,requestedResource);
  if(p.get('response_type')!=='code'||state.length>1024||!b64urlRe.test(codeChallenge)||p.get('code_challenge_method')!=='S256'||!asked.includes('mcp:read')||asked.some(s=>!SCOPES.includes(s))||!server||!policyList(client.allowed_resources).includes(server.id)) return errorPage();
  const bind=randomId(), id=randomId();
  await env.MCP_DB.prepare('INSERT INTO oauth_auth_requests(id_hash,cookie_hash,client_id,redirect_uri,resource,scope,state,code_challenge,expires_at,auth_version) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(await sha(id),await sha(bind),clientId,redirectUri,requestedResource,asked.join(' '),state,codeChallenge,now()+600,client.auth_version).run();
  const toolPrefix=encodeURIComponent(server.module.id)+':';
  const grantedTools=policyList(client.allowed_tools).flatMap(tool=>{
    if(!tool.startsWith(toolPrefix))return [];
    try{return [decodeURIComponent(tool.slice(toolPrefix.length))];}catch{return [];}
  });
  const body=renderOAuthForm({escapeHtml,client,redirectUri,allowedOwners:JSON.parse(client.allowed_owners),id,allowWrite:asked.includes('mcp:write'),server,grantedTools,requireTotp:!cloudflareMfaOnly(env)});
  return html(page(OAUTH_TITLE,body),200,{'Set-Cookie':`${BIND}=${bind}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`});
}
export async function authorizePost(request: Request,env: Env): Promise<Response> {
  if(!originOk(request))return errorPage();
  if(!(await rateLimit(env,request,'oauth-approval-attempt',15))) return errorPage();
  let p;try{p=await form(request);}catch{return errorPage();}
  const id=p.get('request_id')||''; if(!b64urlRe.test(id))return errorPage();
  const row=await env.MCP_DB.prepare('SELECT * FROM oauth_auth_requests WHERE id_hash=?').bind(await sha(id)).first();
  if(!row||row.expires_at<=now()||!(await equals(row.cookie_hash,await sha(cookie(request,BIND)))))return errorPage();
  if(cloudflareMfaOnly(env)){
    // The index route also enforces Access; check again here to avoid a
    // direct-call bypass in any future route refactor.
    if(!(await accessIdentity(request,env)))return html(page(OAUTH_DENIED_TITLE,OAUTH_DENIED_BODY),403);
  }else if(!(await verifyTotp(env,request,p.get('totp_code')||''))){
    return html(page(OAUTH_DENIED_TITLE,OAUTH_DENIED_BODY),403);
  }
  const consumed=await env.MCP_DB.prepare('DELETE FROM oauth_auth_requests WHERE id_hash=? RETURNING id_hash').bind(await sha(id)).first(); if(!consumed)return errorPage();
  const scopes=['mcp:read']; const client=await env.MCP_DB.prepare('SELECT approved,allow_write,auth_version FROM oauth_clients WHERE client_id=?').bind(row.client_id).first();
  if(!client?.approved||client.auth_version!==row.auth_version)return errorPage();
  if(row.scope.split(' ').includes('mcp:write')&&client.allow_write===1&&p.get('allow_write')==='yes') scopes.push('mcp:write');
  const code=randomId();
  await env.MCP_DB.prepare('INSERT INTO oauth_codes(code_hash,client_id,redirect_uri,resource,scope,code_challenge,expires_at,auth_version) VALUES(?,?,?,?,?,?,?,?)').bind(await sha(code),row.client_id,row.redirect_uri,row.resource,scopes.join(' '),row.code_challenge,now()+90,client.auth_version).run();
  const dest=new URL(row.redirect_uri);dest.searchParams.set('code',code);if(row.state)dest.searchParams.set('state',row.state);dest.searchParams.set('iss',baseOrigin(env));
  return new Response(null,{status:302,headers:{'Location':dest.toString(),'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':`${BIND}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`}});
}
export async function tokenEndpoint(request: Request,env: Env): Promise<Response> {
  if(!(await rateLimit(env,request,'oauth-token',600))) return oauthError('rate_limited',429);
  let p;try{p=await form(request);}catch{return oauthError('invalid_request');}
  const grantType=p.get('grant_type');
  if(grantType==='refresh_token')return rotateRefreshToken(env,p);
  if(grantType!=='authorization_code')return oauthError('unsupported_grant_type');
  const code=p.get('code')||'', clientId=p.get('client_id')||'', verifier=p.get('code_verifier')||'';
  if(!b64urlRe.test(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))return oauthError('invalid_grant');
  // A consumed authorization code cannot be redeemed a second time.
  const row=await env.MCP_DB.prepare('DELETE FROM oauth_codes WHERE code_hash=? RETURNING *').bind(await sha(code)).first();
  if(!row||row.expires_at<=now()||row.client_id!==clientId||row.redirect_uri!==p.get('redirect_uri')||row.resource!==p.get('resource')||!serverForResource(env,row.resource)||!(await equals(row.code_challenge,await sha(verifier))))return oauthError('invalid_grant');
  const client=await env.MCP_DB.prepare('SELECT approved,allow_write,grant_types,auth_version FROM oauth_clients WHERE client_id=?').bind(clientId).first();
  if(!client?.approved||client.auth_version!==row.auth_version)return oauthError('invalid_grant');
  return issueAuthorizationTokens(env,row,client);
}
export async function revokeToken(request: Request,env: Env): Promise<Response>{
  if(!(await rateLimit(env,request,'oauth-revoke',300)))return oauthError('rate_limited',429);
  let p;try{p=await form(request);}catch{return oauthError('invalid_request');}
  const token=p.get('token')||'';
  if(token.length>0&&token.length<=256)await revokeOAuthToken(env,token,p.get('client_id'));
  // RFC 7009: do not disclose whether the submitted token existed.
  return new Response(null,{status:200,headers:{'Cache-Control':'no-store','Pragma':'no-cache'}});
}
export async function validateMcpToken(request: Request,env: Env,server: McpServer): Promise<McpAuth | null> {
  const value=request.headers.get('Authorization')||'';
  const matched=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);if(!matched)return null;
  const row=await env.MCP_DB.prepare(`SELECT t.client_id,t.resource,t.scope,t.expires_at,t.grant_id,t.auth_version AS token_auth_version,
    c.approved,c.allowed_owners,c.allow_write,c.allowed_resources,c.allowed_tools,c.auth_version AS client_auth_version,g.revoked_at AS grant_revoked_at,g.absolute_expires_at,g.scope AS grant_scope
    FROM oauth_access_tokens t JOIN oauth_clients c ON t.client_id=c.client_id
    LEFT JOIN oauth_grants g ON t.grant_id=g.grant_id WHERE t.token_hash=?`)
    .bind(await sha(matched[1] ?? '')).first();
  if(!row||!row.approved||row.token_auth_version!==row.client_auth_version||row.expires_at<=now()||row.resource!==resource(env,server)||
    !policyList(row.allowed_resources).includes(server.id)||
    (row.grant_id!==null&&(row.absolute_expires_at===null||row.absolute_expires_at<=now()||row.grant_revoked_at!==null)))return null;
  const grants=new Set((row.grant_scope??row.scope).split(' '));
  const scopes=row.scope.split(' ').filter(s=>grants.has(s)&&(s!=='mcp:write'||row.allow_write===1));
  return {clientId:row.client_id,scopes,allowedOwners:JSON.parse(row.allowed_owners),allowedResources:policyList(row.allowed_resources),allowedTools:policyList(row.allowed_tools)};
}
export async function cleanExpired(env: Env): Promise<void> {
  const ts=now();
  for(const table of ['oauth_codes','oauth_auth_requests','oauth_access_tokens','rate_limits']) await env.MCP_DB.prepare('DELETE FROM '+table+' WHERE expires_at<?').bind(ts).run();
  await cleanOAuthGrants(env);
  await env.MCP_DB.prepare('DELETE FROM approval_requests WHERE (status=\'pending\' AND expires_at<?) OR (status<>\'pending\' AND created_at<?)').bind(ts,ts-7*86400).run();
  await env.MCP_DB.prepare('DELETE FROM oauth_clients WHERE approved=0 AND client_id NOT IN (SELECT client_id FROM oauth_codes UNION SELECT client_id FROM oauth_auth_requests UNION SELECT client_id FROM oauth_access_tokens) AND created_at<?').bind(ts-30*86400).run();
}
