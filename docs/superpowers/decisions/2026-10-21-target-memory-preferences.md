# Target Run 记忆偏好契约决定

- 日期：2026-10-21
- 适用：M4 Target Run 创建和 Episodic 记忆接线

Target Run 创建请求允许可选的 `memoryPreferences.capture` 与 `memoryPreferences.recall`，字段沿用现有记忆偏好枚举。Target 身份、记忆 scope、策略版本和数据来源仍由宿主根据解析得到的冻结 Snapshot 决定；请求体不接受 `profileId`、scope、策略 revision、trusted control 或 Semantic/Procedural 偏好。

未携带 `memoryPreferences` 的旧 Target 请求保持原请求摘要格式和行为。携带偏好的新请求把规范化的 capture/recall 字段纳入幂等摘要；相同幂等键配不同偏好返回冲突。宿主只在偏好与已注册的完整 Target `MemoryScope`、当前 profile policy 一致时生成可信 `RunMemoryControl`。未注册的 Target scope 保持关闭默认值；请求偏好不能开启宿主未启用或未允许的记忆能力。

旧 `/runs`、`/memory` 路由继续只服务模拟 Profile。Target 专属 profile 会从这些旧记忆入口拒绝，Target 记忆读写必须通过 Target 路由并先核验绑定与 Snapshot scope。
