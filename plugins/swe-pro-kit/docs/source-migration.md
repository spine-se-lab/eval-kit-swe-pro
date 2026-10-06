# SWE-Pro Kit 来源与历史保存

新版 0.3 的目标是干净的 SWE-bench Pro 评估基线。`0.3.1` 恢复归档中 Decoder、Aggregator、Mapper、Solver 的完整 Prompt 与工具配置，
重新分离原子 Profile、运行 setting、角色 bindings 与 Harbor/Chrys 适配。

旧插件最初从 Chrys 的 `swe_pro_kit` 快照迁入，混合了 Profile 编排、知识检索、计划生成和十二个宿主文件副本。
用户另提供 `/Users/yiikou/WorkSpace/chrys` 的历史分支作参考；本轮读取的是
`origin/feat/lingxi-knowledge-fusion-upgraded`，commit `119e52ecd8de132a7def2c5ee214f343e8ad20e7`。
没有切换或修改该工作区，也没有把该分支的历史评估指标当作新版结果。

重构前的插件完整保存为 [swe-pro-kit-202608](../../../archives/swe-pro-kit-202608/ARCHIVE.md)，
包括当时未提交的修复草稿与原始 Delivery。`snapshot.json` 记录逐文件 SHA-256 与 mode，原 Delivery 未重建。
该目录不是活动插件，命名中的 202608 是用户指定的备份名称，不声称内容创建于八月。

`swe-pro-kit-with-taskpattern` 仍是独立保留的组合插件，与旧纯插件并非逐文件重复；后续再决定留存。
历史知识代码暂存在备份，**不迁入 Task Pattern**。当前 Source 与 Delivery 均不包含它。

新版业务源在 `source/package/`，默认资产在 `source/assets/`，最小宿主接线在 `source/adapters/`。
Adapter 使用独立的 Chrys 0.28.0 基准 `5344293d0dc95a42d2883c9470b901ae0d48c553`。
构建锁记录仓库基点、Adapter 基准及当前 Source 树摘要；本轮未提交的源码以树摘要识别，不伪称已有发布 commit。

`0.3.0` 的行为改写及后续候选见 [future-optimization.md](future-optimization.md)。恢复测试直接读取归档作对照，不修改原始备份。

`0.3.2` 在保留四个原子角色与阶段输入的前提下，独立实现 `core/workflow.py`；
`0.3.1` 抽取的历史调度移入 `core/legacy_workflow.py`，由同名 legacy setting 显式选择。
工作区安全与恢复作为共用基础设施继续复用，不把历史样本选择逻辑混入普通 workflow。
