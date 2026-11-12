# 运维迁移与验收手册（历史记录）

> **当前部署配置已调整**：2026-11-12 起运行时 Secrets 由 Action Worker 的 GitHub Actions Secrets 按中央白名单同步到 Cloudflare。本文保留旧部署版本的历史说明，不能再作为密钥归属的操作依据。请优先阅读 [中央部署操作](CENTRAL_DEPLOY.md)。

> **2026-11-11 认证更新**：本页涉及 `MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY` 的部分仅记录旧版本迁移状态。当前新版本改为 Cloudflare Access + 验证器 6 位 TOTP；生产上线前置条件和 Secret 见 [中央部署操作](CENTRAL_DEPLOY.md)。请勿依本页旧认证密钥清单配置新版本。

本手册按已合并的 Action Worker #1420 与本仓库 #54 编写。只描述配置、迁移、验收和清理步骤；不代表线上配置已完成，也不授权在本手册 PR 中执行部署或修改密钥。

## 1. 当前生效基线

| 项目 | 当前代码合同 |
| --- | --- |
| 中央部署入口 | Action Worker 的 `手动 · 部署服务` 工作流 |
| 源仓库 | `fongap-labs/mcp-hub` |
| 源清单 | `.github/deploy.json`，根产品，入口 `scripts/deploy.sh` |
| 部署环境 | `production` |
| 运维环境 | `mcp-hub-ops`，当前没有 MCP Hub 运维 Job 使用 |
| 中央必需部署密钥 | `CLOUDFLARE_API_TOKEN_SECONDARY` |
| 中央可选部署密钥 | 无；MCP Hub 的 `allowed` 为空 |
| Worker 运行时密钥 | 由 Cloudflare Worker Secrets 管理，不经 GitHub 部署转交 |

Action Worker 环境策略只为 MCP Hub 授权 `production`。中央密钥策略对 `fongap-labs/mcp-hub` 的 `production` 只要求 `CLOUDFLARE_API_TOKEN_SECONDARY`，不允许任何 `MCP_*` 运行时密钥。源仓库 `.github/deploy.secrets.required` 与中央策略一致，`.github/deploy.secrets.allowed` 不声明可选密钥。

以上是代码状态。GitHub Environment 中是否已配置凭据、Cloudflare Worker Secrets 是否存在、D1 是否指向正确数据库，均**需运维人员核实**。

## 2. 环境与配置归属

### 2.1 共享生产环境

在 `fongap-labs/action-worker` 的 Settings → Environments 中核对 `production`。它是多个获授权产品共用的 GitHub Environment，不是 MCP Hub 独占环境。

| 配置位置 | 名称 | 要求 |
| --- | --- | --- |
| `production` Environment Secret | `CLOUDFLARE_API_TOKEN_SECONDARY` | MCP Hub 部署必需；需核实已配置且权限范围符合最小权限原则 |
| Action Worker 仓库 Actions Variables | `CLOUDFLARE_ACCOUNT_ID_SECONDARY` | 必需；32 位十六进制 Cloudflare Account ID |
| Action Worker 仓库 Actions Variables | `MCP_D1_ID` | 必需；目标 D1 `mcp-hub` 的 UUID |
| Action Worker 仓库 Actions Variables | `MCP_PUBLIC_URL` | 必须为 `https://mcp.135468.xyz` |
| Action Worker 仓库 Actions Variables | `MCP_ACTIVE_ID` | 必需；与当前密钥环活动版本一致 |
| Action Worker 仓库 Actions Variables | `MCP_OAUTH_TTL` | 可选；默认 `900`，允许 300–3600 秒 |
| Action Worker 仓库 Actions Variables | `GMC_WRITE_MODE` | 可选；`disabled` 或 `approval`，默认 `disabled` |
| Action Worker 仓库 Actions Variables | `GMC_CONTENT_MODE` | 可选；`disabled` 或 `enabled`，默认 `disabled` |

`production` 为共享环境，环境内可能还存在其他产品使用的凭据。MCP Hub 的中央密钥白名单会在执行源仓库入口前限制其可用密钥，但共享 Environment 本身不构成产品级隔离。不要为了方便把其他产品密钥加入 MCP Hub 的源仓库清单；Cloudflare Token 应仅授予部署所需的账户和资源权限。

### 2.2 运维专用环境

`mcp-hub-ops` 当前不在 MCP Hub 的部署环境授权列表中，也没有当前工作流 Job 绑定它。当前没有可据以配置的 MCP Hub 专属运维凭据清单。

- 保留 Environment 名称，不将它用于生产部署。
- 当前没有对应运维 Job 时，保持该 Environment 不含 MCP Hub 运行时业务密钥；不为占位而创建空 Job。
- 未来新增真实运维任务时，先定义该任务所需的最小凭据，再为专用 Job 绑定 `mcp-hub-ops`；不得把运行时业务密钥重新放回 GitHub。
- 不要把 `mcp-hub-ops` 加入 MCP Hub 的 `deploy-environments.json`；生产部署仍只使用 `production`。

Environment 是否存在、审批人和分支限制是否配置，均需运维人员在 GitHub 设置中核实。

### 2.3 Cloudflare Worker 运行时密钥与绑定

在 Cloudflare Dashboard → Workers & Pages → `mcp-hub` → Settings → Variables and Secrets 中核对以下名称。只核对名称和功能状态，不复制、导出或记录密钥值。

| Worker Secret | 用途 | 状态要求 |
| --- | --- | --- |
| `MCP_ADMIN_KEY` | 管理界面登录认证 | 必需 |
| `MCP_APPROVAL_KEY` | OAuth 授权审批 | 必需 |
| `MCP_COOKIE_KEY` | 管理会话 Cookie 签名 | 必需 |
| `MCP_KEYRING_JSON` | D1 加密凭据的 AES 密钥环 | 必需；必须保留原密钥材料 |
| `MCP_INGEST_JWK` | 浏览器凭据录入加密使用的 RSA 私钥 | 必需；必须保留原密钥材料 |
| `MCP_RUNTIME_KEY` | Runtime 派发接口 Bearer 鉴权 | 可选；启用时至少 32 字符 |

以下不是 Secret，不得误放入密钥栏：

- `MCP_PUBLIC_URL`、`MCP_ACTIVE_ID`、`GMC_WRITE_MODE`、`GMC_CONTENT_MODE`、`MCP_OAUTH_TTL`：由 Action Worker Variables 提供并写入 Worker 普通 Variables。
- `MCP_DB`：Worker 的 D1 binding，指向数据库 `mcp-hub`；其真实 UUID 来自 `MCP_D1_ID`。
- `MCP_DISPATCH_QUEUE`：队列 binding，生产队列为 `mcp-hub-dispatch`，死信队列为 `mcp-hub-dispatch-dlq`。
- `MCP_BUILD_SHA`：部署时由固定源码提交 SHA 写入，不由运维人员手工设置。

`/health` 的 `ready` 检查必需 Secret 和 D1/URL/活动密钥标识是否存在；`dispatchEnabled` 只有在 `MCP_RUNTIME_KEY` 长度至少 32 且队列 binding 可用时才为真。健康检查不能读取或证明密钥值正确，仍须进行后续功能验收。

不得重新生成 `MCP_KEYRING_JSON` 或 `MCP_INGEST_JWK` 覆盖现有材料。若 D1 中已有加密数据，替换密钥可能导致历史密文无法解密。

## 3. 工作流与数据传递边界

```text
Action Worker / prepare（不绑定 Environment）
  └─ 校验仓库、固定 commit SHA、CI Evidence、Main Write Guard、产品和环境
       └─ 仅输出非敏感元数据
            仓库、commit SHA、产品、environment、entrypoint、runner 等

Action Worker / deploy（只绑定一个 Environment：production）
  └─ 检出已校验的固定 commit SHA
       └─ 中央密钥解析器按产品策略过滤凭据
            └─ 执行 scripts/deploy.sh
                 ├─ 仅使用 Cloudflare 部署凭据
                 └─ 不接收 MCP_* 运行时密钥

Cloudflare Worker Secrets
  └─ 由 Worker 在运行时读取；不经 Job outputs 或 artifacts 转交
```

核对规则：

1. `prepare` 不绑定 GitHub Environment，不读取生产部署凭据。
2. `prepare` 到 `deploy` 的 Job outputs 只传仓库、commit SHA、环境、入口、产品目录和 Runner 等非敏感元数据。
3. `deploy` 只绑定 `production` 一个 Environment；中央密钥解析器按 `fongap-labs/mcp-hub` 的部署白名单过滤密钥。
4. MCP Hub 的源仓库入口只允许 `CLOUDFLARE_API_TOKEN_SECONDARY`。发现 `MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY`、`MCP_COOKIE_KEY`、`MCP_KEYRING_JSON`、`MCP_INGEST_JWK` 或 `MCP_RUNTIME_KEY` 进入部署 Job 时，部署脚本必须失败关闭。
5. 不通过 artifacts、Job outputs、日志、命令参数或临时 secrets 文件传递明文密钥；普通部署不使用 `--secrets-file`。
6. 部署脚本在安装依赖和运行测试前剥离 Cloudflare 部署凭据及运行时密钥；Worker Secret 由 Cloudflare 保留。

## 4. 部署前核对

- [ ] MCP Hub 目标改动已合并 `main`；中央 CI Evidence 与 Main Write Guard 均通过。
- [ ] Action Worker 的 `AW_REPOSITORY_POLICY` 已为 `fongap-labs/mcp-hub` 授予 `deploy` 能力；实际变量内容需运维人员核实。
- [ ] `production` Environment 的审批和分支保护规则符合组织生产发布要求；实际配置需运维人员核实。
- [ ] `CLOUDFLARE_API_TOKEN_SECONDARY` 已配置在 Action Worker 的 `production` Environment，且为目标 Cloudflare 账户和所需资源授权；不查看或复制其值。
- [ ] Action Worker Variables 中的 `CLOUDFLARE_ACCOUNT_ID_SECONDARY`、`MCP_D1_ID`、`MCP_PUBLIC_URL`、`MCP_ACTIVE_ID` 已核对；可选变量的值符合上节约束。
- [ ] Cloudflare `mcp-hub` Worker 的五项必需 Secrets 已存在；`MCP_RUNTIME_KEY` 是否存在与是否启用派发已明确。实际状态需运维人员核实。
- [ ] `MCP_KEYRING_JSON` 与 `MCP_INGEST_JWK` 使用的是原有密钥材料；已完成安全备份，不会用新生成值覆盖。
- [ ] Cloudflare 账户与 `MCP_D1_ID` 指向同一目标账户下的 D1 数据库 `mcp-hub`；Worker binding 名称为 `MCP_DB`。
- [ ] 已对目标 D1 完成可恢复备份，并确认数据迁移与代码版本兼容；不要把 Worker 回滚当作 D1 回滚。
- [ ] 若启用 Runtime 派发，已核实队列 `mcp-hub-dispatch`、死信队列 `mcp-hub-dispatch-dlq` 与 Worker queue binding 可用。

任何一项关键配置无法确认时，先停止部署并标记为“需运维人员核实”，不要通过生成新密钥或回退到旧 Token 绕过。

## 5. 手动部署步骤

1. 打开 Action Worker → Actions → `手动 · 部署服务`。
2. 输入 `source_repository=fongap-labs/mcp-hub`。
3. 输入 `environment=production`。
4. `source_sha` 留空以选择当前 `main` HEAD；若需固定已审查提交，则填写完整 40 位小写 commit SHA。
5. `product` 留空；MCP Hub 当前是根产品布局。
6. `main_write_guard_bypass=false`，不得绕过来源保护。
7. 启动后等待中央来源校验、CI Evidence、Main Write Guard、环境授权、Runner 与密钥白名单校验全部通过，再观察部署 Job。
8. 在 Action Worker 运行摘要中记录源仓库、commit SHA、环境、入口和结果；不得复制 Secret 值或包含凭据的环境转储。

部署脚本执行顺序为：依赖安装与验证 → Wrangler dry-run → 对远端 D1 `mcp-hub` 应用迁移 → Wrangler 部署 → 远端健康检查。健康检查失败时脚本尝试 Worker 代码回滚；D1 迁移不会自动回滚。

## 6. 部署后验收

### 6.1 提交与健康状态

- [ ] Action Worker 部署摘要中的源 commit SHA 与本次批准的 SHA 完全一致。
- [ ] `https://mcp.135468.xyz/health` 返回 HTTP 200，JSON 中 `ready=true`、`status=ok`，`build` 等于本次部署 SHA。
- [ ] `dispatchEnabled` 与预期一致：未启用 Runtime 派发时允许为 `false`；启用时必须为 `true`。

```bash
curl -fsS https://mcp.135468.xyz/health
```

### 6.2 入口与 OAuth 元数据

- [ ] `/.well-known/oauth-authorization-server` 返回成功，`issuer` 为 `https://mcp.135468.xyz`。
- [ ] `/.well-known/oauth-protected-resource` 的 `resource` 为 `https://mcp.135468.xyz`。
- [ ] `/.well-known/oauth-protected-resource/github` 的 `resource` 为 `https://mcp.135468.xyz/github`。
- [ ] 未携带 Access Token 的 POST `/` 与 POST `/github` 均返回 HTTP 401，而不是开放访问或 500。
- [ ] `/admin` 管理员登录、会话 Cookie 与授权审批流程可正常工作；不在日志、终端记录或聊天中输入/输出密钥值。

```bash
curl -fsS https://mcp.135468.xyz/.well-known/oauth-authorization-server
curl -fsS https://mcp.135468.xyz/.well-known/oauth-protected-resource
curl -fsS https://mcp.135468.xyz/.well-known/oauth-protected-resource/github
curl -i -X POST https://mcp.135468.xyz/ -H "Content-Type: application/json" --data "{}"
curl -i -X POST https://mcp.135468.xyz/github -H "Content-Type: application/json" --data "{}"
```

### 6.3 数据库迁移

- [ ] Action Worker 部署日志确认 `wrangler d1 migrations apply mcp-hub --remote` 成功。
- [ ] Cloudflare D1 中核对目标数据库名称为 `mcp-hub`、UUID 与 `MCP_D1_ID` 一致，Worker binding 为 `MCP_DB`。
- [ ] 核对当前仓库迁移文件均已应用且无待应用迁移：`0001_init.sql`、`0002_refresh_token_rotation.sql`、`0003_resource_tool_policy.sql`、`0003_runner_registry_leases.sql`、`0004_runner_dispatch.sql`。
- [ ] 若数据库已有加密 GitHub 凭据，使用授权的只读业务流程验证可正常解密和读取；不要导出密文或密钥值。
- [ ] 备份保留至迁移验收和恢复期结束。不要因 Worker 代码回滚而删除或重建 D1。

### 6.4 MCP 与 OAuth 功能

- [ ] 使用正式 MCP 客户端分别对根资源 `https://mcp.135468.xyz` 和 GitHub 资源 `https://mcp.135468.xyz/github` 完成 OAuth 授权；两者使用各自 Resource，不混用 Access Token。
- [ ] 客户端成功执行 `tools/list`。
- [ ] 选择一个已授权 Owner 的只读工具执行 `tools/call`，核对结果与权限范围；不要用创建 Issue 等写操作作为首次验收。
- [ ] 如客户端使用 Refresh Token，验证续期成功；不要并发复用旧 Refresh Token。
- [ ] 如启用 Runtime 派发，使用已登记 Runner 验证鉴权、派发、状态回报与队列消费；未启用时确认相关接口按预期拒绝或返回不可用。

## 7. GitHub 重复密钥清理

以下名称是迁移后可检查的 GitHub 重复运行时密钥候选项：

`MCP_ADMIN_KEY`、`MCP_APPROVAL_KEY`、`MCP_COOKIE_KEY`、`MCP_KEYRING_JSON`、`MCP_INGEST_JWK`、`MCP_RUNTIME_KEY`。

清理位置包括 Action Worker 的 `mcp-hub-ops` Environment、`production` Environment，以及可能存在的仓库级 Actions Secrets。是否存在重复项，需运维人员逐项核实；本手册不读取或记录任何值。

只有同时满足以下条件，才可由有权限的运维人员删除 GitHub 中的重复项：

1. Cloudflare `mcp-hub` Worker 中对应 Secret 名称已确认存在；原有 keyring/JWK 材料未被覆盖。
2. 部署后 `/health`、管理员登录、OAuth、MCP 只读工具调用均已验收通过。
3. 如 `MCP_RUNTIME_KEY` 已启用，Runtime 派发鉴权和队列流程已单独验收通过。
4. 已确认没有其他 Action Worker Job 或产品仍引用这些 GitHub Secret 名称。
5. 已记录清理审批和时间；清理动作只针对 GitHub 重复项。

`CLOUDFLARE_API_TOKEN_SECONDARY` 是生产部署凭据，不属于运行时业务密钥，不得按上述清理清单删除。不得删除仍在使用的 Cloudflare Worker Secrets。部署时没有传递某个 Secret，绝不代表线上 Secret 已被删除。

## 8. 回滚与故障处理

- Worker 健康检查失败时，部署脚本会尝试回滚 Worker 代码；检查 Action Worker 日志确认回滚结果。
- D1 迁移不会随 Worker 回滚撤销。任何恢复操作前，先核对迁移版本、旧代码兼容性和备份可恢复性。
- 若 `/health` 的 `build` 与批准 SHA 不一致，停止客户端切流，核对部署摘要与 Worker 版本。
- 若 OAuth 或 MCP 入口失败，先检查资源 URI、Token audience、Worker Variables 与 Secret 名称；不得将密钥值写入 issue、日志或聊天。
- 若 Runtime 派发失败，分别核对 `MCP_RUNTIME_KEY` 是否存在且满足长度要求、队列绑定和 Runner 状态；不要为修复普通 MCP 入口而启用 Runtime 派发。

## 9. 需运维人员核实的线上事项

| 核对项 | 当前能否由仓库确认 |
| --- | --- |
| `production` Environment 是否存在、审批规则是否符合要求 | 需运维人员核实 |
| `CLOUDFLARE_API_TOKEN_SECONDARY` 是否已配置且权限最小化 | 需运维人员核实 |
| Action Worker Variables 是否完整且指向正确 Cloudflare 账户/D1 | 需运维人员核实 |
| `mcp-hub-ops` 是否存在旧的重复 `MCP_*` Secrets | 需运维人员核实 |
| Cloudflare Worker 五项必需 Secrets 是否存在且保留原值 | 需运维人员核实 |
| 可选 `MCP_RUNTIME_KEY` 是否配置、Runtime 是否应启用 | 需运维人员核实 |
| D1 备份、迁移历史和数据可解密状态 | 需运维人员核实 |
| 队列资源、MCP 客户端 OAuth 与工具调用状态 | 需运维人员核实 |
| GitHub 是否还有其他 Job 引用候选重复密钥 | 需运维人员核实 |

本 PR 只新增操作说明，不执行真实部署，不读取或修改 GitHub/Cloudflare Secrets，不变更 D1、Worker、队列或 DNS。
