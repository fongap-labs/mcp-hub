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
MCP_OAUTH_TTL=900
GMC_WRITE_MODE=disabled
GMC_CONTENT_MODE=disabled

Action Worker / Actions Secrets（仓库级，或受控 production Environment）
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

`AW_REPOSITORY_POLICY` 必须允许此仓库部署。中央密钥白名单限制源仓库可获取的名称，缺少必需 Secret 即拒绝发布；绝不降级使用明文 Variables。旧有 `MCP_KEYRING_JSON` / `MCP_INGEST_JWK` 如果无法安全取回原始值，请不要重新生成或覆盖，省略这两个可选 GitHub Secrets，Wrangler 将保留 Cloudflare 现有密钥。

## 2. Cloudflare Access 与动态码

生产部署前，先在 Cloudflare Zero Trust → Access → Applications 配置仅允许本人访问的自托管应用，保护以下三个路径：

- `https://mcp.135468.xyz/admin`
- `https://mcp.135468.xyz/admin/*`
- `https://mcp.135468.xyz/authorize`

不要保护 `/`、`/github`、`/oauth/*` 或 `/.well-known/*`：它们需要被标准 MCP/OAuth 客户端访问。请关闭 Access Managed OAuth，保留 MCP Hub 原生 OAuth。配置中填入实际的团队域名（ISSUER）及上述 Access 应用的 Audience（AUD），有多个应用就将 AUD 用逗号连接。

在 Action Worker 的 GitHub Actions **Secrets** 中设置 `MCP_TOTP_SECRET`，由中央部署同步到 Cloudflare Worker：一个随机生成、至少 32 位的 Base32 密钥，在 Microsoft/Google Authenticator 等验证器中使用相同密钥设置 **TOTP / SHA-1 / 6 位 / 30 秒**。请从安全的本地环境生成并保存，勿提交到仓库、聊天或日志；不要使用 README 中任何示例密钥作为生产密钥。上线前需在正式登录和 OAuth 授权页测试动态码。

**前置条件**：Access 两个 Variables 与 GitHub TOTP Secret 全部就绪后才能运行生产部署；部署脚本会校验并同步 TOTP Secret。请先在 GitHub Secrets 设置原有验证器使用的相同密钥，不要新生成替换。部署使用 D1 新迁移 `0005_admin_totp.sql`，不修改已有 GitHub 凭据密文。

新方式启用并验收通过后，才允许通过受控运维变更清理旧 `MCP_ADMIN_KEY` 与 `MCP_APPROVAL_KEY`；当前部署既不传输也不删除旧值。Cloudflare Access 策略本身仍需首次在 Zero Trust 配置，不在本次 Worker 发布范围内。

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

首次将历史加密密钥迁移到 GitHub 时，**必须使用旧值**。只有 `MCP_KEYRING_JSON` 和 `MCP_INGEST_JWK` 两个原值同时作为 GitHub Secrets 存在，并经独立核对，才设置 `MCP_CRYPTO_SECRET_SYNC=confirmed`；迁移验收后可删除此确认变量，以阻止后续意外覆盖。

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
