# SWE-Pro Kit：纯评估基线、原子 Profile 与统一安装

本文件是 [Issue #4](https://github.com/yiikou/CodeHelix-Plugin/issues/4) 的本地更新草稿，未发布到 GitHub。
2026-09-17 的用户确认范围替代旧稿中“保留可选历史 knowledge”的要求。

## 用户目标与背景

使用者需要一个单独可运行的 SWE-bench Pro 基线，用它评估不含增量技术的表现；随后保持组织方式不变，
替换 Decoder 等原子角色来比较 Compass 或其他技术。历史流程混合了多 Decoder 汇总、工作流/Agent 编排和知识能力，
需要分开维护。历史知识先归档，不由 Task Pattern 承接；组合插件暂时保留。

原子 Profile 决定角色的 Prompt 与显式能力；setting 决定串并行和调用方式；bindings 将角色绑定到具体 Profile。
Harbor/Chrys 适配是评估基础设施，CodeHelix 负责安装管理。详细解释见 [插件设计](baseline-design.md)。

角色 Prompt 与能力不调整；workflow 获准独立重写。`0.3.2` 普通 setting 使用干净 workflow，
历史 forced-stage 调度仅在 `legacy-workflow` 中启用。其他候选见[后续优化](future-optimization.md)。

## 已落实工作

- 创建非活动归档 `swe-pro-kit-202608`，保留重构前内容和哈希；不删除组合插件。
- 干净基线交付四个原子 Profile、六种 setting、独立 bindings；移除历史 knowledge 和相关 Skill。
- 业务运行时外置到固定 Package，Chrys 仅保留最小接线；任务工具通过 Harbor environment 执行。
- 使用共享受管事务管理固定包、精确 activation、解释器 binding、回滚与卸载；不自动安装宿主依赖。
- 默认禁止隐式加载宿主 Skills/hooks，凭据由启动环境注入；运行记录所选配置和阶段执行。

实现应持续遵循[统一安装设计](../../../docs/specifications/plugin-installation-unification-overview.md)、
[生命周期合同](../../../docs/specifications/installed-package-lifecycle.md)与
[custom 协议](../../../docs/specifications/custom-installer-protocol.md)。共享框架负责事务与管理，插件维护者负责运行时与适配证明。

## 验收与剩余工作

离线、隔离宿主与真实模型验证记录集中在 [acceptance.md](acceptance.md)，以实际执行结果为准。
完整源码来源移走后，新进程仍须加载固定包，inspect/remove 须可用；删除受管部署不得删除用户结果。
原子 Profile 替换不应改变 setting；编排变更不应修改原子 Profile；普通 workflow 必须按 setting 执行完整采样和汇总；历史单成功/零成功回退只在 legacy setting 中保留。

真实 provider/模型、来源删除与卸载证据见 [实机记录](live-validation.md)。
实际 Plugin Management UI 安装与新版本 Chrys 适配仍须分别验证。
离线 fixture 与真实 Chrys 引擎的 mock 模型证据均不能替代 SWE-bench Pro 分数。
原地接管历史 overlay、把历史知识迁入其他插件、创建 Compass 组合插件均不属于本轮已实现结果。
