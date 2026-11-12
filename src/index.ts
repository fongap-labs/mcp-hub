import type { Env } from './types.ts';
import {json,html} from './util.ts';
import {BRAND_ICON} from './brand.ts';
import {accessIdentity} from './access.ts';
import {cloudflareMfaOnly} from './auth-mode.ts';
import {renderAccessDenied} from './i18n/zh-CN.ts';
import {protectedMetadata,serverMetadata,registerClient,authorizeGet,authorizePost,tokenEndpoint,revokeToken,validateMcpToken,challenge,cleanExpired} from './oauth.ts';
import {adminRoute} from './admin.ts';
import {serverForPath,serverForMetadata} from './gateway/registry.ts';
import {processMcp} from './gateway/router.ts';
import {heartbeatRunner,registerRunner} from './control/runner-registry.ts';
import {acceptRunnerDispatch,cancelDispatch,consumeDispatchQueue,createDispatch,getDispatchStatus,maintainDispatches,
  nextRunnerDispatch,reconcileDispatch,renewRunnerDispatch,rejectRunnerDispatch,reportRunnerQuota} from './control/dispatch.ts';

// Browser navigations get an actionable message rather than raw JSON. API
// clients retain their existing JSON error contract. Authentication remains
// fail-closed and this response never starts a new login session.
function accessDenied(request: Request,mfaOnly: boolean): Response {
  const accept=request.headers.get('Accept')||'';
  if(request.method!=='GET'||!accept.includes('text/html')) {
    return json({error:'Cloudflare Access required'},403);
  }
  return html(renderAccessDenied(mfaOnly),403);
}

export default {
  async fetch(request: Request,env: Env): Promise<Response> {
    try {
      const url=new URL(request.url), path=url.pathname;
      if(path==='/brand/icon.svg'&&request.method==='GET')return new Response(BRAND_ICON,{headers:{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'public, max-age=86400','X-Content-Type-Options':'nosniff'}});
      if(path==='/health'&&request.method==='GET'){
        const ready=Boolean(env.MCP_DB && env.MCP_PUBLIC_URL && env.MCP_ACCESS_ISSUER && env.MCP_ACCESS_AUD && (cloudflareMfaOnly(env)||env.MCP_TOTP_SECRET) && env.MCP_COOKIE_KEY && env.MCP_KEYRING_JSON && env.MCP_ACTIVE_ID && env.MCP_INGEST_JWK);
        return json({status:ready?'ok':'unavailable',ready,build:env.MCP_BUILD_SHA||null,
          dispatchEnabled:Boolean(env.MCP_RUNTIME_KEY&&env.MCP_RUNTIME_KEY.length>=32&&env.MCP_DISPATCH_QUEUE)},ready?200:503);
      }
      // Cloudflare Access protects browser routes; local TOTP remains the
      // default until independent Access MFA has been verified and activated.
      if(path==='/authorize'||path==='/admin'||path.startsWith('/admin/')){
        const mfaOnly=cloudflareMfaOnly(env);
        if(!(await accessIdentity(request,env)))return accessDenied(request,mfaOnly);
      }
      const metadataServer=serverForMetadata(path);
      if(metadataServer)return protectedMetadata(env,metadataServer);
      if(path==='/.well-known/oauth-authorization-server')return serverMetadata(env);
      if(path==='/oauth/register'&&request.method==='POST')return registerClient(request,env);
      if(path==='/oauth/token'&&request.method==='POST')return tokenEndpoint(request,env);
      if(path==='/oauth/revoke'&&request.method==='POST')return revokeToken(request,env);
      if(path==='/runner/register'&&request.method==='POST')return registerRunner(request,env);
      if(path==='/runner/heartbeat'&&request.method==='POST')return heartbeatRunner(request,env);
      if(path==='/runner/quota'&&request.method==='POST')return reportRunnerQuota(request,env);
      if(path==='/runner/dispatches/next'&&request.method==='GET')return nextRunnerDispatch(request,env);
      if(path==='/runner/dispatches/accept'&&request.method==='POST')return acceptRunnerDispatch(request,env);
      if(path==='/runner/dispatches/reject'&&request.method==='POST')return rejectRunnerDispatch(request,env);
      if(path==='/runner/dispatches/renew'&&request.method==='POST')return renewRunnerDispatch(request,env);
      if(path==='/control/dispatch'&&request.method==='POST')return createDispatch(request,env);
      if(path==='/control/dispatch'&&request.method==='GET')return getDispatchStatus(request,env);
      if(path==='/control/dispatch/cancel'&&request.method==='POST')return cancelDispatch(request,env);
      if(path==='/control/dispatch/reconcile'&&request.method==='POST')return reconcileDispatch(request,env);
      if(path==='/authorize')return request.method==='GET'?authorizeGet(request,env):request.method==='POST'?authorizePost(request,env):json({error:'Method not allowed'},405);
      if(path.startsWith('/admin'))return adminRoute(request,env);
      const mcpServer=serverForPath(path);
      if(mcpServer){
        const auth=await validateMcpToken(request,env,mcpServer);
        if(!auth)return challenge(env,mcpServer);
        return processMcp(request,env,auth,mcpServer);
      }
      return json({error:'Not found'},404);
    } catch {
      // Do not log or return thrown errors. Raw exceptions can contain sensitive data.
      return json({error:'Internal error'},500);
    }
  },
  async queue(batch: Parameters<typeof consumeDispatchQueue>[0],env: Env): Promise<void> {
    await consumeDispatchQueue(batch,env);
  },
  async scheduled(event: {cron?:string},env: Env): Promise<void> {
    if(event.cron==='* * * * *') { try{await maintainDispatches(env);}catch{/* D1 outbox retries on the next tick. */} }
    if(event.cron==='0 4 * * *'||!event.cron) { try{await cleanExpired(env);}catch{/* No credentials or raw errors in logs. */} }
  }
};
