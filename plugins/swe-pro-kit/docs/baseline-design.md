# SWE-Pro Kit 基线与组合边界

目标是让使用者先得到一个可单独执行的 SWE-bench Pro 基线，再在相同任务和组织方式下替换原子能力，
比较新技术带来的影响。安装方式、评估基础设施、Agent 能力、Agent 组织方式应分别维护。
本设计依据用户在 2026-09-17 确认的范围，替代旧方案中“保留可选 knowledge”的要求。

## 历史与术语

Chrys 历史 SWE 实验包含 Decoder 分析、Mapper 规划、Solver 实现；多个 Decoder 之后由 Aggregator 汇总。
其中既有脚本工作流，也有 Profile 内的 sub-agent 组织，还混合了历史相似问题检索和计划生成。
用户明确的边界是保留原子角色 Prompt 与能力，允许重新设计 workflow。`0.3.2` 提供独立实现的干净 workflow；
历史 forced-stage 行为只作为 `legacy-workflow` setting 保留，不再作为普通 workflow 的实现。

- **原子 Profile**：一个角色的 Prompt 与显式能力，不决定全局步骤或子 Agent 拓扑。
- **setting**：组织策略，包含 executor、decoder_count、decoder_execution、aggregate。
- **bindings**：角色到 Profile 名称的映射，使同一 setting 可以调用不同实现。
- **评估运行时**：把 issue 交给所选角色，处理 Harbor task environment、模型调用、日志、Git 与结果。
- **Host Adapter**：将 Chrys 引擎和工具接入评估运行时；不包含知识算法。

## 责任与接口

四个原子角色保留归档中的完整 instructions、tools、compaction 与 approval，仅安装名称改为 `SWEPro*`。
Chrys 0.28 loader 已废弃 `reserved_context_pct: 0.15`，实际压缩阈值由模型配置决定。保留历史字段不代表该旧阈值在新宿主生效；本轮不改写宿主压缩算法。
Decoder 保留 read/search 与 read_only Shell；Mapper 保留读写/search/Shell，以及创建、运行 `reproduction.py` 的要求；
Aggregator 保留证据核验及 `<reflection>` + `<issue_analysis>` 格式；Solver 保留完整实现与验证要求。
阶段输入来自历史 harness 的关闭知识分支，保留 XML、措辞、防泄漏提醒和全文传递。Solver 接收完整 Mapper 计划。

### 干净 workflow 与 legacy setting

`single-decoder`、`three-decoder`、`three-decoder-serial` 都选择 `executor: workflow`，
由独立的 `core/workflow.py` 执行。它没有导入历史调度器，不包含知识准备、XML 驱动的自动降级或旧版 forced-stage 开关。
用户仍须显式选择 setting；这里的“默认”指普通 workflow 预设对应的实现。

干净 workflow 根据 setting 执行完整的 Decoder 阶段，串行则按序等待，并行则同时启动。
所有样本成功后按 `aggregate` 决定是否调用 Aggregator，然后运行 Mapper 与 Solver。
`aggregate: true` 时即使配置只有一个 Decoder 也会汇总；不会根据样本内容擅自省略该阶段。
宿主报告失败、执行抛出异常或返回空文本，都停止后续阶段。并行失败时先取消并等待其余 Decoder 退出，再清理工作区。
这里检查执行状态和非空输出，不新增 XML 格式或分析质量判分；完整文本仍原样传给下游。
运行记录包含失败角色和已消耗用量，模型错误不会被包装成一次正常完成。

`legacy-workflow` 预设保留三 Decoder 并行的历史 forced-stage 调度，维护在独立 `core/legacy_workflow.py`。
它等待全部样本，只有含 `<issue_analysis>` 的返回参与汇总：零个有效分析时拼接已返回文本交给 Mapper，
一个时直接传递，两个及以上才汇总。样本异常不取消其他 Decoder，空文本和宿主错误标记也不引入新判断。
需要其他历史数量/串行组合时，自定义 setting 的 `executor` 选 `legacy-workflow`，其余字段不变。

| 边界 | `workflow` | `legacy-workflow` | `sub-agent` |
|---|---|---|---|
| 调度者 | 独立 Python 执行器 | 历史 forced-stage 调度 | 原有根/ensemble Prompt 驱动模型 |
| Decoder 失败 | 停止并取消尚未结束的样本 | 等待其他样本并按历史结果选择继续 | 原有 Prompt 决定处理 |
| 是否汇总 | 由 setting.aggregate 决定 | 由有效样本数量决定 | 原有 ensemble Prompt 决定 |
| 角色与阶段 Prompt | 保留 | 与 workflow 共用 | 保留原有组织与角色模板 |
| Decoder 文件系统 | 独立 worktree | 同一工作区基础设施 | 沿用历史共享工作目录 |

两个 Python 执行器复用 worktree/Git 备份恢复基础设施及阶段 Prompt，不复制另一套文件系统实现。
每个 Decoder 使用私有目录，汇总使用 canonical repository；清理后 Mapper 与 Solver 在 canonical repository 中执行。
clean workflow 的 Git 隔离始终启用，不受历史调试变量 `CHRYS_SCRUB_GIT=0` 影响；legacy/sub-agent 保留旧开关。

### iCode 原生 workflow

`executor: icode-workflow` 使用 Chrys 0.28 自带的图、调度器和 Agent 节点，入口预设是
`three-decoder-icode-workflow`。Harbor Adapter 获取任务输入后，直接分派给 `adapters/chrys/native_workflow.py`；
宿主无关的 `core/execution.py` 对此 executor 明确拒绝执行，避免静默落回旧调度器。
`native_graph.py` 通过公开 `WorkflowBuilder` 定义图：输入 → 独立 Decoder → 显式 Aggregator → Mapper → Solver。
所有 Agent 后接非空检查；原始 issue 通过旁路输入参与后续 join，阶段 Prompt 与全文传递保持一致。
串行 Decoder 的前驱只形成执行依赖，不把前一个样本分析放进后一个样本 Prompt。

评测入口的 input handler 职责分为两部分：Harbor 提供正式任务描述与容器，插件准备 Git 隔离和
Decoder 工作区；图中的 Python `input` 节点解析 `{instruction, workdir, decoder_workspaces}`，
后续 join 节点按既有函数组装每个角色的输入。不额外调用一个模型来解释或重写题目。

环境对象不经过 workflow worker 的 JSON 协议。Chrys Adapter 将任务 runner 和按节点名称指定的
Workspace 传给 SessionHost、Coordinator、AgentNodeResources；原生节点构建工具时绑定该任务 runner。
未提供这些参数的普通 Chrys 运行保持原来的 workspace 和本地工具行为。评测模式关闭 ambient hooks/skills，
MCP 的宿主工作目录与容器内工具工作目录分开传递。

原生运行持有私有 Decoder worktree 到所有节点退出，再由外层恢复 Git、导出 patch。
这比 Python executor 在 Aggregator 结束后立即清理的时点晚，但后续两个角色仍只操作 canonical repository。
取消和失败都先等待原生 Host 完成清理，才释放工作区。用量从同一 workflow 会话的有序累计事件计算增量，
按 invocation 归属角色；不把各节点收到的会话总量再次相加。

setting 和 bindings 分开。例如固定 `three-decoder`，将 bindings.decoder 从 `SWEProDecoder`
改为扩展插件提供的 `CompassDecoder`，其他阶段与拓扑保持不变。这里只规定替换接口，并不声称 Compass
已完成这样的 Profile。只修改 Prompt 则保持 Profile 名称及 bindings 不变。

sub-agent 保留原有层级：根调用 `problem_decoder`、`solution_mapper`、`problem_solver`；
多 Decoder 时 `problem_decoder` 对应 ensemble，由它再调用 `decoder_0..N` 与 `aggregator`。
根模板仅移除知识指令/Skill，以及 Harbor 已完成而明确跳过的 input_handler 注册；三样本并行 ensemble Prompt 原文保留。
串行与自定义数量只替换组织模板中的数量、样本块、调度指令，不修改原子角色。
根与 ensemble 位于 `assets/compositions/`，属于组织层；setting 决定选择，bindings 决定角色。
Chrys 0.28 原生子 Agent 注册不递归加载子孙；薄 Adapter 使用同一 SubAgentTools API 递归接线既有层级、传递 runner 并清理，
不另写模型调度算法。保留工具轨迹用于观测，移除按轨迹强制判失败的新增规则。

两条路径不能宣称完全等价：ensemble Prompt 的零成功报错、单成功直返及 Aggregator 失败回退仍由模型执行；
sub-agent 路径没有 Python 创建的私有 Decoder worktree，历史模板中的“isolated”措辞不等于已落实文件系统隔离。
workflow 才由代码提供这一隔离与阶段调度保证。这项历史差异不在本轮改写。

默认 Profile 只使用任务环境内的基础读写、搜索和 Shell 工具。显式绑定扩展 Profile 时可以使用其能力；
扩展提供方负责相应运行依赖、工具的任务路径语义和公平比较。原子 Profile 内嵌 sub-agent 拓扑会被拒绝，
避免同时由 Profile 与 setting 控制组织方式。

## 目录与宿主边界

| 维护位置 | 内容与责任 |
|---|---|
| `source/package/src/swe_pro_kit/core/configuration.py` | 校验 setting/bindings，定义必需阶段；只使用标准库 |
| `core/contracts.py` | StageRunner、Orchestration、阶段结果的宿主无关契约 |
| `core/execution.py` | 根据 setting 分派独立执行器；sub-agent 提交 Orchestration |
| `core/workflow.py` | 干净 workflow：完整采样、显式汇总、失败停止与取消 |
| `core/legacy_workflow.py` | 仅 legacy setting 使用的历史样本选择和回退规则 |
| `core/stages.py` | 归一化宿主响应；不决定失败策略或更改 Prompt |
| `core/prompts.py` | 历史阶段输入的关闭知识分支 |
| `adapters/chrys/` | 原子 Profile/模型加载、把 Orchestration 渲染成 Chrys Profile、Engine 事件和任务工具 |
| `adapters/harbor/` | Harbor BaseAgent 接口、provider 的 exec/upload/download，向核心传入执行器 |
| `runtime/workspace.py`、`runtime/decoder_workspaces.py` | 备份/恢复 Git、抽取历史 worktree 算法、导出 patch |
| `runtime/distribution.py` | 固定包资源位置；不读取开发 checkout |
| `source/assets/` | 维护者提供默认四 Profile、七个显式 setting、baseline/TaskPattern bindings 与固定 evaluation 描述；实验可显式替换 |
| `source/adapters/chrys/icode-chrys-0.28/` | Adapter 维护者按宿主接入点提供最小 diff、精确 upstream/post-state 摘要 |
| `source/installer/` | 插件探测宿主、验证绑定、生成薄 activation；事务由共享 Kit 处理 |
| `source/scripts/` | 批量运行及续跑；不负责知识准备或修改宿主依赖 |
| `delivery/` | 从 Source 构建，固定 Package 的安装来源 |

宿主接线保留在十一个已有文件中：0.28 的 assembly/builder/loader 传 runner 并隔离环境能力；sub-agent 传 runner、注册既有嵌套层级和控制能力加载策略，
tool registry 接入任务工具，skills adapter 控制 ambient skills。业务实现留在固定包，不再交付十二个宿主整文件副本。
精确哈希保护的是已知接线能力；未测试的新版本不能仅因版本号较新就视为兼容。

依赖方向是 Adapter 调用 Core，Core 不导入 Chrys、Harbor、runtime 或任何 Adapter。
Core 的 sub-agent 请求是 `Orchestration(setting, bindings)`，而不是某个宿主的 YAML/dict；
只有 Chrys Adapter 了解 `sub_agents.agents` 等原生字段。替换执行宿主时实现 StageRunner 即可，
不用修改分析、汇总、规划、实现的调度规则。这个方向由隔离解释器测试验证：禁止加载全部宿主/Adapter 后，
替代执行器仍能消费核心请求并产出结果。

安装共享 core 与此评估 core 分工独立：前者管理 PackageStore/事务/所有权；后者只管理一次评估的领域规则。
没有在插件中复制第二套存储、依赖安装或生命周期框架。

## 纯基线与历史保存

`swe-pro-kit` 中不保留历史 knowledge module、两个检索/计划 Skill、Knowledge Agent 或 TaskPattern Runtime。
这些旧文件包含在 `archives/swe-pro-kit-202608`，目录不注册为可安装插件；独立组合插件继续保留。
显式 `taskpattern-evaluation` 只从独立 Task Pattern Advisor 安装出的 Chrys profile 复用 Skill/MCP
binding，并在内存中复制 baseline 原子 Profile；默认 profiles/settings 的行为不变。

基线禁用隐式用户/项目 Skills、hooks 和 dotenv 读取；使用显式模型、四角色 bindings 与 setting。
Agent 会看到任务 issue 和任务仓库；workflow 仅暴露 HEAD 及祖先（含初始未提交变更的快照），sub-agent 求解期间隐藏 `.git`；完整 Git 在验证前恢复。
这些约束用于形成可说明、可重复的评估条件，不代表已经取得 benchmark 性能证据。

## 安装与验收责任

安装遵循[共享设计](../../../docs/specifications/plugin-installation-unification-overview.md)、
[生命周期规范](../../../docs/specifications/installed-package-lifecycle.md)及
[custom installer 协议](../../../docs/specifications/custom-installer-protocol.md)。
CodeHelix 负责固定包、计划/提交事务、所有权、回滚、inspect/remove；Chrys 负责实际加载与模型执行；
Harbor 负责任务环境和评分；插件负责它们之间的适配及探针。

安装使用已有 Chrys/Harbor Python，不创建额外 venv。任务缓存、provider、模型凭据和运行结果不归安装器所有。
独立 Delivery、完整仓库和 Plugin Management 使用同一事务合同，实际产品 UI 与真实 provider 任务需各自留证。
可观察验收及尚未完成的实机项见 [acceptance.md](acceptance.md)。
