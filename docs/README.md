# MCP Hub 文档索引

本目录按产品模块、运行操作和迁移主题组织。产品入口与安全边界见 [仓库 README](../README.md)；共享工程治理以 [Action Worker](https://github.com/fongap-labs/action-worker/tree/main/docs) 为准。

## 服务与协议

- [MCP 服务模块](MCP_MODULES.md)：服务注册、工具与路由边界
- [Runner Protocol](RUNNER_PROTOCOL.md)：Runner 注册与租约协议
- [Runner Dispatch](RUNNER_DISPATCH.md)：任务派发、取消与 Runtime 对账
- [Runtime Runner 集成](RUNTIME_RUNNER_INTEGRATION.md)：Hub 与可信运行时的集成

## 安全与开发

- [授权任务接入](AUTHORIZED_TASK_INTAKE.md)：可信任务入口和授权边界
- [本地编码 Runner](LOCAL_CODING_RUNNER.md)：本地开发 Runner 配置
- [TypeScript 迁移](TYPESCRIPT_MIGRATION.md)：运行时迁移说明
- GitHub PR 交付见 [GITHUB_PR_DELIVERY.md](GITHUB_PR_DELIVERY.md)

## 运维与迁移

- [中央部署](CENTRAL_DEPLOY.md)：Action Worker 受控部署合同
- [迁移验收](OPERATIONS_MIGRATION_ACCEPTANCE.md)：运维迁移检查与验收
- [MCP Hub 迁移](MCP_HUB_MIGRATION.md)：服务与数据迁移步骤

实现、配置和测试是当前行为的事实来源；本索引只导航权威说明，不复制其规则。
