# 项目概览

## 目标

构建可审计、可恢复、受控的智能巡检诊断 Agent：从遥测系统采集证据，生成有依据的诊断与建议；真实保护动作属于后续阶段，必须经过白名单、风险门、人工确认、幂等执行和结果验证。

## 范围与边界

- 当前项目是独立实现的 TypeScript Agent；Newton 只作机制参考，未经授权不得复制其他项目源码。
- 当前已实现多遥测模拟/验收链路、Agent Web、Event/Message V2、持久化与记忆治理等能力。具体完成状态以代码和 [STATUS.md](./STATUS.md) 为准。
- 第一阶段以只读诊断和模拟验证为界；不修改 `group-buy-market` 业务仓库，不宣称模拟数据等于生产业务验收。
- 按用户当前要求，后续常规开发验收持续使用本地模拟指标和日志；不为验收重新部署 `group-buy-market`，也不要求连接真实业务数据源。真实目标接入不属于当前验收路径。
- 真实模型、真实生产数据、真实动作和完整生产授权体系须分别验收，不因离线测试通过而视为完成。

## 技术架构

- Node.js 24、TypeScript、pnpm 11；工作区含核心服务和 `apps/agent-web`。
- 主要边界：`contracts` 定义稳定契约，`application` 编排用例，Agent/Tool/Guard/Hooks 执行诊断，`infrastructure` 提供 SQLite、遥测和外部适配，`bootstrap` 组装依赖。
- 目标设计、模块说明和分阶段路线见 [架构知识库](./README.md) 与 `docs/architecture/`。

## 常用命令

在仓库根目录运行：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm web:typecheck
pnpm web:build
```

完整脚本和环境约束见根目录 `package.json`、`AGENTS.md`。涉及核心机制时按 `AGENTS.md` 执行质量门；没有实际运行的检查不得登记为通过。

## 迭代方式

当前产品里程碑按[本地多项目只读巡检系统 Spec](./superpowers/specs/2026-10-21-local-inspection-product-design.md)与[实施计划 S0–S6](./superpowers/plans/2026-10-21-local-inspection-product.md)推进：S1 普通宿主 Target 双来源接线已在本地模拟环境通过 L01–L03；S2.1 MemoryCoordinator 装配和 S2.2 本地 Semantic/Procedural 审核发布及实际模型输入已实现，跨 Target、重启、关闭、撤销、到期及 Web 治理闭环均有组合验收。S2 仍缺拒绝后不注入、来源状态变化、治理存储故障/超时、显式 Abort、required 知识缺失门禁及逐类型预算边界断言，L04–L05 继续进行中。详见[本地知识验收记录](./verification/2026-10-22-local-knowledge-integration.md)。S3 场景与模型质量、S4 持久化周期巡检、S5 站内结果处理、S6 本地运行/恢复/发布尚未实施。真实模型质量与离线工程通过分开验收；对外认证授权、真实告警/通知渠道及真实业务接入另立里程碑。

前轮[多来源韧性计划](./superpowers/plans/2026-10-21-multisource-memory-resilience.md)的 A–D 已有本地实现与验收记录，后续接线复用并回归这些机制，不再把 R08/R09、Clock 或独立用例隔离列为未实现。GitHub 交付结果以最新 STATUS 为准。所有常规验收继续使用本地模拟服务，不重新部署或修改 `group-buy-market`。M2b 仍需可证明身份的旧数据；记忆审核 API 对外开放前须完成身份与授权设计。

每个对话推进一个可验收任务；大任务按可独立验收的阶段交接。任务说明目标、范围、验收条件和约束。每完成一个任务或阶段，先核对验收条件，更新 [STATUS.md](./STATUS.md)，将本任务改动独立提交并推送到 GitHub 工作分支，然后标记完成或转入下一项。只有目标或架构改变时更新本文件，重要设计决策记录在 [DECISIONS.md](./DECISIONS.md)，规则改变时更新根目录 `AGENTS.md`。详细历史进度保留在 [implementation-status.md](./implementation-status.md)。

新对话可从下面的指令开始；同一任务的后续轮次仍需重新核对工作区，而不直接把文档快照当成最新代码事实：

```text
继续 opsagent 项目。先读 AGENTS.md、docs/PROJECT.md、docs/STATUS.md，
再读 docs/DECISIONS.md 中与本任务相关的记录；检查当前分支、未提交修改、相关代码和测试。
本次目标：[目标]
范围：[涉及模块和不涉及内容]
验收：[可观察的完成条件]
约束：[兼容性、依赖、性能、安全边界等]
修改前简述当前状态和实施范围；保留已有无关修改。每个可验收任务或阶段结束时更新 docs/STATUS.md，并只将本任务改动提交和推送到 GitHub。
```

新对话必须访问同一个 `opsagent` 工作目录，或取得同步后的仓库及文档。跨机器或新环境时，先从 GitHub 同步相应工作分支；未提交文件仍只存在于原工作区。文档只能保留上下文，不能替代代码审查、运行环境和每阶段验收。
