# SWE-Pro Kit 验收记录

当前问题、2026-10-04 实测及 main 整合状态见[本轮联合验收记录](../../../docs/acceptance/taskpattern-swe-pro/2026-10-04/issues/README.md)。以下记录保留其原日期与验证范围。

## 0.3.2：TaskPattern 真实冷启动评估（2026-10-02）

使用真实 OpenRouter provider、Chrys/iCode 0.20.1、SWE-Pro 受管 Harbor 0.7.0 和一个文件数为 0 的
TaskPattern data root，完整执行固定 `taskpattern-evaluation`。Decoder 通过 GitHub 实时检索生成知识并
向分析阶段返回 general knowledge；Mapper 命中 Decoder 生成的 Artifact，并补齐一个首次 provider
失败的候选；Solver 3/3 命中缓存。三个角色均恰好完成一次 Search 和一次 Apply，Solver 产出单行 patch，
Harbor verifier 通过并得到 reward `1.0`，trial 无异常。总耗时 23 分 45 秒，TaskPattern 单请求冷启动
timeout 固定为 1000 秒。完整无密钥证据见[实机验收目录](evidence/2026-10-02-taskpattern-live/README.md)。

Windows 上 Chrys 0.20.1 在进程退出后的 stdio MCP 异步生成器清理仍打印 AnyIO warning；该 setting
已隔离同步关闭以避免阶段间挂死，warning 出现在成功结果和 verifier 写入之后，不影响 trial 状态。
这是一条真实链路冒烟验收，不代表全量 SWE-bench Pro 性能结论。

同机执行十个根目录 `test_swe_pro_*.py` 模块的宽回归得到 **103 passed、13 skipped、29 failed、
6 errors**。失败集中在旧测试对 `/bin/bash`/WSL、Windows 上的 `npx` 可执行名，以及将 Windows host
临时路径当作 `/app` 容器路径的假设；未把这些结果伪装成通过，也未为本轮改写旧基线行为。隔离说明和
代表性错误见[Windows regression boundary](evidence/2026-10-02-taskpattern-live/windows-regression.md)。

## Chrys 0.28 接入（2026-09-29）

新增 0.28 Adapter，实际 PackageStore 安装包在 Chrys 0.28.0/Harbor 接口下 **16 项通过**，
覆盖任务 I/O、Git 恢复、单/多 Decoder 与嵌套执行；受管检查及卸载恢复通过。
上述第一阶段响应由 MockChatClient 提供。随后真实模型与 Docker 的分页集成任务 reward 1.0，
正式 Teleport 任务 reward 0：模型补丁与官方测试接口不符，测试编译失败，三个目标测试未执行，
Harbor 无运行异常。修复无人值守审批等待后，宿主运行回归 19 项通过。
新 target 保持 `fixture`。实现与证据见 [0.28 适配记录](../../../docs/acceptance/chrys/chrys-0.28-adaptation.md)与
[在线评测记录](../../../docs/acceptance/chrys/chrys-0.28-live-evaluation.md)。以下记录保留为各自日期的证据。

## 0.3.2：独立 workflow 与可选 legacy（2026-09-17）

本轮授权边界是“可调整 workflow，保持原子 Prompt 和能力”。普通 workflow 预设选择新执行器，
历史 forced-stage 调度移至 `legacy-workflow`；安装与知识清理范围不变。

可观察验收包括：普通 workflow 不导入历史调度模块；全部成功时两者调用的角色和完整输入相同；
普通 workflow 在执行异常、宿主失败、空结果时停止；并行取消完成后才清理目录；`aggregate` 控制汇总，
legacy 仍通过原有零/单/多有效样本分支测试。四个原子 Profile、组织模板及阶段输入均未修改。

完整关联 Python 回归 **162 passed，45.04s**；共享框架 **166 passed**；两款 SWE 插件的交付锁与隔离重建 **4 passed**。
在新临时 Chrys checkout 安装实际 `0.3.2` Delivery 后，从 PackageStore 运行 clean 单/三 Decoder、legacy、嵌套串/并行共 **5 passed**；
随后 inspect、卸载和六个宿主文件恢复检查通过。`build`、`validate`、`git diff --check` 通过。
角色 Profile、组织模板与阶段 Prompt 相对 `248e023` 没有文件差异。摘要见[本轮验证](evidence/2026-09-17-clean-workflow/validation.json)。
使用真实 Chrys/Harbor 的离线 MockChatClient 用例不代表真实模型或全量 SWE-bench Pro 性能。
以下 0.3.1 与 0.3.0 记录保留为对应版本的历史证据。

## 0.3.1：恢复历史行为（2026-09-17）

本轮按用户要求撤回 `0.3.0` 对 Prompt 和流程语义的改写，只保留安装与外围结构重构。
当前行为见[基线设计](baseline-design.md)，撤回方案记录于[后续优化候选](future-optimization.md)。

- 四个原子 Profile 与归档比较，只有安装名称变化；完整 Prompt、工具权限、compaction/approval 字段保留。
- Decoder/汇总/Mapper/Solver 及根输入，与旧 harness 关闭知识后的输出逐字比较，覆盖长 issue、多行文本和防泄漏开关。
- 两个 worktree helper 的 AST 与归档相同（仅 Runner 类型名改变）；真实 Git 仓库验证祖先保留、gold 后代对象不可达、各 Decoder 修改隔离、初始未提交文件、清理及 verifier 恢复。
- 真实 Chrys/Harbor 离线运行验证 Mapper 能写入并运行复现脚本、Decoder 保留只读 Shell、嵌套调用和串并行 setting；不会强制按轨迹判失败。
- Chrys 0.20 将历史 `reserved_context_pct` 视为已废弃字段。测试明确验证其加载为宿主默认 compaction，而非声称旧阈值生效。

本轮指定真实隔离宿主后，关联 Python 回归 **131 passed，44.45s**；共享框架 `npm test` **166 passed**；
两款 SWE 插件交付锁与隔离重建 **4 passed**；历史备份 **119 个文件的哈希与 mode 全部一致**。
恢复后的真实 Delivery 在新的临时 Chrys checkout 完成受管安装，从 PackageStore 加载运行的 workflow/嵌套串并行用例
**3 passed**，随后 inspect、卸载和六个宿主文件恢复检查通过。使用 MockChatClient 与临时本地任务环境，未调用真实 provider。
`build`/`validate` 和 `git diff --check` 通过，摘要见[本轮验证制品](evidence/2026-09-17-restoration/validation.json)。

以下 `0.3.0` 证据保留追溯，不能作为恢复后基线的性能证明。
恢复后尚未重跑真实模型 SWE-bench Pro 任务或全量 benchmark；没有新的性能结论。

## 0.3.0 历史记录（行为改写已撤回）

2026-09-17。本轮交付的是清理后的基线实现与受管安装，不包含全量 SWE-bench Pro 性能结论。
历史知识留在 `swe-pro-kit-202608`，未迁入 Task Pattern；组合插件继续保留。

## 已执行的证据

| 层次 | 验证方式 | 能证明什么 |
|---|---|---|
| 交付与入口 | build/validate 通过；隔离重建 40 个文件一致；两款 SWE 插件的 4 项锁回归通过 | 活动 Source 与 Delivery 一致，保留的组合插件仍可重建 |
| 原子配置与执行 | setting/workflow 回归；实际 Chrys 0.20.1 loader 逐字段检查 | 五种配置可组合；多 Decoder 必须汇总；Profile 字段不会被静默忽略；角色可替换 |
| 受管安装 | 真实共享 Kit + 最小离线 Chrys/Harbor fixture | prepare 不写入，12 项 activation 受管；来源移走后新进程可加载与启动；固定包只读；冲突阻断、失败回滚、卸载恢复 |
| Chrys 运行链 | 15 项通过：真实 0.20.1 AgentEngine / 工具注册 / Harbor BaseAgent，使用 MockChatClient 与临时本地任务环境 | workflow、sub-agent 串行/并行实际调用任务工具；生成补丁、隔离与恢复 Git；准确记录成功及失败成本；不代表真实 provider |
| 核心架构 | 2 项架构测试通过；阻断 Chrys/Harbor/Adapter 导入后运行替代执行器 | core 的契约与调度不依赖具体宿主 |
| 真实容器与模型 | OpenRouter DeepSeek V4 Flash + Harbor Docker；详细结果与制品摘要见 [实机记录](live-validation.md) | 真实工具调用、评分、来源删除后的运行与卸载；不推导全量 benchmark 分数 |
| 批量启动 | 临时路径与 fake Harbor CLI | 显式 setting、路径带空格、参数原样传递、按结果续跑、无结果时停止 |
| 共享框架回归 | `npm test`：154 项通过 | 共享安装、状态、来源、管理入口与 Adapter 合同未回归 |
| 历史保存 | 对 `snapshot.json` 逐文件重算哈希与 mode | 119 个原始文件与归档记录一致 |

新增的 Python 回归分布于 `tests/test_swe_pro_settings.py`、`test_swe_pro_harbor_runtime.py`、
`test_swe_pro_architecture.py`、`test_swe_pro_managed.py`、`test_swe_pro_batch.py`、`test_swe_pro_kit_delivery.py`、`test_swe_pro_launch.py`。
真实宿主用例可选择执行；没有该环境时会明确 skip，不能将 skip 算作通过。
最终代码指定真实宿主后的关联回归为 **118 passed，40.44s**，包含全部 `test_swe_pro_*.py`、
`test_standalone_target_discovery.py`、`test_root_entry.py` 和 `test_plugin_root_cli.py`。
超时修复后重新运行两款 SWE 插件的交付锁与隔离重建：**4 passed，0.78s**。
共享框架的 154 项结果来自本次重构较早阶段，不将其描述为最后一次新运行。

推送主干前，以 `3d8093e` 为集成基点（包含 Experience Advisor、Task Pattern 与共享安装框架更新）复验：
关联 Python 测试 **118 passed，38.98s**，共享框架 `npm test` **166 passed**，
两款 SWE 插件的交付锁与隔离重建 **4 passed**。
此次补强了“缺少 Harbor”负向用例的环境隔离，避免误用测试机已有 Harbor；评估业务及 Delivery 未修改。

重构早期额外运行仓库整体 Delivery 锁测试时，发现未改动的 `task-pattern-advisor` 重建结果与旧锁有三处差异：
`delivery-lock.json`、`source-lock.json`、runtime 的 `CHECKSUMS.sha256`。本轮保留该现场，
不将两款 SWE 插件的通过结果扩大为全仓库锁测试通过。

## 复核环境与复现

宿主代码从 Chrys commit `0dd38d8d42ad65480f19279ea71383ede89f6a83` 导出到临时目录后应用本插件补丁。
Python 3.14.3 借用现有解释器；缺失依赖只放入临时测试目录，没有修改用户 Chrys checkout 或其 venv。
Harbor BaseAgent 来自本地 Harbor 0.7.0 源码。上述离线任务工具测试通过 Harbor environment 的 exec/upload/download 合同落到临时本地仓库。
另建独立 Python 3.14.3 环境执行真实 Docker/OpenRouter 验收，见 [实机记录](live-validation.md)。
真实容器回归还确认：缺失文件保留诊断，超时子进程被停止，后续命令可继续执行。

普通回归：

```bash
uv run pytest -q tests/test_swe_pro_*.py tests/test_standalone_target_discovery.py
npm test
npx . build swe-pro-kit
npx . validate swe-pro-kit
```

真实宿主 gate 需要在隔离的、已应用 Adapter 的 Chrys 上运行，解释器同时可导入对应 Chrys 与 Harbor：

```bash
SWE_PRO_TEST_CHRYS=/absolute/isolated-chrys \
SWE_PRO_TEST_PYTHON=/absolute/prepared-python \
PYTHONPATH=/absolute/isolated-chrys/src:/absolute/harbor/src \
/absolute/prepared-python -B -m pytest -q \
  tests/test_swe_pro_kit_delivery.py tests/test_swe_pro_harbor_runtime.py
```

## 范围与后续验收

- 最终包完成一个正式 SWE-bench Pro task：reward 0.0、Harbor 异常 0；模型实现未通过测试。
  三次小型任务均 reward 1.0，不能充当 benchmark 性能样本。详细归因与制品摘要见实机记录。
- 在实际 CodeHelix Plugin Management UI 安装并运行，不能用共享事务测试替代 UI 证据。
- 对其他具体 Chrys commit 单独建立 Adapter/能力与运行证据；当前不宣称通用跨版本支持。

当时的 0.3.0 sub-agent 模式是模型驱动的调用，再按轨迹验收顺序、完整性及并发重叠（0.3.1 已撤回此规则）；没有提前拦截错误顺序或证明完整传参。
fixture 成功不代表真实模型一定遵守。workflow 模式提供确定的阶段调度。

旧安装原地接管不在本轮已支持范围；已有 legacy overlay 应保留用于复现，在干净的受支持 checkout 安装新版。
