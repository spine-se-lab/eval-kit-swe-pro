# SWE-Pro Kit：OpenRouter 真实安装与运行验证

> 历史证据：本页所有实机运行对应 `0.3.0`（行为改写版本）。用户明确要求保留历史流程后，
> `0.3.1` 已撤回角色 Prompt、执行语义及扁平编排改写。本页制品保持原样，不能用于声明 `0.3.1`
> 的基线性能或嵌套运行已通过真实模型验证；当前状态见 [acceptance.md](acceptance.md)。

2026-09-17。验证目标是：按功能拆分的评估核心可以通过受管安装加载，在真实 Harbor Docker 任务环境中调用真实模型，
并能在安装来源删除后继续运行、检查和卸载。小型验证任务不计作 SWE-bench Pro 性能样本。

## 模块设计与本轮产物

核心分为 configuration、contracts、execution、trace；它们不导入 Chrys、Harbor、runtime 或 Adapter。
`Orchestration(setting, bindings)` 是核心交给宿主的编排请求，Chrys 原生 Profile 只在 Chrys Adapter 内生成。
Harbor Adapter 提供 BaseAgent 和 task environment 接入，workspace runtime 负责 Git 与补丁生命周期。
架构理由及各模块职责见 [baseline-design.md](baseline-design.md)。

最初两次受控任务使用的 Delivery 摘要为
`2f1168fd0ac3d2bb98f5557308a63db16291bc874f634b848390420f189c4476`。
[Delivery lock](evidence/2026-09-17-openrouter/delivery-lock.json) 与
[Source lock](evidence/2026-09-17-openrouter/source-lock.json) 固定这份产物。最终修复版摘要为
`faae5f6ad287f60d9459644028f258f72664d46b704e47e7c4f07a348b32f438`，
见 [最终 Delivery lock](evidence/2026-09-17-openrouter/final-delivery-lock.json) 与
[最终 Source lock](evidence/2026-09-17-openrouter/final-source-lock.json)。下文分别记录，避免把旧包结果当作最终包验收。

## 环境与模型

- Chrys：0.20.1，基准 commit `0dd38d8d42ad65480f19279ea71383ede89f6a83`，导出到隔离目录后安装六处接线。
- Harbor：0.7.0，真实 CLI、BaseAgent、Docker environment 和 verifier。
- Docker Engine：29.6.1；任务容器由 Harbor 创建和清理。
- Python：独立的 3.14.3 环境；用户原有 checkout 和 venv 未修改。
- 模型：OpenRouter 的 [`deepseek/deepseek-v4-flash`](https://openrouter.ai/deepseek/deepseek-v4-flash)，
  endpoint 为 `https://openrouter.ai/api/v1`；Chrys provider 的 `openai` 表示兼容协议。
- 模型配置：context budget 100000，单响应 output budget 8192；没有改动四个基线 Profile 或混入知识能力。
- 密钥仅从当前进程环境传入，没有放在 argv、模型 YAML 或证据文件中。

[依赖版本](evidence/2026-09-17-openrouter/runtime-freeze.txt)记录隔离解释器实际安装的包；
[非敏感模型模板](evidence/2026-09-17-openrouter/model-template.yaml)固定 provider、endpoint、模型与请求预算。
这些运行未使用 MockChatClient；离线 mock 回归另见 [acceptance.md](acceptance.md)。

## 已完成的受控任务

维护用例位于 [pagination fixture](../../../tests/fixtures/swe-pro-pagination/instruction.md)。
它要求修复分页边界与非法参数处理；验证器在 Harbor 的 `/tests` 中独立执行。

| 安装来源与运行方式 | Harbor 结果 | 输入 tokens | 输出 tokens | 缓存命中 tokens |
|---|---:|---:|---:|---:|
| 完整仓库安装，`sub-agent`，3 Decoder 并行 | reward 1.0，异常 0 | 118060 | 18126 | 79104 |
| 独立 Delivery 安装后删除来源，`single-decoder` workflow | reward 1.0，异常 0 | 57290 | 6505 | 41728 |

缓存命中 tokens 是输入 tokens 的子集，不能再次相加；这些是整个 trial 各角色累计的用量。
它们用于检查成本记录，不用于从一个小样本推导模型或编排的效率排名。

sub-agent 轨迹记录了三个 Decoder 的实际重叠调用，全部结束后依次调用 Aggregator、Mapper、Solver。
workflow 轨迹记录 Decoder、Mapper、Solver 三个独立阶段。两次都导出补丁并由独立 verifier 检查功能。
证据：

- [sub-agent trial](evidence/2026-09-17-openrouter/sub-agent/result.json)、
  [运行配置与用量](evidence/2026-09-17-openrouter/sub-agent/agent/baseline-run.json)、
  [实际调用轨迹](evidence/2026-09-17-openrouter/sub-agent/agent/stages/orchestrator/trace.json)。
- [来源删除后的 workflow trial](evidence/2026-09-17-openrouter/source-removed-workflow/result.json)、
  [运行配置与用量](evidence/2026-09-17-openrouter/source-removed-workflow/agent/baseline-run.json)。

## 安装与卸载证据

第一次从完整仓库通过 `npx . swe-pro-kit install` 安装；第二次从复制出的独立 Delivery 通过 `npx . add` 安装。
两次绑定同一个隔离 Python，使用不同 Chrys checkout、config 和 CodeHelix Home。
第二次安装完成后删除该 Delivery，再由新进程启动真实模型和 Docker 任务；任务正常得到 reward 1.0。

任务结束后，从第二个 Home 保留的 Kit 调用 inspect/remove：12 项 activation 被正确撤回，
六个源码文件逐一恢复为原始 SHA-256；薄入口与四个 Profile 删除，模型模板、Python、任务结果保留。
第一个安装暂时保留用于检查复现。原始本地结果位置见 [local-runs.json](evidence/2026-09-17-openrouter/local-runs.json)。

- [完整仓库安装日志](evidence/2026-09-17-openrouter/install.log)
- [独立 Delivery 安装日志](evidence/2026-09-17-openrouter/detached-install.log)
- [固定包完整性检查](evidence/2026-09-17-openrouter/inspect.log)
- [来源移除与卸载恢复核对](evidence/2026-09-17-openrouter/detached-lifecycle.json)

## 正式任务暴露的问题与修复

首次正式任务选择本机已有的 Scale AI SWE-bench Pro Teleport task：
`instance_gravitational__teleport-6eaaf3a27e64f4ef4ef855bd35d7ec338cf17460-v626ec2a48416b10a88641359a169d99e935ff037`。
使用原任务 instruction、镜像、资源和 verifier，以及 `single-decoder` setting；没有为模型读取或提供隐藏测试答案。

运行中核实两个 Adapter 问题：Docker 将 stderr 合并进 stdout，缺失文件的错误被旧工具丢失；
Harbor 0.7 超时只中断 docker-exec 客户端，容器内编译子进程继续运行，后续重试导致堆积。
发现后保留现场，使用 Harbor 的 SIGTERM 处理器结束旧 trial（进程返回 130），不将这次中断解释为求解得分。
[中断记录](evidence/2026-09-17-openrouter/teleport-interruption.json)保留原因和信号，
[原 trial 结果](evidence/2026-09-17-openrouter/interrupted-teleport/result.json)记录 `CancelledError`、无 verifier 结果。
取消也中断了这次旧 trial 的 Git 恢复，恢复归档保留在原本地结果目录；不能把旧 trial 算作生命周期通过。

最终版将命令预算放在容器内部，通过 GNU-compatible timeout 终止进程组；Harbor 外层超时额外留出清理时间。
Adapter 归一化超时异常，工具返回包含时限的错误；缺失文件保留实际诊断。
[真实 Docker 工具回归](evidence/2026-09-17-openrouter/docker-tools.json)确认：
后台子进程在超时后没有写出文件、下一条命令可以执行、缺失文件能被正确报告。
该修复属于运行基础设施修复，未调整任务、模型、Prompt 或 setting 来追求更高评分。

修复后的包已重新安装：[完整仓库](evidence/2026-09-17-openrouter/final-install.log)、
[独立 Delivery](evidence/2026-09-17-openrouter/final-detached-install.log)。独立来源再次删除。
两套部署的固定包与 activation 检查均无漂移：
[完整仓库 inspect](evidence/2026-09-17-openrouter/final-retained-inspect.json)、
[独立来源 inspect](evidence/2026-09-17-openrouter/final-detached-retained-inspect.json)。

## 最终包的来源删除与运行验收

最终包从独立 Delivery 安装后删除该来源，新进程使用 `single-decoder` 完成分页任务：
**reward 1.0，异常 0，耗时 3m27s**。累计输入 76348、输出 7233、缓存命中 59648 tokens。
[trial 结果](evidence/2026-09-17-openrouter/final-source-removed-workflow/result.json)与
[阶段、模型和用量](evidence/2026-09-17-openrouter/final-source-removed-workflow/agent/baseline-run.json)可复核。

随后只使用 Home 保留的 Kit 完成卸载，六个宿主文件恢复原始摘要、四 Profile 与两个薄入口撤回，
外部 Python、模型模板和运行结果保留。
[最终卸载证据](evidence/2026-09-17-openrouter/final-detached-lifecycle.json)记录逐项核对结果。

## 最终包的 SWE-bench Pro 任务结果

相同 Teleport task、模型和 `single-decoder` setting 的最终运行已结束：
**reward 0.0，Harbor 异常 0，Agent 状态 completed**。求解阶段用时 13m50s，verifier 用时 16m10s；
Harbor CLI 显示总计 30m08s（包括 job 调度开销）。累计输入 814279、输出 22839、缓存命中 742144 tokens。

评分失败的直接证据是模型新建的实现缺少 `Config.Interactive` 与 `Linear.config` 字段，
导致原评测测试无法编译，三个 required tests 均未通过。模型自身的局部检查成功不能替代 verifier。
这是本次求解产物的失败，不是一次 Harbor 运行异常；未根据评测测试反向修改产物或重跑以更换得分。
原 verifier 在多个 Teleport 包中筛选目标测试，首次编译范围较大；其时间与 Agent 求解时间分别记录。

- [Harbor trial 结果](evidence/2026-09-17-openrouter/final-teleport/result.json)
- [模型、角色、阶段输出与用量](evidence/2026-09-17-openrouter/final-teleport/agent/baseline-run.json)
- [模型生成的原始补丁](evidence/2026-09-17-openrouter/final-teleport/agent/solution.patch)
- [verifier 汇总](evidence/2026-09-17-openrouter/final-teleport/verifier/test-stdout.txt)与
  [编译诊断](evidence/2026-09-17-openrouter/final-teleport/verifier/run-script-stderr.txt)

Git 恢复完成后才运行 verifier，恢复归档已正常删除；Harbor 已移除本次任务容器。
[运行后 inspect](evidence/2026-09-17-openrouter/post-run-inspect.json)确认固定包与 activation 无漂移。
本次留下一个有效的未解出样本，不能由此估计整个 SWE-bench Pro 的通过率。

## 范围

这些证据证明指定 Chrys/Harbor/模型组合的安装与调用链，不代表其他 Chrys 版本、实际 Plugin Management UI、
或整个 SWE-bench Pro 的性能。目标的通用验证标记仍保留 fixture，真实运行证据按本页的具体组合和产物摘要陈述。
没有迁移历史知识到 Task Pattern，也没有改动保留的历史插件能力。
