# 中央部署操作

本文为最新部署合同；[运维迁移和验收手册](OPERATIONS_MIGRATION_ACCEPTANCE.md)记录历史基线，涉及密钥归属的旧说明不再适用。

## 1. 配置归属

运维人员统一在 Action Worker 的 GitHub Actions Secrets / Variables 中管理配置。部署通过中央受控入口把获授权的运行时 Secret 写入 Cloudflare Worker；不在源码中保存明文。既有 Cloudflare Secret 在未声明同步时保留。

### ❌ 错误做法 / 反面教材

在业务仓库保存管理密钥。

```text
mcp-hub 仓库密钥 → 自行部署
```

### ✅ 正确做法 / 规范范例

按用途在中央设置凭据。

```text
Action Worker / Actions Variables
CLOUDFLARE_ACCOUNT_ID_SECONDARY
MCP_PUBLIC_URL=https://mcp.135468.xyz
MCP_D1_ID
MCP_ACTIVE_ID
MCP_ACCESS_ISSUER=https://你的团队.cloudflareaccess.com
MCP_ACCESS_AUD=Access应用的AUD（多个用英文逗号分隔）
MCP_AUTH_MODE=access-totp（安全默认；通过实际 Access MFA 验收后方可设为 cloudflare-mfa）
MCP_OAUTH_TTL=900
GMC_WRITE_MODE=disabled
GMC_CONTENT_MODE=disabled

Action Worker / Actions Secrets（仓库级，或受控 mcp-hub-ops Environment；部署目标仍为 production）
CLOUDFLARE_API_TOKEN_SECONDARY（必需）
MCP_TOTP_SECRET（必需，至少 32 位 Base32，必须是 Secret 而非 Variable）
MCP_COOKIE_KEY（可选，同步时至少 32 字符）
MCP_KEYRING_JSON（可选，必须保留原有加密密钥）
MCP_INGEST_JWK（可选，必须保留原有私钥）
MCP_RUNTIME_KEY（可选，至少 32 字符）

Action Worker / Actions Variables（仅在同时确认旧 Keyring 和 JWK 后启用）
MCP_CRYPTO_SECRET_SYNC=confirmed

Cloudflare Worker
# 由 Action Worker 发布时自动同步；不要求运维人员日常手工维护 Secrets
```

`AW_REPOSITORY_POLICY` 必须允许此仓库部署。MCP Hub 的逻辑目标环境为 `production`，但中央凭据路由使用 `mcp-hub-ops` 作为该部署 Job 的 Secrets 来源；必需的 `CLOUDFLARE_API_TOKEN_SECONDARY` 与 `MCP_TOTP_SECRET` 必须在仓库级或 `mcp-hub-ops` 可读取，不能只放在 `production` Environment。中央密钥白名单限制源仓库可获取的名称，缺少必需 Secret 即拒绝发布；绝不降级使用明文 Variables。旧有 `MCP_KEYRING_JSON` / `MCP_INGEST_JWK` 如果无法安全取回原始值，请不要重新生成或覆盖，省略这两个可选 GitHub Secrets，Wrangler 将保留 Cloudflare 现有密钥。

## 2. Cloudflare Access 与动态码

**管理路径分层**：全局管理中心 `/admin`，单服务管理为 `/<service>/admin`，目前已注册的 GitHub 服务对应 `/github/admin`；服务列表按模块声明自动生成。所有服务级管理请求仍需现有 Access 身份验证及管理员 Session；未知服务拒绝访问。Cloudflare Zero Trust 的 MCP Hub Access 应用应将 `/github/admin`（以及未来新增的服务管理入口）纳入**同一受保护应用、同一 AUD**，否则这类路径可能缺少访问令牌而返回 403。不要启用 Bypass 或 Allow Everyone。原有 `/admin` 及 `/admin/api/*` 保持兼容，现有 `/github` OAuth Resource 和 MCP 客户端无需迁移。


生产部署前，先在 Cloudflare Zero Trust → Access → Applications 配置仅允许本人访问的自托管应用，至少保护以下五个路径（新增服务管理入口时相应扩展）：

- `https://mcp.135468.xyz/admin`
- `https://mcp.135468.xyz/admin/*`
- `https://mcp.135468.xyz/github/admin`
- `https://mcp.135468.xyz/github/admin/*`
- `https://mcp.135468.xyz/authorize`

不要保护 `/`、`/github`、`/oauth/*` 或 `/.well-known/*`：它们需要被标准 MCP/OAuth 客户端访问。请关闭 Access Managed OAuth，保留 MCP Hub 原生 OAuth。配置中填入实际的团队域名（ISSUER）及上述 Access 应用的 Audience（AUD），有多个应用就将 AUD 用逗号连接。

**登录方式与切换边界**：默认 `access-totp` 模式继续采用 Access 身份验证 + MCP Hub 独立动态验证码。用户选定的目标是 **Cloudflare 账号登录 + Cloudflare Access 独立 MFA**，省去 Email One-time PIN 与本地重复 TOTP。此目标只在下文“Cloudflare 账号 + Cloudflare MFA：安全切换”的实际双因素验收成功并显式启用 `MCP_AUTH_MODE=cloudflare-mfa` 后生效。任何模式都不能启用 Allow Everyone 或 Bypass。

**Worker 原生 Access 身份优先**：MCP Hub 在 Cloudflare 已对当前 Worker 调用认证时优先读取可信 `ctx.access`，严格要求 `ctx.access.aud` 属于 `MCP_ACCESS_AUD` 且身份提供商返回有效的用户邮箱，并为该单次请求绑定脱敏主体标识。只有原生 Access 上下文不存在时，才回退现有的请求头 JWT / Cookie 验签流程。若存在原生上下文但 AUD 不匹配或身份不完整，则直接拒绝，不允许以其他 JWT 绕过。未通过 Cloudflare Access 的 Worker 调用不会获得可信的 `ctx.access`。不依赖 `ctx.access` 的子 Worker Service Binding 或静态资源路由仍采用原有 JWT 验证。仅使用原生上下文不代表自动验证 MFA 策略；仍须在 Zero Trust 强制执行并做实际登录验收。

**Access JWT 到达 Worker 的检查**：浏览器登录成功后，Cloudflare 应为受保护请求注入 `Cf-Access-Jwt-Assertion`；浏览器也可能带有 `CF_Authorization` Cookie。当原生 Worker Access 上下文不可用时，MCP Hub 优先验证请求头，只有请求头完全缺失时才验证 Cookie；两者均执行相同的 RSA 签名、Issuer、AUD、有效期与用户身份校验。若请求头存在但无效，不会以 Cookie 绕过；二者均无效则继续返回 403，浏览器得到说明页面，API 仍返回 JSON。**此兼容逻辑不是 Access 应用路径配置的替代品**：`/admin`、`/admin/*`、`/github/admin`、`/github/admin/*`、`/authorize` 必须在 Access 应用中受到保护。若为不同路径配置了多个 Access 应用，`MCP_ACCESS_AUD` 应准确包含这些应用的 Audience，并严格核对访问策略。

上线验收建议依次检查：未登录访问 `/admin` 是否被 Cloudflare Access 拦截；完成通行密钥/IdP 认证后是否进入 MCP Hub 6 位动态码页面；完成 TOTP 后是否进入管理后台；没有 Access 身份令牌、错误 AUD、伪造签名和已过期 JWT 是否继续被拒绝；MCP 公共 OAuth/MCP 接口是否保持原有行为。

在 Action Worker 的 GitHub Actions **Secrets** 中设置 `MCP_TOTP_SECRET`，由中央部署同步到 Cloudflare Worker：一个随机生成、至少 32 位的 Base32 密钥，在 Microsoft/Google Authenticator 等验证器中使用相同密钥设置 **TOTP / SHA-1 / 6 位 / 30 秒**。请从安全的本地环境生成并保存，勿提交到仓库、聊天或日志；不要使用 README 中任何示例密钥作为生产密钥。上线前需在正式登录和 OAuth 授权页测试动态码。

**前置条件**：Access 两个 Variables 与 GitHub TOTP Secret 全部就绪后才能运行生产部署；部署脚本会校验并同步 TOTP Secret。请先在 GitHub Secrets 设置原有验证器使用的相同密钥，不要新生成替换。部署使用 D1 新迁移 `0005_admin_totp.sql`，不修改已有 GitHub 凭据密文。

新方式启用并验收通过后，才允许通过受控运维变更清理旧 `MCP_ADMIN_KEY` 与 `MCP_APPROVAL_KEY`；当前部署既不传输也不删除旧值。Cloudflare Access 策略本身仍需首次在 Zero Trust 配置，不在本次 Worker 发布范围内。

## Cloudflare 账号 + Cloudflare MFA：安全切换

Cloudflare Access 自 2026 年起支持 **Cloudflare 账号作为登录身份提供方**，并提供 **独立 MFA（Authenticator App/TOTP）**。这与本地 MCP Hub TOTP 是两种不同的机制。**在 Cloudflare Access 强制 MFA 完成验收前，MCP Hub 保持默认的 `access-totp` 模式，不可提前切换。**

1. 在 Cloudflare Zero Trust → **Integrations → Identity providers** 中添加或选中 **Cloudflare**；启用 `Restrict to account members`，并在 MCP Hub Access 应用的 **Login methods** 仅允许 Cloudflare 登录。关闭该应用的 Email One-time PIN（其他应用的 OTP 不需要全局删除）。
2. 在 **Access controls → Access settings → Independent MFA** 先启用组织级 MFA 能力并允许 **Authenticator application**；然后在 MCP Hub Access 应用或适用策略上**强制要求该 MFA**。先在 App Launcher 完成验证器注册（团队域名 `https://<your-team>.cloudflareaccess.com/AddMfaDevice`）。**不要只依赖 Cloudflare Dashboard 账号启用了 2FA 这一事实代替 Access 应用级 MFA 配置**。 如果 Cloudflare 账号登录时已完成 MFA，而 Access 又提示第二次验证，可在 Access 的 **Use identity provider MFA** 中启用 AMR 匹配（仅在 IdP 实际返回可接受的 `amr` 时跳过重复提示）；否则 Access 仍会独立要求 MFA。请以实际登录验收为准，不要为减少一次提示而关闭应用的 MFA 强制要求。
3. 应用 **Allow Policy** 使用 Cloudflare Account Member 和/或本人身份限制；禁止 Allow Everyone、Bypass 或非预期的替代登录方式。确保 `/admin`、`/admin/*`、`/github/admin`、`/github/admin/*` 和 `/authorize` 均受相同或等效强度的 Access Policy 保护，确认实际 AUD 与部署 Variables 一致。
4. **先保持旧模式验收 Cloudflare 登录和 MFA**：新浏览器无 Access 会话应被拦截；通过 Cloudflare 账号登录应被强制要求验证器 6 位码；未通过 MFA 不能进入 MCP Hub 的旧 TOTP 页面；无法用邮件 OTP 绕过；无有效签名、错误 AUD、过期 JWT 均应拒绝。
5. 上述验收通过后，才在 **Action Worker 仓库 Actions Variables** 中设置 `MCP_AUTH_MODE=cloudflare-mfa`，通过中央手动部署服务发布最新主分支。验收：Access 成功后直接进入管理后台（后台自动签发短期签名 Session/CSRF Cookie）、OAuth 授权仍须明确点击确认但不再要求第二个 TOTP；写操作仍需逐项审批；退出登录应跳转 Cloudflare Access 注销入口。
6. 回退只需把 `MCP_AUTH_MODE` 改回 `access-totp`，并经中央部署。为了安全回退，**本阶段仍保留原有 `MCP_TOTP_SECRET` GitHub Secret 及其部署必需校验**，不会生成新 TOTP 密钥或覆盖旧加密密钥。生产模式切换与 Cloudflare Access Policy 修改均需要分别留存验收记录。

实现边界：`MCP_AUTH_MODE` 未配置、为空或为 `access-totp` 时沿用旧验证；仅明确设置 `cloudflare-mfa` 才禁用 MCP Hub 本地重复 TOTP。代码验证 Cloudflare Access JWT 签名、Issuer、AUD、有效期和 Subject，**无法仅从通用 JWT 自行证明 Cloudflare Independent MFA Policy 已强制执行**；必须先在 Cloudflare 管理侧配置并实际验收，不能把环境变量当作 MFA 本身。

## 3. 数据迁移

必须先备份和验证数据库。

### ❌ 错误做法 / 反面教材

只改数据库名称或密钥内容。

```text
旧数据库标识 → 改写名称 → 删除原库
```

### ✅ 正确做法 / 规范范例

审计实际资源后迁移。

```text
冻结写入 → 备份旧库 → 新建目标数据库
         → 加密迁移 → 核对行数及解密 → 切流
```

`MCP_D1_ID` 必须是目标数据库的真实标识。保留原密钥材料并离线备份；确认恢复可靠之前不得删除源库。

Cloudflare 端需先建同账户队列 `mcp-hub-dispatch` 和死信队列 `mcp-hub-dispatch-dlq`。派发能力由 Worker 的 `MCP_RUNTIME_KEY` 与队列绑定决定；已在 GitHub Secrets 设置该密钥时，中央部署同步其值，否则保留现有 Cloudflare 值。

注意：删除 GitHub Secret 不会删除 Cloudflare 中已经存在的密钥。关闭派发须通过单独的、经审批的清理流程删除 Cloudflare `MCP_RUNTIME_KEY`，并验证接口拒绝未授权请求；本发布流程不执行密钥删除。

## 4. 部署执行

只通过中央人工部署入口。

### ❌ 错误做法 / 反面教材

业务仓库自行发布或跳过来源检查。

```text
仓库推送 → 直接 Wrangler 部署
```

### ✅ 正确做法 / 规范范例

使用中央审批和固定提交。

```text
Action Worker → 手动 · 部署服务
source_repository=fongap-labs/mcp-hub
environment=production
source_sha=留空
product=留空
Main Write Guard bypass=禁用
```

中央校验来源和审批后执行 `scripts/deploy.sh`：隔离依赖安装与测试 → Wrangler dry-run → 校验 GitHub TOTP / 可选 Secrets → 以临时 0600 JSON 和 `wrangler deploy --secrets-file` 同版本发布代码与密钥 → 远端健康检查。临时文件只在 Runner 中存在，退出时删除，不能进入提交、产物或日志。未声明的可选 Secret 不会被删除。

正常生产发布时，即使 GitHub Secrets 中保存了 `MCP_KEYRING_JSON`、`MCP_INGEST_JWK`，**也不会自动下发或覆盖 Cloudflare 中的历史加密密钥**。只有明确执行密钥同步时，才使用一次性确认开关。

首次将历史加密密钥迁移到 GitHub 时，**必须使用旧值**。只有 `MCP_KEYRING_JSON` 和 `MCP_INGEST_JWK` 两个原值同时作为 GitHub Secrets 存在，并经独立核对，才设置 `MCP_CRYPTO_SECRET_SYNC=confirmed`。本次迁移验收后应清除此确认变量，恢复默认不覆盖模式。错误或不完整的显式同步配置仍会被拒绝。

## 5. 回滚约束

代码回滚不代表数据库回滚。

### ❌ 错误做法 / 反面教材

部署失败后直接恢复旧代码并忽略数据结构。

```text
数据库已迁移 → 旧代码发布 → 认为恢复完成
```

### ✅ 正确做法 / 规范范例

分别检查代码与数据恢复条件。

```text
代码回滚 → 核对数据库迁移兼容性 → 验证授权与健康状态
```

生产自动部署保持关闭。所有机密值不得进入源码或日志。
