# SWE-Pro Kit 0.3 安装迁移

目标：把干净的评估基线固定到 CodeHelix PackageStore，Chrys 只保留受管接线；来源目录移走后仍能运行、检查和卸载。
本轮同时移除历史知识增强，具体边界见 [基线设计](baseline-design.md)。历史知识不迁移到 Task Pattern。

## 已实现的安装边界

| 对象 | 安装落点 | 所有者 |
|---|---|---|
| 评估实现、setting、bindings、Adapter、批脚本 | `CODEHELIX_HOME/package-store/` 固定包 | CodeHelix |
| 四个 SWEPro Profile | 指定 `config_root/agents/` | 当前部署的精确 activation |
| Chrys runner/skill/workflow 接线 | 十一个已知宿主文件中的小补丁 | 记录前后摘要并由事务恢复 |
| Harbor 薄入口 | `src/chrys/orchestration/swe_pro_baseline.py` | 当前部署 |
| 任务工具与嵌套 Agent 桥接 | `src/chrys/service/task_environment.py`、`src/chrys/orchestration/task_nested.py` | 当前部署 |
| 运行启动器 | `config_root/swe-pro-kit/run.py` | 当前部署 |
| Chrys/Harbor Python | 现有解释器的外部 binding | 用户；不安装依赖、不卸载环境 |
| 模型模板、数据集、镜像、结果 | 用户指定的外部位置 | 用户/Harbor；不随卸载删除 |

使用[统一安装设计](../../../docs/specifications/plugin-installation-unification-overview.md)与
[生命周期规范](../../../docs/specifications/installed-package-lifecycle.md)中的 prepare/commit/verify、ownership 和 rollback。
插件四阶段 installer 只负责能力探测与精确 activation，不能单独绕过 managed 上下文写入。

完整仓库 CLI、独立 Delivery 来源与 Plugin Management 使用共享框架。
独立 Delivery 本身不再嵌入另一套 Plugin Kit；在 CodeHelix Plugin 仓库执行 `npx . add /absolute/delivery/...` 导入。
安装后共享框架保留独立管理入口，不依赖该来源目录。

## 宿主与升级

当前接线基准是 Chrys 0.28.0 commit `5344293d0dc95a42d2883c9470b901ae0d48c553`。
检查 Python、真实 Chrys/Harbor import、Profile loader、Harbor CLI 和接入文件摘要；仍以 fixture 等级发布，
安装探针不等于真实任务已通过。新版本或已有修改不匹配时，在写入前返回具体冲突。

对于已经安装旧 Lingxi 整文件 overlay 的 checkout，本轮不推断其归属并自动回收。
保留旧环境用于历史复现，在干净且符合基线的 Chrys checkout 安装新版，是当前明确支持的迁移路径。
模型非敏感模板可以单独复用；不要把知识 Skill 或旧 overlay 整体复制到新基线环境。
旧 runs、知识数据与组合插件保留。以后如需原地迁移，需要先证明旧文件所有权。

托管新版的重复安装会检查自身 post-state；文件被修改时阻止覆盖。卸载恢复受管宿主文件，删除本部署新建的
Profile 和入口，保留用户文件及结果。具体命令见 [README](../README.md)，测试证据见 [验收](acceptance.md)。

从使用旧 `chrys.swe_pro_baseline` 入口或旧六文件补丁的受管安装切换到本轮原生 workflow 接线时，
先等运行中的评测结束，再使用原安装的 Home、target、config-root 执行 `remove`，确认恢复后重新 `install`。
不要直接覆盖不同摘要的宿主文件。统一 `run.py` 的用户接口不变；手写 Harbor 命令应将
`--agent-import-path` 更新为 `chrys.orchestration.swe_pro_baseline:ChrysAgent`。
任务工具桥接位于 service 层，避免工具注册器向上导入 orchestration；Harbor 入口也不再创建
宿主分层表未登记的根级模块。
