# 服务迁移与部署安全

> **2026-11-11 认证更新**：本页涉及 `MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY` 的部分仅记录旧版本迁移状态。当前新版本改为 Cloudflare Access + 验证器 6 位 TOTP；生产上线前置条件和 Secret 见 [中央部署操作](CENTRAL_DEPLOY.md)。请勿依本页旧认证密钥清单配置新版本。

## 1. 目标身份

仓库、服务与数据库必须分别确认。

### ❌ 错误做法 / 反面教材

以仓库改名代替云资源迁移。

```text
重命名 GitHub 仓库 → 假定数据库也已改名
```

### ✅ 正确做法 / 规范范例

逐项核验实际标识。

```text
仓库：fongap-labs/mcp-hub
Worker：mcp-hub
域名：mcp.135468.xyz
D1：mcp-hub
D1 绑定：MCP_DB
D1 标识来源：MCP_D1_ID
中央部署环境：production
专属运维环境：mcp-hub-ops
根入口：https://mcp.135468.xyz
GitHub 入口：https://mcp.135468.xyz/github
```

共用管理与授权路径为 `/admin`、`/authorize`、`/oauth/*`、`/.well-known/*`。平台配置采用 `MCP_*`；GitHub 专属开关保留 `GMC_WRITE_MODE` 和 `GMC_CONTENT_MODE`。

## 2. 数据库隔离

禁止把新名称直接绑定旧数据库标识。

### ❌ 错误做法 / 反面教材

不检查密文数据就直接切换。

```text
新 D1 名称 + 旧 UUID → 视为迁移成功
```

### ✅ 正确做法 / 规范范例

先审计资源，再转移和核对。

```text
冻结旧库凭据写入 → 导出备份 → 创建新 D1
                  → 审计加密迁移 → 核对行数与解密 → 切流
```

新安装仅需创建目标 D1 并执行版本控制内的迁移。已有密文时，保留原始 AES 密钥环及浏览器 JWK 材料；`GMC_KEYRING_JSON` 改名为 `MCP_KEYRING_JSON`、`GMC_INGEST_JWK` 改名为 `MCP_INGEST_JWK`，**不得重新生成密钥**。源数据库须保留至审查后的恢复期结束。

## 3. 重新授权

新的授权资源必须重新取得许可。

### ❌ 错误做法 / 反面教材

沿用旧域名的授权记录。

```text
旧 resource → 静默授予新域名
```

### ✅ 正确做法 / 规范范例

按目标资源重新执行客户端授权。

```text
新资源 URI → 新的客户端授权 → 受限工具访问
```

旧 OAuth 授权码、访问令牌与刷新令牌不得自动继承新 URI 权限。

## 4. 中央部署

部署只使用 Action Worker。

### ❌ 错误做法 / 反面教材

从业务仓库密钥直接发布 Worker。

```text
mcp-hub 自有部署流程 → 直接生产环境
```

### ✅ 正确做法 / 规范范例

从中央入口申请授权。

```text
Action Worker → 手动 · 部署服务
              → 主分支来源证明
              → CI Evidence + 审批 + 环境权限
              → 固定提交 → scripts/deploy.sh
```

Action Worker 共享 `production` 只配置 Cloudflare 部署凭据 `CLOUDFLARE_API_TOKEN_SECONDARY`；`CLOUDFLARE_ACCOUNT_ID_SECONDARY` 与业务部署参数属于普通 Variables。`mcp-hub-ops` 留给独立运维任务。五项必需业务密钥 `MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY`、`MCP_COOKIE_KEY`、`MCP_KEYRING_JSON`、`MCP_INGEST_JWK` 继续作为 Cloudflare Worker Secrets；可选 `MCP_RUNTIME_KEY` 也只在 Cloudflare 设置。普通部署不传递任何业务密钥。停用某项 Worker Secret 必须由运维人员显式删除并核验，不能通过部署时省略实现。实际已配状态需运维核实，不允许凭据回退。

## 5. 切换安全

未完成验证不得切换流量。

### ❌ 错误做法 / 反面教材

DNS、数据库与密钥状态未知时立即部署。

```text
未知 DNS + 未验证 D1 + 过期凭据 → 部署
```

### ✅ 正确做法 / 规范范例

确认全部前置条件。

```text
正确 Cloudflare 账户 → 域名无冲突 → 数据备份校验
                      → 中央部署 → 健康验证 → 切流
```

`workers_dev: false`、`preview_urls: false` 必须保持。Worker 回滚不回滚 D1 迁移。本文不执行数据库、密钥或云资源变更。
