# TaskPattern evaluation setting

`taskpattern-evaluation` 是 `swe-pro-kit 0.3.3` 的显式、固定评估 setting。默认/baseline
profiles 和其他 settings 不变；此 setting 仅在运行时复制 `SWEProDecoder`、`SWEProMapper`
和 `SWEProSolver`，并从已安装的 `CodeTaskPatternAdvisor` Chrys profile 复用
`taskpattern` Skill 路径与同名 MCP server。它不读取 capability export，不复制
TaskPattern source、Runtime、venv、模型配置或数据目录，也不依赖旧组合插件。

## 固定内容与运行

唯一入口为：

```bash
SWE_PRO_API_KEY='<通过安全环境注入>' \
python3 /absolute/chrys-config/swe-pro-kit/run.py \
  --setting taskpattern-evaluation \
  --instance-id 'instance_owner__repo-<40-character-base-sha>-v1' \
  --base-commit '<40-character-base-sha>' \
  --repository owner/repo \
  -d scale-ai/swe-bench-pro -i '<task-name>' \
  -o /absolute/runs/taskpattern-evaluation --n-concurrent 1
```

不要传 `--bindings`；setting 由宿主的确定性 workflow 直接依次运行
`SWEProTaskPatternDecoder`、`SWEProTaskPatternMapper`、`SWEProTaskPatternSolver`，总并发为 1，
不启用 Aggregator。模型固定为随包交付的 `swe-openrouter-flash` 非敏感模板：
`deepseek/deepseek-v4-flash`、OpenRouter chat-completions、100000 context、8192 output、
10 秒 connect、180 秒 read、1 次 HTTP retry；TaskPattern 请求 timeout 为 1000 秒，以覆盖一次
Search 中可能发生的多个 Artifact 生成；后续相同 Search 仍复用持久缓存，且超时后仍按强约束失败，不降级调用判据。
Chrys transient/stage retry 为 0，启动器固定 Harbor agent timeout multiplier 为 4。API key 只从 `SWE_PRO_API_KEY` 或
`OPENAI_API_KEY` 注入，不写入 profile 或日志。固定评估入口将同一个 key 仅在当前进程中映射给 TaskPattern 的 Judge/Generator，并复用同一模型与 endpoint；这避免把 Chrys 0.28 尚未预检的 MCP host sampling 当成已就绪能力。

启动器会明确打印 evaluation mode，并在 Harbor/计时任务启动前单独准备仓库级完整 closed-issue catalog。首次未缓存的仓库可能需要数分钟；CLI 会显示准备开始、TaskPattern 拉取进度、请求数/耗时和准备记录路径，评估人无需在首个 Search 中盲等。准备结果写入 TaskPattern 数据目录的 `outputs/evaluation_preparations/`，独立记录仓库、快照、缓存命中/刷新、GitHub 请求数和耗时；三个角色共享同一快照。准备记录缺失、过期或快照被改动时，评估在任务启动前停止，不在 Search 内静默重建完整 catalog。

每个角色在模型执行前完成 MCP 连接预检，stdio MCP 使用宿主可访问的 trial 日志目录，而不是容器内 `/app`。SWE-Pro 在复制已安装的 MCP 声明时追加受信任的 `--retrieval-strategy evaluation`、仓库和准备记录参数；TaskPattern managed launcher 校验这些参数后，核心最终接收 `evaluation`。普通启动不传这些参数，仍固定为 `bounded`，环境中的同名变量不能改变模式。Search 没有历史匹配是正常结果：该角色不调用 Apply，直接继续仓库分析；只有 MCP/检索错误才停止。

`assets/evaluations/taskpattern-evaluation.json` 固定 Chrys/iCode 版本、主 Profile、拓扑、
模型、预任务准备、timeout/retry/failure、输入 allowlist 与产物位置；`assets/taskpattern-bindings.json`
固定三个角色；`assets/settings/taskpattern-evaluation.json` 固定编排。

运行前必须先用独立 `task-pattern-advisor` 插件在同一 Chrys config-root 安装
`CodeTaskPatternAdvisor.yaml`。SWE-Pro Kit 只复制其中 basename 为 `taskpattern` 的 Skill
路径和 `taskpattern` MCP server，并严格限定 `taskpattern.search`、`taskpattern.apply`；
operator Skill/MCP 不进入评估 profile。若安装 profile 缺失或绑定漂移，运行在模型调用前失败。

公开 task context 只允许 `repo`、完整 `issue_description`、`instance_id`、`base_commit` 和
显式提供的正整数 `issue_number`。CLI 要求完整 `--instance-id` 与 `--base-commit`；两者缺失、截短或冲突时，非交互评估
在模型调用前停止。若 repo 不能由 instance identity 得到，则尝试从任务工作区的 GitHub origin 推断；仍无法确定时提示用 `--repository owner/repo` 补充。日常交互式 TaskPattern 使用应先询问
用户，而不是猜测非 GitHub 路径。
禁止 gold/target patch、hidden tests、verifier data、reference solution、凭据、本地路径和无关
Harbor 配置。三个 fragments 均要求以当前 repository/worktree 验证历史知识。

`existing_target/new_issue` 和 target-specific leakage check 均由 TaskPattern Runtime 从公开 identity
自动推导，不是 SWE-Pro 配置项。SWE-Pro 不向 Search 传 `issue_mode` 或 `leakage_check`：已有 target
自动执行 leakage check，全新 issue 自动跳过；其他同仓库、时间、patch 和通用安全校验始终保留。

准备记录独立位于 TaskPattern 数据目录的 `outputs/evaluation_preparations/`；其摘要和路径也会写入
Harbor trial 的 `agent/baseline-run.json`。其余日志仍位于 Harbor trial 的 `agent/`：补丁为 `solution.patch`，总记录为
`baseline-run.json`，各阶段完整工具轨迹为 `stages/<role>/trace.json`，过滤后的跨角色
TaskPattern 调用与结果为 `stages/orchestrator/taskpattern-invocations.json`。

## 后续 LingxiV2 交接边界

Skill/MCP binding 的唯一实现 `bind_taskpattern()` 位于
`package/src/swe_pro_kit/adapters/chrys/taskpattern.py`；三个可复用 prompt fragments、公开
task context 映射和幂等注入位于 `package/src/swe_pro_kit/core/taskpattern.py`。当前三个串行角色阶段
通过 `compose_atomic_profile()` 分别选择 decoder/mapper/solver fragment；重复组合不会重复注入。

后续第二种方案应复制而非修改 Chrys 的默认 `LingxiV2` profile，在其分析、规划、实现段落分别
调用 `inject_prompt_fragment(..., "decoder"|"mapper"|"solver")`，并调用同一
`bind_taskpattern()`。预计只需新增该复制 profile 的 composition/activation，
让同一个 Agent 在三个阶段看到相应 fragment；不应改默认 `LingxiV2.yaml`，也不应引入
Decoder/Mapper/Solver 子 Agent。

可直接复用 `tests/test_swe_pro_taskpattern_evaluation.py` 中的 binding、allowlist、幂等和无内嵌
Runtime 断言，再增加复制后的 LingxiV2 三段注入检查。当前未实现或验收 LingxiV2 方案。
固定 `taskpattern-evaluation` 已使用真实 provider、Chrys、Harbor 0.7.0 和空 TaskPattern 缓存
完成一次 Decoder → Mapper → Solver 评估，三阶段均完成 Search/Apply，产出 patch 并通过 verifier；
可复核结果见[2026-10-02 实机证据](evidence/2026-10-02-taskpattern-live/README.md)。该单任务冒烟
验收证明链路可用，不构成 TaskPattern 对完整 benchmark 的性能收益结论。
