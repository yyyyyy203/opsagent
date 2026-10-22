# 本地单操作员受治理知识审核

- 日期：2026-10-22
- 状态：已采纳，仅用于 loopback 本地模拟宿主。
- 背景：Target 知识审核和发布端点已存在，但 SQLite 持久化默认注入拒绝型 authority/actor，因此显式本地安装也无法完成草稿审核与发布。
- 决策：仅当宿主显式启用本选项且 HTTP server 绑定 loopback 时，SQLite 可使用固定 `local-operator` 身份审核和发布。审核 scope、知识状态及当前来源 epoch/digest 从持久化记录解析；请求 DTO 不得提供 actor、scope 或来源状态。审核 Attestation 仅表示本地操作员通过审核端点作出确认，不改变来源、scope、内容、有效期或状态资格检查。
- 安全边界：Agent Web 宿主当前只允许 `127.0.0.1` 或 `localhost`。配置不启用时继续使用拒绝型默认 authority。该身份模型不得用于对外或多用户部署；对外开放前必须以真实身份/角色授权替换，并单独验收审计归属。
- 兼容性：不改变 Knowledge Review、Publication、Target Reference 或 SQLite Schema；新增为可选宿主组装参数。既有宿主默认行为不变。
- 验收：默认宿主拒绝审核；显式本地模拟宿主能完成 Semantic/Procedural 创建、提交、审核、发布与召回；审核 scope 与源状态由存储记录确定；跨 Target 不注入；禁用记忆不注入。
