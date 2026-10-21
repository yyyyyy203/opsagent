# 项目状态

更新时间：2026-10-21（Asia/Shanghai）

当前仓库：`/Users/yumohan/Documents/ChatGPT/巡检项目/opsagent`

当前分支：`codex/event-message-v2`

GitHub 远端：`https://github.com/yyyyyy203/opsagent.git`

## 当前阶段

- **M4：完成。** Target 工作台、作用域读写边界、旧入口隔离、Target 记忆和双模式 Web 已实现并通过回归。
- **M5：完成（本地模拟验收）。** Spec §13 的适用项、双 Target 浏览器、容量、负载及全仓质量门通过。结果和限制见 [M5 验收记录](./verification/2026-10-21-multi-project-m5-acceptance.md)。
- **M2b：M2b.1 盘点完成，M2b.2 未触发。** 当前工作树未发现数据库文件，`AGENTOPS_DATA_DIR` 未配置，没有可核验候选；未创建历史绑定或迁移写路径。详见 [M2b 盘点报告](./verification/2026-10-21-m2b-inventory.md)。

## 验证

- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过。
- `pnpm test`：215 个文件通过、5 个 opt-in 文件跳过；2241 项通过、9 项跳过。
- `pnpm web:typecheck`、`pnpm web:build`：通过。
- `pnpm e2e:multi-target`：1/1 通过。
- `pnpm acceptance:multi-target-capacity`、`pnpm acceptance:multi-target-load`：通过。

新增验收均使用本地模拟 Target、ScriptedModel 和模拟来源，没有连接真实 `group-buy-market`、生产 Prometheus/ELK、在线模型或 LangSmith。因此，真实业务目标接入和生产验收仍是后续阶段；M2b 若要继续，需要宿主提供旧数据库及可信历史身份元数据来源。

## 下一步

如继续推进业务项目巡检，下一阶段应为 `group-buy-market` 配置只读 Target 和指标映射，完成连接权限及数据窗口核对，再单独进行真实 Prometheus 只读验收。历史 Run 迁移只有在宿主提供可证明身份的旧数据后才继续。

逐文件实施记录：[M4 计划](./superpowers/plans/2026-10-20-multi-project-m4.md)、[M5 计划](./superpowers/plans/2026-10-20-multi-project-m5.md)、[M2b 计划](./superpowers/plans/2026-10-20-multi-project-m2b.md)。实现与验收已提交到本地分支；推送尚未完成：GitHub HTTPS 443 连接超时，SSH 返回 `Permission denied (publickey)`。远端分支仍指向此前的 `2a7f99b`；本地本轮提交及本状态更新待推送。需要接通 GitHub 后再同步 `codex/event-message-v2`。
