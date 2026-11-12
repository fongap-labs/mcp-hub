import type {DbRow, AdminSession} from '../types.ts';
import type {McpServer} from '../gateway/types.ts';
// Human-facing Chinese copy and HTML templates; no token values are embedded here.
export const GATEWAY_DISCLAIMER = 'GitHub 模块由 Fongap Labs 独立开发，非 GitHub 官方 MCP Server';
export const OAUTH_TITLE = 'MCP 连接授权';
export const OAUTH_DENIED_TITLE = '认证失败';
export const OAUTH_DENIED_BODY = '<p>动态验证码错误、过期或已使用。</p>';

// This copy is shown only when Cloudflare Access authentication did not pass.
// It deliberately does not attempt a Worker-side Access login or grant access.
export function renderAccessDenied(isMfaOnly=false): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Hub · 身份验证未完成</title></head><body><main>
<h1>需要 Cloudflare Access 身份验证</h1>
<p>${isMfaOnly?'请先完成 Cloudflare 账号登录及 Cloudflare Access 双因素验证。':'请先完成 Cloudflare Access 登录，然后再输入手机验证器的 6 位动态验证码。'}</p>
<p>若已经登录仍看到此页面，请联系管理员检查 Access 应用的路径范围和 Audience（AUD）配置。</p>
<p><a href="/admin">重新检查管理后台登录</a></p>
</main></body></html>`;
}

export const ADMIN_BROWSER_COPY = {
  missingPublicKey: '无法取得加密公钥',
  requestFailed: '操作失败',
  saved: '已保存 ',
  deletePrefix: '确定删除 ',
  deleteSuffix: ' 的连接？此操作无法撤销。',
  allowWriteConfirm: '确认同时开启 GitHub 写权限？写操作仍需管理员逐项审批。',
  permissionsRequired: '至少选择一个 Resource 和一个工具',
  revokeClientConfirm: '立即撤销该客户端全部权限？',
  approveOperationConfirm: '确认人工审批并立即在 GitHub 执行该写操作？请先核对仓库和内容。',
  rekeyConfirm: '确认已同时配置旧密钥和新密钥？',
  rekeyPrefix: '已迁移 ',
  rekeyInfix: ' 条，剩余 ',
  rekeySuffix: ' 条',
};
export function renderAdminLogin({BRAND_HEAD,BRAND_NAME,BRAND_HEADER}: {BRAND_HEAD:string;BRAND_NAME:string;BRAND_HEADER:string}){return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${BRAND_HEAD}<title>${BRAND_NAME} · 管理登录</title><link rel="stylesheet" href="/admin/app.css"><main>${BRAND_HEADER}<h2>管理登录</h2><p>请先通过 Cloudflare Access 验证身份，再输入验证器 App 中的 6 位动态码。</p><form method="post" action="/admin/login"><label>6 位动态验证码<input name="totp_code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required></label><button>登录</button></form></main></html>`;}
function policyList(value: unknown): string[]{try{const parsed=JSON.parse(String(value));return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[]}catch{return [];}}
export function renderClientRow(c: DbRow,escapeHtml: (s: unknown)=>string,catalog: Array<{id:string;description:string;resources:Array<{id:string;path:string;title:string}>;tools:Array<{id:string;name:string;description:string}>}>){
  const resources=new Set(policyList(c.allowed_resources)),tools=new Set(policyList(c.allowed_tools));
  const moduleOptions=catalog.map(module=>`<fieldset><legend>${escapeHtml(module.id)} MCP</legend><div class="policy-label">授权 Resource</div>${module.resources.map(resource=>`<label class="policy-option"><input class="resource-grant" type="checkbox" value="${escapeHtml(resource.id)}"${resources.has(resource.id)?' checked':''}>${escapeHtml(resource.title)} <code>${escapeHtml(resource.path||'/')}</code></label>`).join('')}<div class="policy-label">授权工具</div>${module.tools.map(tool=>`<label class="policy-option"><input class="tool-grant" type="checkbox" value="${escapeHtml(tool.id)}"${tools.has(tool.id)?' checked':''}><span><strong>${escapeHtml(tool.name)}</strong><span class="muted"> · ${escapeHtml(tool.description)}</span></span></label>`).join('')||'<p class="muted">当前无可授权工具</p>'}</fieldset>`).join('');
  return `<tr><td>${escapeHtml(c.client_name)}<div class="muted"><code>${escapeHtml(c.client_id)}</code></div></td><td>${escapeHtml(JSON.parse(String(c.redirect_uris)).join(', '))}</td><td>${c.approved?'已批准':'待批准'}</td><td>${escapeHtml(policyList(c.allowed_owners).join(', ')||'无')}</td><td><details><summary>设置权限</summary><form class="client-policy" data-client="${escapeHtml(c.client_id)}"><label>允许访问的 GitHub Owner（英文逗号分隔）<input class="client-owners" type="text" value="${escapeHtml(policyList(c.allowed_owners).join(', '))}" placeholder="仅授权 GitHub 工具时填写"></label><label class="policy-option"><input class="client-write" type="checkbox"${c.allow_write?' checked':''}>允许 GitHub 创建 Issue（仍需人工审批）</label>${moduleOptions}<button type="submit">保存权限并撤销旧令牌</button></form></details> <button type="button" class="revoke-client danger" data-client="${escapeHtml(c.client_id)}">撤销</button></td></tr>`;
}
export function renderPendingRow(r: DbRow,escapeHtml: (s: unknown)=>string){return `<tr><td>${escapeHtml(r.owner+'/'+r.repo)}</td><td><strong>${escapeHtml(r.title)}</strong><div class="muted">${escapeHtml(r.body.slice(0,300))}</div></td><td>${escapeHtml(new Date(r.expires_at*1000).toISOString().slice(11,19))} UTC</td><td><button type="button" class="approve-operation" data-operation="${escapeHtml(r.id)}">审批执行</button> <button type="button" class="deny-operation danger" data-operation="${escapeHtml(r.id)}">拒绝</button></td></tr>`;}
export function renderConnectionRow(r: DbRow,escapeHtml: (s: unknown)=>string){return `<tr><td>${escapeHtml(r.owner)}</td><td>${escapeHtml(r.owner_kind)}</td><td>${r.enabled?'启用':'停用'}</td><td>${new Date(r.updated_at*1000).toISOString().slice(0,10)}</td><td><button type="button" class="toggle" data-owner="${escapeHtml(r.owner)}" data-enabled="${r.enabled?'0':'1'}">${r.enabled?'停用':'启用'}</button> <button type="button" class="delete danger" data-owner="${escapeHtml(r.owner)}">删除</button></td></tr>`;}
export function renderAdminDocument(
  {session,BRAND_HEAD,BRAND_NAME,BRAND_HEADER,clientRows,pendingRows,serviceCards}:
  {session:AdminSession;BRAND_HEAD:string;BRAND_NAME:string;BRAND_HEADER:string;
    clientRows:string;pendingRows:string;serviceCards:string}
) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${session.csrf}">${BRAND_HEAD}
    <title>${BRAND_NAME} · 管理中心</title>
    <link rel="stylesheet" href="/admin/app.css"></head><body>
    <main class="admin-shell"><header>${BRAND_HEADER}
      <form id="logout" method="post" action="/admin/logout">
        <input type="hidden" name="csrf" value="${session.csrf}">
        <button class="secondary">退出登录</button>
      </form></header>
    <div class="section-heading"><h2>Hub 管理中心</h2>
      <p>集中管理已接入的 MCP 服务、OAuth 客户端、人工审批和 Runner。各服务账号凭据在对应服务的独立管理页面配置。</p></div>
    <section class="panel"><h2>服务管理</h2>
      <div class="service-directory">${serviceCards||'<p>尚未注册服务模块</p>'}</div>
    </section>
    <section class="panel"><h2>授权 MCP 客户端</h2>
      <p>新客户端默认没有权限。逐项选择允许访问的 Resource 与工具；使用 GitHub 工具时还需指定 Owner。修改权限会吊销旧令牌。</p>
      <div class="table-wrap"><table><thead><tr><th>客户端</th><th>回调 URI</th><th>状态</th><th>获授权 Owner</th><th>操作</th></tr></thead>
      <tbody>${clientRows||'<tr><td colspan="5">尚无 MCP 客户端注册</td></tr>'}</tbody></table></div>
      <p class="muted">未获授权的服务和工具无法通过 OAuth 或 MCP 路由访问。</p>
    </section>
    <section class="panel"><h2>写操作人工审批</h2>
      <p>GitHub 写操作必须由管理员逐项审批；过期请求不会执行。</p>
      <div class="table-wrap"><table><thead><tr><th>仓库</th><th>操作内容</th><th>到期</th><th>审批</th></tr></thead>
      <tbody>${pendingRows||'<tr><td colspan="4">暂无待审批写操作</td></tr>'}</tbody></table></div>
    </section>
    <section class="panel"><h2>加密密钥轮换</h2>
      <p>密钥保存在受控运行环境。仅确认旧版本和新版本密钥均可读取后才执行迁移。</p>
      <button type="button" id="rekey" class="secondary">迁移旧密钥加密的数据</button>
    </section>
    <p id="result" role="status" aria-live="polite"></p>
    <p class="muted">管理员会话有效期为 30 分钟。请勿在 MCP 工具参数、AI 对话或日志中传递凭据。</p>
    </main><script src="/admin/app.js" defer></script></body></html>`;
}
export function renderRunnerSection(runnerRows: string) {
  return `<h2>Runner 注册表与资源租约</h2><p>凭据由 Hub 签发且只显示一次。管理员限定 Runner 能力和并发上限；撤销会停用凭据并释放该 Runner 的 Hub 租约。</p><table><thead><tr><th>Runner</th><th>能力</th><th>活动并发 / 上限</th><th>状态</th><th>最近心跳</th><th>操作</th></tr></thead><tbody>${runnerRows||'<tr><td colspan="6">尚未注册 Runner</td></tr>'}</tbody></table><form id="runner-add"><label>Runner 名称<input name="displayName" maxlength="80" required></label><label>允许能力（英文逗号分隔）<input name="capabilities" placeholder="coding.patch,coding.test" required></label><label>最大并发<input name="maxConcurrency" type="number" min="1" max="128" value="1" required></label><button>签发注册凭据</button></form>`;
}

export function renderOAuthForm({escapeHtml,client,redirectUri,allowedOwners,id,allowWrite,server,grantedTools,requireTotp=true}: {escapeHtml:(s:unknown)=>string;client:DbRow;redirectUri:string;allowedOwners:string[];id:string;allowWrite:boolean;server:McpServer;grantedTools:string[];requireTotp?:boolean}){return `<p>客户端 <strong>${escapeHtml(client.client_name)}</strong> 申请连接 <strong>${escapeHtml(server.title)}</strong>。</p><p>OAuth Resource：<code>${escapeHtml(server.resourcePath||'/')}</code> · 回调地址：<code>${escapeHtml(redirectUri)}</code></p><p>此客户端已获准使用的工具：<strong>${escapeHtml(grantedTools.join(', ')||'无')}</strong></p>${allowedOwners.length?`<p>已授权的 GitHub Owner：<strong>${escapeHtml(allowedOwners.join(', '))}</strong>。GitHub Token 不会交给客户端。</p>`:''}<p>只授予本次明确选择的权限。</p><form method="post" action="/authorize"><input type="hidden" name="request_id" value="${id}">${requireTotp?'<label>6 位动态验证码<input name="totp_code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" required></label>':'<p>Cloudflare Access 已完成身份验证和 MFA，请确认本次客户端授权。</p>'}<label><input type="checkbox" name="read" checked disabled> 读取此 MCP 中已授权的工具</label>${allowWrite?'<label><input type="checkbox" name="allow_write" value="yes"> 允许 GitHub 写操作（需管理员逐项审批）</label>':''}<button type="submit">授权此客户端</button></form><p class="muted">如不认识此客户端，请关闭页面，不要授权。</p>`;}
