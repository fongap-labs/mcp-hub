# MCP Hub（Cloudflare Workers）

> **MCP Hub · Fongap Labs · 通用 MCP 网关 · 模块化服务接入。** 产品以注册模块为单位提供独立的 MCP 工具、OAuth Resource 和管理入口。当前已实现 GitHub 模块；未来服务按相同协议接入，而不是把整个 Hub 定位为 GitHub MCP Server。

> **隔离边界**：本共享 MCP Hub 不提供 `fongap-bot`、Action Worker 的任务提交、执行或权限代理工具。即使 GitHub Owner 相同，普通 MCP 客户端授权也不代表获准调用 Fongap Labs 的自动化机器人。专用 Agent 入口由 Action Worker 的 GitHub 原生工作流提供，使用独立的 GitHub 身份白名单校验，并由 Action Worker 再次检查仓库能力；不复用共享 MCP 的授权。共享 Hub 不保存或签发 fongap-bot 的 GitHub App 私钥及执行令牌。 普通 MCP 工具（包括创建 Issue）不能作为机器人任务执行的授权凭据。

MCP Hub 为不同模块提供统一的 OAuth 客户端管理、权限策略和受保护的管理后台。当前 GitHub 模块支持连接多个 GitHub 用户名／组织名，Worker 根据仓库所属 Owner 精确选择加密凭据；Agent 无法读取或导出这些 Token。

**状态（2026-11-12）**：MCP Hub 已通过 Action Worker 中央流程部署至 Cloudflare Workers；例如 [部署运行 #43176863888](https://github.com/fongap-labs/action-worker/actions/runs/43176863888) 成功发布提交 `5c0a5fe4`，且远程健康、构建身份、OAuth 与 MCP 未授权访问检查通过。此记录**不代表最新 main（含 #76、#77）已发布**，也不代表真实浏览器 Access/MFA、实际 GitHub 授权或第三方 MCP 客户端互操作验收完成。项目已通过本地单元测试和带 SQLite 的模拟测试；目前只实现无状态 JSON 响应的 MCP Streamable HTTP 子集，不支持 SSE 服务端推送、资源订阅、Prompt 和会话恢复。新的 main 版本应先完成中央部署与生产验收。

## 产品标识和避免混淆

- 产品显示名称：**MCP Hub**；来源：**Fongap Labs**；版本：**v0.1.0**；MCP `serverInfo.name`：`mcp-hub`；客户端推荐配置名：`mcp-hub`。
- `/admin` 是通用 Hub 管理中心；各模块管理入口为 `/<service>/admin`，如 `/github/admin`。只有 GitHub 模块使用「非 GitHub 官方 MCP Server」说明。
- 产品独立图标为 `#286F78` 的连接网络标记，**不是** GitHub 的 Octocat / Invertocat 标志；管理页直接内嵌 SVG，避免跨路径加载时显示破图。
- GitHub 名称只用于说明支持的第三方服务；不使用官方 Logo 冒充本产品标识，不以 `github-mcp-server` 命名。

## 安全设计

| 环节 | 机制 |
| --- | --- |
| MCP 首次连接 | OAuth 授权码 + PKCE S256。浏览器先通过 Cloudflare Access；默认 `access-totp` 仍需 MCP Hub 本地 TOTP。仅当 Access 已强制执行 MFA 且明确配置 `MCP_AUTH_MODE=cloudflare-mfa` 时，才不再重复输入本地验证码；OAuth 同意仍需明确确认 |
| 客户端注册 | 动态注册；**默认禁止访问**，管理员在 `/admin` 批准后才允许 OAuth 登录 |
| 客户端权限 | 每个客户端指定允许的 GitHub Owner；Access Token 默认 15 分钟有效（最高可配置 1 小时）；注册时声明 `refresh_token` 的客户端可获得 30 天滚动 Refresh Token，授权最长 90 天 |
| GitHub Token 录入 | 管理员通过 `/admin` 输入；浏览器使用 RSA-OAEP-256 加密随机 AES-256-GCM 密钥，再用 AES-GCM 加密 Token；传输同时使用 HTTPS |
| 存储 | D1 仅保存 AES-256-GCM 密文、随机 96 位 IV、密钥版本；**owner 作为认证附加数据（AAD）**防止密文在不同账号之间交换 |
| 加密密钥 | Workers Secrets `MCP_KEYRING_JSON` 保存 AES 密钥环；`MCP_INGEST_JWK` 保存浏览器加密使用的 RSA 私钥；`MCP_RUNTIME_KEY`（可选）单独保护 Runtime 派发接口；均不写进仓库或数据库 |
| GitHub 请求 | Worker 按需解密，仅发送到 `https://api.github.com` 的 `Authorization: Bearer ...` 请求头，HTTPS；响应只返回受控字段 |
| 路由 | 按 owner 大小写不敏感精确映射；未配置、停用、未授权时立即拒绝，**绝不回退其他 GitHub Token** |
| 写操作 | 默认关闭。仅启用 `GMC_WRITE_MODE=approval`、为客户端批准写权限、用户在 OAuth 中同意后才可提交；**创建 Issue 仍需管理员在 `/admin` 逐次审批，10 分钟过期** |
| 管理界面 | 与 MCP 工具隔离；Cloudflare Access 身份及已强制的 MFA、按 `MCP_AUTH_MODE` 控制的本地 TOTP（默认开启），配合 HMAC 签名 HttpOnly/Secure/SameSite Cookie、CSRF 验证和严格 CSP；`/admin` 管理 Hub，`/github/admin` 管理 GitHub 模块 |
| 日志与响应 | 无 Token 导出接口；不记录 Header、请求体、GitHub 错误原文或异常堆栈；已知 GitHub Token 字样会尝试脱敏 |
| 撤销 | 管理员可停用/删除 Github 连接，或撤销 MCP 客户端；撤销客户端时其访问令牌立即失效 |

**重要限制**：MCP Refresh Token 仍属于敏感的客户端凭据，不能放进模型对话、提示词或日志。客户端必须支持 OAuth Refresh Token 自动续期，且要串行执行刷新；同时刷新或重用已轮换的旧凭据会被判定为疑似重放并撤销整个授权。客户端不支持刷新时仍需重新授权。

**重要限制**：加密并不能阻止所有泄露。Worker 执行 GitHub 请求时 Token 必须在受信任内存中短暂解密；Cloudflare 账号被接管、Worker 代码/管理页面被篡改、受感染浏览器、授权客户端滥用读取权限，仍可能造成损失。不能承诺绝对不泄密。MCP 访问令牌也可能被 Agent 输出；其危害被限制在有效期和已批准的 owner 范围内，而非变成 GitHub PAT 泄露。可选的文件读取默认**关闭**，因为 GitHub 仓库文件可能包含意外提交的机密。

## 所需资源

- Cloudflare 账号（Workers 与 D1）
- Node.js 22+（测试使用 Node 22 的内置实验性 SQLite）
- 可运行 `npx wrangler` 的开发机器
- GitHub fine-grained PAT；建议每个组织/账号单独使用最小仓库权限、设置有效期

**不要把 GitHub PAT、MCP_TOTP_SECRET、MCP_RUNTIME_KEY、MCP_KEYRING_JSON 或 MCP_INGEST_JWK 粘贴给 Agent。** 以下命令也不要求你把真实 Token 放进终端或聊天历史；GitHub Token 只在部署后的管理员网页填写。

**管理方式**：默认 `access-totp` 需 Cloudflare Access 身份验证加 MCP Hub 独立 TOTP；已验证 Access 应用级 MFA 后，可通过 `MCP_AUTH_MODE=cloudflare-mfa` 改为不重复输入本地动态码。管理会话为 30 分钟，OAuth 授权仍需主动确认。生产发布必须保持 `/admin`、`/admin/*`、`/github/admin`、`/github/admin/*` 和 `/authorize` 的 Access 保护、有效的 `MCP_ACCESS_ISSUER`/`MCP_ACCESS_AUD`，以及中央合同要求的 `MCP_TOTP_SECRET`（用于安全回退）。详见 [中央部署操作](docs/CENTRAL_DEPLOY.md)。

## MCP Hub 部署边界

目标：`fongap-labs/mcp-hub`、Cloudflare Worker `mcp-hub`、D1 数据库 `mcp-hub`（绑定 `MCP_DB`）、唯一公开域名 `https://mcp.135468.xyz`。MCP 入口 `/` 与 `/github` 保持各自 OAuth Resource 和 Access Token。通用管理中心为 `/admin`，GitHub 服务管理为 `/github/admin`。新的服务管理路径必须配置 Cloudflare Access 保护。

### 统一交由 Action Worker 部署

MCP Hub 与 AI Gateway 共用 [Action Worker → 手动 · 部署服务](https://github.com/fongap-labs/action-worker/actions/workflows/deploy-source-script.yml) 的 `source-script` 部署合同。MCP Hub 仓库**不保留独立部署工作流**。中央先验证不可变 main SHA、CI Evidence、Main Write Guard、环境和 runner 策略，再运行审核过的 `scripts/deploy.sh`。仅允许目标 `production` 手动部署；按 Action Worker 中央凭据路由从 `mcp-hub-ops` 读取受限部署 Secrets，`mcp-hub-ops` 自身不记录生产 Deployment。

| 配置位置 | 名称 |
| --- | --- |
| Action Worker · Actions Variables | `CLOUDFLARE_ACCOUNT_ID_SECONDARY`, `MCP_D1_ID`, `MCP_PUBLIC_URL=https://mcp.135468.xyz`, `MCP_ACTIVE_ID`, `MCP_ACCESS_ISSUER`, `MCP_ACCESS_AUD`, `MCP_AUTH_MODE`, `MCP_OAUTH_TTL`, `GMC_WRITE_MODE`, `GMC_CONTENT_MODE` |
| Action Worker · Actions Secrets（仓库级或 `mcp-hub-ops`） | 必需 `CLOUDFLARE_API_TOKEN_SECONDARY`、`MCP_TOTP_SECRET`；可选 `MCP_COOKIE_KEY`、`MCP_KEYRING_JSON`、`MCP_INGEST_JWK`、`MCP_RUNTIME_KEY` |
| Action Worker · `production` | 逻辑部署目标与成功部署记录；不作为 MCP Hub 部署 Secrets 的跨环境读取来源 |
| Action Worker · `mcp-hub-ops` Environment | 中央部署作业的凭据来源；读取范围受仓库与中央白名单约束，不创建独立生产 Deployment |
| Cloudflare · `mcp-hub` Worker Secrets | 中央发布时按白名单同步所提供的密钥；省略的可选密钥保留现有值 |

**密钥保护**：中央受控发布只同步获授权的 Secret，不能将其改成普通 Variables。历史 Keyring/JWK 必须保留原值并离线备份；普通部署不覆盖，只有同时核对两份原值且显式 `MCP_CRYPTO_SECRET_SYNC=confirmed` 才进行同步，结束后移除确认开关。停用既存 Worker Secret 必须单独在 Cloudflare 执行经验证的删除；仅从 GitHub 删除 Secret 或部署时省略不能证明线上已移除。安装和测试的子进程不接收运行时凭据。

部署入口参数：`source_repository=fongap-labs/mcp-hub`、`environment=production`、`product` 与 `source_sha` 留空，`main_write_guard_bypass=false`。参见 [部署配置说明](docs/CENTRAL_DEPLOY.md)。本次更改不会部署 Cloudflare 或删除旧 D1。

### D1 与 OAuth 迁移

1. 若旧 D1 `github-multi-connect` 已经保存凭据，先做加密数据库备份并验证表结构；不得通过修改 ID 冒充数据库重命名。
2. 创建新 D1 `mcp-hub` 后，使用 `MCP_D1_ID` 保存新的 UUID；仅在确认备份、表数据与密钥无误后迁移数据。
3. 原 `GMC_KEYRING_JSON` 对应的**值**必须原样转存为 `MCP_KEYRING_JSON`；原 RSA 私钥也必须原样转存。不要生成新密钥覆盖旧凭据。
4. 旧 OAuth 资源 URI 不能转换成新域名的授权；客户端必须针对 `https://mcp.135468.xyz` 或 `https://mcp.135468.xyz/github` 重新授权。
5. 只能通过 Action Worker 手动生产部署，中央确认 CI Evidence 与 Main Write Guard 后执行；Worker 回滚不会撤销 D1 数据迁移。

详细前置检查见 [迁移说明](docs/MCP_HUB_MIGRATION.md) 与 [运维迁移和验收手册](docs/OPERATIONS_MIGRATION_ACCEPTANCE.md)。

### MCP 服务模块

通用 MCP JSON-RPC 路由位于 `src/gateway/router.ts`，服务定义位于 `src/services/`，入口和 OAuth Resource 由 `src/gateway/registry.ts` 组合。每个服务模块独立声明描述、工具列表、工具调用处理器和兼容入口。新增模块的约定见 [MCP 模块开发说明](docs/MCP_MODULES.md)。

当前 `/` 与 `/github` 继续映射到 GitHub 模块，且保留各自独立的 OAuth Resource；这两个兼容入口暂时提供相同 GitHub 工具。

Runner v1 的注册与租约见 [Runner Protocol](docs/RUNNER_PROTOCOL.md)，任务引用派发、额度报告、接受/拒绝、取消和 Runtime 对账见 [Runner Dispatch](docs/RUNNER_DISPATCH.md)。Cloudflare Queue 只传递 D1 中派发记录的 ID；Hub 不保存任务正文，也不决定 Agent 执行状态。管理员可在 `/admin` 签发 Runner 凭据并查看派发指标。

### 本地测试

```bash
npm install --ignore-scripts
npm run validate
```

新安装可在可信环境初始化密钥；已有加密数据时**严禁重新运行** `scripts/generate-secrets.mjs` 以覆盖 keyring。真实部署状态以 Cloudflare 与中央执行记录为准，不能仅凭本地测试判断上线。

### GitHub Token 权限建议

只读场景：对应仓库 **Metadata (Read)**、**Issues (Read)**、**Pull requests (Read)**。某些仓库/私有仓库的接口可能要求其他具体权限，按实际 HTTP 状态码增补。可选文件读取需要 **Contents (Read)**；默认关闭。创建 Issue 需要 **Issues (Read and write)**，且还需经过上述独立的人工审批。尽量限制 Token 只覆盖需要的仓库。组织使用 fine-grained PAT 时，GitHub 组织可能要求管理员审核 Token 授权。

### 密钥轮换

现有密钥文件**不要重新运行 `generate-secrets.mjs` 覆盖**。先做安全备份，然后：

```bash
node scripts/rotate-key.mjs
npm run cf:secrets
```

新 `MCP_KEYRING_JSON` 同时保留旧密钥与新密钥，但 `MCP_ACTIVE_ID` 改为新版本。去 `/admin` 点击「迁移旧密钥加密的数据」，直到剩余记录为零。**只有在确认所有数据已迁移、备份可信并经恢复验证后**，才考虑从密钥环删除旧密钥。不要直接替换主密钥，否则已有密文不可解密。

当前脚本只轮换 D1 数据加密密钥，不自动轮换 RSA 录入密钥、浏览器管理密钥或 OAuth 用户授权密钥；可在 Cloudflare Secrets 中单独更新它们。若发生泄露，必须在 GitHub 侧撤销受影响的 PAT，而不是只轮换 D1 密钥。

### 管理与审计建议

生产环境必须对 `/admin`、`/admin/*` 和 `/authorize` 使用 Cloudflare Access 身份策略，为 `/oauth/register`、`/authorize`、`/admin/login` 加 WAF 限速，并开启 Cloudflare 账户 MFA。此项目自带基本 IP 窗口计数，但它不能替代边缘 WAF，也不是完全的暴力破解防护。该服务没有额外的审计日志以避免泄露内容；如果有合规留痕需求，应另行加入**仅记录操作元数据**的安全审计日志。

创建 Issue 的流程：客户端调用 `github_create_issue` → Worker 记录一条待审批请求并返回 `request_id` → 管理员在 `/admin` 检查并批准 → Worker 才调用 GitHub → 客户端可通过 `github_operation_status` 查询结果。写操作**不自动重试**，以避免 GitHub 已处理但网络丢失响应时产生重复 Issue。遇到 `processing` / `failed` 需管理员人工核对 GitHub。

### 可用工具

- `github_available_owners`：仅展示该客户端获授权的 owner
- `github_get_repository`：获取仓库元数据
- `github_list_issues` / `github_get_issue`：获取 Issue
- `github_list_pull_requests` / `github_get_pull_request`：获取 PR
- `github_operation_status`：检查审批的写操作状态
- `github_read_file`：**默认关闭**，可选；返回 Base64 内容，可能泄露源文件中的秘密，不建议在不可信 Agent 使用
- `github_create_issue`：**默认关闭**，需要 OAuth 写授权 + 管理员逐笔审批

此版本**不提供**通用 REST API 代理、Token 获取、Token 解密、Token 批量导出、仓库删除、GitHub Actions Secret 读取、直接修改代码或无审批合并 PR 的接口。

## 本地检查

```bash
npm run check
npm test
npm run db:migrate:local
npm run dev
```

本地实际测试 OAuth 时，将 `MCP_PUBLIC_URL` 临时改成 `http://127.0.0.1:8787`（仅回环地址可使用 HTTP）；部署生产前务必恢复真实 HTTPS URL。

测试含基本加密、跨账号隔离、Token 回显防护、管理员 Cookie 签名、OAuth 授权与刷新轮换、重放撤销、并发刷新及失效恢复限制。测试不需要真实 GitHub PAT；外部 GitHub API 请求用固定假数据模拟。Node 22 的 `node:sqlite` 测试可能打印实验性 API 提示。

## 安全边界说明

1. **没有任何 Agent 端存储的 GitHub Token**。Agent 只获得 MCP 权限，MCP API 永不提供获取/导出 Token 的工具。
2. **GitHub Token 在 GitHub API 调用期间确实会短暂出现在 Worker 内存中**，不能用“混淆”或“永不解密”来误导。
3. 默认 `access-totp` 下，`/authorize` 的本地 6 位动态码必须在真正的 Worker 域名页面输入；`cloudflare-mfa` 下应在 Cloudflare Access 完成强制 MFA，OAuth 页面仍须明确同意。恶意客户端可能诱导授权，请核对客户端名、回调地址及允许的 owner。
4. **没有主张通过审计或认证**。上线前仍需实际 Cloudflare 环境的部署测试、MCP 客户端互操作测试、威胁建模及渗透测试。
5. 使用 OAuth 登出/撤销管理中的客户端可以阻断所有已发放的 Access Token；如果 GitHub PAT 泄露，需要直接在 GitHub 端撤销。

相关官方文档：[Cloudflare Workers MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)、[MCP OAuth Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## Fongap Labs 中央治理

本仓库通过标准 `.github/workflows/notify-action-worker.yml` 桥接连接
[`fongap-labs/action-worker`](https://github.com/fongap-labs/action-worker)，
由中央系统负责 PR Governance、CI Evidence、Main Write Guard、发布与部署治理。
业务仓库仅保留执行清单及可信 CI 脚本，不另建独立 CI。

接入时维护者必须完成两项**外部配置**（不要把 Token 提供给 Agent）：

1. 在 `mcp-hub` 仓库 Actions Secrets 配置 `AW_DISPATCH_TOKEN`：Fine-grained PAT，**仅限** `fongap-labs/action-worker`，`Contents: Read and write`。缺失时桥接明确失败，不使用任何替代 Token。
2. 在 `action-worker` 仓库 Actions Variables 的 `AW_REPOSITORY_POLICY` JSON 中**合并加入** `"fongap-labs/mcp-hub": ["pr", "task", "deploy"]`，保留所有现有仓库配置。先只启用 PR 治理；`task`/`deploy`/`release-*` 在部署审核通过后单独启用。

参考 [Action Worker 接入指南](https://github.com/fongap-labs/action-worker/blob/main/docs/05_INTEGRATION_GUIDE.md)。

## TypeScript runtime (v0.1.0)

The Cloudflare Worker runtime is implemented in strict TypeScript (`src/index.ts`). Wrangler builds the Worker directly; Node deployment scripts remain `.mjs`. The browser-facing `/admin/app.js` URL, OAuth endpoints, MCP tool identifiers, database schema and token formats are unchanged. Install dependencies with `npm install`, then run `npm run typecheck` and `npm test`; the centralized Action Worker CI runs both checks. The test runner uses Node.js 22.16+ type stripping to import `.ts` modules. See [migration notes](docs/TYPESCRIPT_MIGRATION.md).
