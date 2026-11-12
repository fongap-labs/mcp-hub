import type {AdminSession} from './types.ts';
import type {McpModule} from './gateway/types.ts';
import {escapeHtml} from './util.ts';

interface ServiceAdminView {
  session: AdminSession;
  BRAND_HEAD: string;
  BRAND_NAME: string;
  BRAND_HEADER: string;
  service: McpModule;
  rows: string;
}

// One shared layout for all registered modules. Modules without specialized
// settings still get an independently protected information page.
export function renderServiceAdminDocument(view: ServiceAdminView): string {
  const {session,BRAND_HEAD,BRAND_NAME,BRAND_HEADER,service,rows}=view;
  const id=escapeHtml(service.id);
  const displayName=service.id==='github'?'GitHub':service.id;
  const endpointList=service.endpoints.map(e=>
    '<code>'+escapeHtml(e.path)+'</code>'
  ).join('、');
  const github=service.id==='github';
  const settings=github?`
    <section class="panel">
      <h2>GitHub 账号连接</h2>
      <p>仅管理 GitHub 模块的 Owner 与加密凭据。此模块由 Fongap Labs 独立开发，并非 GitHub 官方 MCP Server。</p>
      <div class="table-wrap"><table><thead><tr><th>Owner</th><th>类型</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="5">尚无 GitHub 连接</td></tr>'}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>添加 / 更换 GitHub 连接</h2>
      <p>相同 Owner 再次提交将替换该凭据。建议使用最小权限的 fine-grained PAT。</p>
      <form id="add">
        <label>GitHub Owner<input name="owner" type="text" maxlength="39" placeholder="example-org" autocomplete="off" required></label>
        <label>账号类型<select name="kind"><option value="Organization">组织</option><option value="User">个人</option></select></label>
        <label>GitHub Token<input name="token" type="password" autocomplete="off" spellcheck="false" required></label>
        <button type="submit">加密并保存</button>
      </form>
      <p class="muted">Token 在浏览器端使用 RSA-OAEP 和 AES-GCM 加密后提交；服务器仅存储加密数据，不提供明文查看或导出。</p>
    </section>`:`
    <section class="panel">
      <h2>服务设置</h2>
      <p>该模块当前没有独立管理选项。OAuth 客户端权限仍由 Hub 管理中心统一控制。</p>
    </section>`;
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="${session.csrf}">${BRAND_HEAD}
    <title>${escapeHtml(displayName)} · ${BRAND_NAME}</title>
    <link rel="stylesheet" href="/admin/app.css"></head><body>
    <main class="admin-shell"><header>${BRAND_HEADER}
      <form id="logout" method="post" action="/admin/logout">
        <input type="hidden" name="csrf" value="${session.csrf}">
        <button class="secondary">退出登录</button></form></header>
      <nav class="breadcrumbs"><a href="/admin">MCP Hub 管理中心</a> / <span>${escapeHtml(displayName)} 服务</span></nav>
      <div class="section-heading"><h2>${escapeHtml(displayName)} 服务管理</h2>
        <p>${escapeHtml(service.description)} · MCP 入口：${endpointList}</p></div>
      ${settings}
      <p id="result" role="status" aria-live="polite"></p>
      <p class="muted">OAuth 客户端注册、Resource 授权和 Runner 治理由 <a href="/admin">Hub 管理中心</a> 统一处理。</p>
    </main><script src="/admin/app.js" defer></script></body></html>`;
}
