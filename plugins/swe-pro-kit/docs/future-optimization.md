# SWE-Pro Kit 后续优化候选（未纳入当前基线）

目标是在保留历史基线可复现性的前提下，分别测量 Prompt、工具能力和编排机制的收益。
本文件记录从 `2ccc521` 撤回且仍未纳入当前基线的设计思路。Task Pattern 不承接历史知识。
用户随后明确：workflow 可以重新实现，原子 Prompt 与能力保持不变。
因此 `0.3.2` 已将独立 workflow、完整采样和失败停止纳入普通 setting，历史调度改为显式 `legacy-workflow`；
这部分不再属于未来候选，当前合同见[基线设计](baseline-design.md)。下表中的 Prompt、工具和模型编排实验仍待讨论。

## 背景与边界

历史流程是 Decoder 分析、可选 Aggregator 汇总、Mapper 复现与规划、Solver 实现。
历史 harness 的 `forced-stage` 分支在 Python 中调度；Profile 方式由根 Agent 调用 Decoder ensemble、Mapper、Solver，ensemble 再调用 Decoder 与 Aggregator。
这两条路径的失败策略和工作区行为本来就不完全相同。只把它们统一成一个“更整洁”的执行器，也会改变实验条件。

`2ccc521` 曾同时缩写角色 Prompt、删减工具、改写阶段输入、共享 Decoder 工作区、扁平化 sub-agent，
并添加严格的轨迹判失败规则。这些是真实实现改动，不是单纯对历史和最新代码的描述。
即使设计有理由，也不能用一次包含多种改动的运行来证明其中某一项有效。
旧实现仍可从该 commit 取回，无需在当前运行包中保留另一套默认路径。

当前已落实的合同见[基线设计](baseline-design.md)；当前与历史验收见[验收记录](acceptance.md)。
关联讨论集中在 [Issue #4](https://github.com/yiikou/CodeHelix-Plugin/issues/4)，不另拆迁移工单。
安装继续遵循[统一安装设计](../../../docs/specifications/plugin-installation-unification-overview.md)、
[生命周期规范](../../../docs/specifications/installed-package-lifecycle.md)和[custom installer 协议](../../../docs/specifications/custom-installer-protocol.md)。

## 候选与待验证问题

| 候选 | 为什么值得研究 | 改变了什么，必须如何单独验收 |
|---|---|---|
| 缩短角色 Prompt | 可能减少输入成本、重复约束和指令冲突 | 会丢失原有分析格式、复现要求、修复原则；使用独立 Profile/bindings，对比通过率、token、耗时及输出完整度 |
| 限制 Decoder/Mapper 工具 | 限制阶段副作用，使职责更容易检查 | Mapper 原本必须创建并运行 `reproduction.py`；去掉写入/Shell 是能力消融。分别实验，不能直接称为等价优化 |
| 统一阶段输入协议 | 明确完整传递和字段解析，减少自由文本歧义 | 原有 XML、措辞、完整计划和防泄漏提醒都属于模型输入；保留历史模板，另开显式版本进行对照 |
| 共享只读 Decoder 工作区 | 可能减少 worktree 准备开销 | 仅删写工具不等于文件系统只读，Shell/扩展工具仍可能造成污染；先测真实隔离、未提交文件、异常清理，再测开销 |
| 扁平 root 调用全部原子角色 | 减少一层 ensemble 模型调用，简化工具树 | 会改变根 Agent 的任务、上下文和调度决策；作为独立 setting 比较，不能修改四个原子角色 |
| 强制阶段顺序/次数/并发检查 | 可以识别模型没有按配置组织调用 | 事后判失败并不能阻止错误顺序，也不能证明完整传参；先作为观测报告，是否影响 trial 结果需另行确认 |
| 统一两条历史路径 | 减少代码与 Profile 编排的差异 | 当前二者的零成功/单成功/汇总失败、工作区隔离行为不同；应先列差异及复现，再决定采用哪份合同 |

## 下一轮工作方式与职责

插件维护者先固定当前基线的 commit、角色内容、setting、bindings、模型与预算，再为每个候选建立独立实验配置。
Prompt 和工具变更由 Profile 承担，编排变更由 setting/组织模板承担；Chrys Adapter 只负责宿主加载和工具路由，
Harbor 负责环境与评分，CodeHelix 负责安装与所有权，不应由安装器选择实验算法。

实验需要同时保存原始 trial、完整阶段输入输出、工具轨迹、token/耗时和评分。
先做工作区隔离、输入完整传递、失败分支的离线验证，再在同一任务集合上比较真实结果。
只有提出明确变更、得到范围确认并完成对照后，才决定是否纳入新的默认基线。
此前 `0.3.0` 的实机记录属于被撤回的混合方案，不能用于宣称`0.3.1` 或 `0.3.2` 性能已经验证。
