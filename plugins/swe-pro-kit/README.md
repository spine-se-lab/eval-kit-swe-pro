# SWE-Pro Kit

`swe-pro-kit 0.3.3` 提供不含历史知识增强的 SWE-bench Pro 评估基线，以及一个显式选择的
TaskPattern evaluation setting。Decoder、Aggregator、Mapper、Solver 是四个原子 Agent Profile；
运行时 setting 决定组织方式，bindings 决定每个角色采用哪个 Profile。默认不加载 Task Pattern、
Compass 或知识检索；只有 `taskpattern-evaluation` 会复用独立安装的 Lingxi Advisor Skill/MCP。

历史版本已保存在 [swe-pro-kit-202608](../../archives/swe-pro-kit-202608/ARCHIVE.md)；
`swe-pro-kit-with-taskpattern` 继续作为历史独立插件保留，新 setting 不依赖它。

## 组成与运行方式

| 部分 | 职责 | 更改时机 |
|---|---|---|
| `assets/profiles/` | 四个原子角色的 Prompt、工具和显式能力 | 调整 Prompt 或实现新技术 |
| `assets/compositions/` | 原有根 Agent 与 Decoder ensemble 组织模板 | setting 选择编排，原子 Prompt 保持不变 |
| `assets/settings/` | 执行器、Decoder 数量、串行/并行、是否汇总 | 改变编排方式 |
| `assets/bindings.json` | decoder/aggregator/mapper/solver 到 Profile 名称的映射 | 替换某个原子角色 |
| `package/src/swe_pro_kit/core/` | 配置、阶段输入、独立 workflow 与可选 legacy 调度；不依赖 Chrys/Harbor | 调整评估规则 |
| `package/src/swe_pro_kit/adapters/` | Chrys Engine/Profile/工具与 Harbor Agent/environment 接入 | 适配执行框架 |
| `package/src/swe_pro_kit/runtime/` | 工作区 Git 生命周期、补丁与固定资源定位 | 维护运行基础设施 |
| `adapters/chrys/` | 向 Chrys 传递任务 runner，控制隐式宿主能力加载 | 适配宿主版本 |
| 共享 Plugin Kit | PackageStore、安装事务、所有权、检查和卸载 | 维护安装框架 |

| setting | 组织方式 | Decoder | Aggregator |
|---|---|---|---|
| `single-decoder` | workflow | 1 个 | 无 |
| `three-decoder` | workflow | 3 个并行 | 有 |
| `three-decoder-serial` | workflow | 3 个串行 | 有 |
| `three-decoder-icode-workflow` | iCode 原生 workflow，六个 Agent 节点 | 3 个并行 | 有 |
| `sub-agent` | Agent 调用原子 sub-agent | 3 个并行 | 有 |
| `sub-agent-serial` | Agent 调用原子 sub-agent | 3 个串行 | 有 |
| `legacy-workflow` | 历史 forced-stage 行为 | 3 个并行 | 按有效样本数决定 |
| `taskpattern-evaluation` | 固定宿主 workflow 串行执行 Decoder → Mapper → Solver | 1 个 | 无 |

普通 workflow 预设使用独立实现的干净执行器：所有 Decoder 成功后按 setting 汇总，再运行 Mapper、Solver。
阶段执行失败或返回空文本会停止后续阶段；并行失败先取消并等待其他样本退出，再清理私有 worktree。
仅显式选择 `legacy-workflow` 才启用历史样本选择：单成功跳过汇总，零成功沿用旧文本回退。
角色 Profile、工具能力和阶段输入未改写。sub-agent 继续使用原有根 → ensemble → Decoder/Aggregator 的嵌套组织，
不新增轨迹判失败规则。各执行器的精确定义见[基线设计](docs/baseline-design.md)。
安装不选 setting，每次运行都必须显式传入。Lingxi Advisor 评估绑定的固定模型、Skill/MCP、输入安全边界、
日志和后续 LingxiV2 复用边界见 [TaskPattern evaluation setting](docs/taskpattern-evaluation.md)。

### 使用 iCode 原生 workflow 评测

选择 `--setting three-decoder-icode-workflow` 后，Harbor 提供 issue 和已准备的任务仓库，
插件将它们交给 iCode 原生 `ChrysSessionHost`。三个 Decoder、Aggregator、Mapper、Solver
都是原生 Agent 节点；Python 节点只组装既有 Prompt 和检查非空输出。四个 Profile 与 bindings 不变。
这条路径不需要另一个 InputHandler Agent，也不需要安装 iCode Workflow 插件。

```bash
export SWE_PRO_MODEL_PROFILE=my-evaluation-model
# SWE_PRO_API_KEY 或 OPENAI_API_KEY 由启动环境提供。
python3 /absolute/chrys-config/swe-pro-kit/run.py \
  --setting three-decoder-icode-workflow \
  -p /absolute/harbor-task --n-concurrent 1 --yes
```

自定义 setting 可使用 `executor: "icode-workflow"`，调整 `decoder_count`、
`decoder_execution: "parallel" | "serial"` 与 `aggregate`。多个 Decoder 必须启用 Aggregator。
节点显式采用一次 attempt，保留 iCode 的底层请求重试；失败停止后续阶段，不自动降级。
各 Decoder 的私有工作区保留到整次原生运行退出后清理，Aggregator、Mapper、Solver 始终使用 canonical repository。

每个 trial 的 `agent/native-workflow/` 保存实际流程定义、原生会话/节点归档和 `run.json`；
原有 `baseline-run.json`、各角色 `trace.json`、`solution.patch` 与 Harbor verifier 结果仍保留。
CLI 会输出节点状态。实现及本轮真实测试范围见[原生 workflow 验收](../../docs/acceptance/swe-pro-native-workflow/README.md)。

## 安装

需要 Node.js 18+、Git、Chrys **0.28.0** 和已有的 Python 3.14+ / Harbor **0.7.0** 环境。
默认使用目标 checkout 的 `.venv`；也可用 `--set python=` 指定已有解释器的绝对路径。
若尚无 Harbor 环境，先执行：

```bash
uv venv --python 3.14 /absolute/swe-pro-harbor
uv pip install --python /absolute/swe-pro-harbor/bin/python 'harbor==0.7.0'
```

随后在安装命令中追加 `--set python=/absolute/swe-pro-harbor/bin/python`。安装预检发现缺少 Harbor 时也会输出同一准备命令；插件不会擅自修改或删除该外部环境。
Adapter 基线为 `5344293d0dc95a42d2883c9470b901ae0d48c553`，安装时检查实际接入文件摘要、
Chrys/Harbor 版本、Profile loader 和 Harbor CLI。当前只交付 0.28 Adapter，不提供旧版 Runtime 或版本元数据桥。
隔离安装及受控运行结果见[当前验收记录](../../docs/acceptance/taskpattern-swe-pro/2026-10-04/issues/README.md)。

### 为什么固定 Harbor 0.7.0

**Harbor 固定为 `0.7.0`，用于保留已验证的 macOS Docker Desktop 断网评测能力。**
以下依据为项目维护者在 2026-10-04 补充的历史实测结论，描述 2026-07-03 的环境与结果；本轮没有重新执行该断网实验。

此前 SWE-Pro 运行轨迹中发现，agent 会通过 GitHub API、原始文件下载或 `git clone`
获取外部源码、修复提交和隐藏测试。仅清理本地 `.git` 或通过提示词禁止联网不足以保证评测有效，
因此必须在容器层强制限制网络访问。

Harbor `0.7.0` 将任务配置 `allow_internet=false` 转为 Docker 原生的 `network_mode: none`。
2026-07-03 的实际运行验证确认：4 个任务容器均使用该网络模式，访问 GitHub 域名及直接访问外部 IP
均失败；宿主机上的模型 API 调用仍正常。

对比之下，Harbor `0.16.1` 的网络隔离依赖 nftables 能力，当时 macOS Docker Desktop 的 LinuxKit
内核缺少所需支持，导致断网任务被拒绝执行。因此，SWE-Pro Kit 固定使用历史实测通过的 `0.7.0`，
避免依赖升级使断网评测不可用。

该约束是已验证环境的兼容性基线，不代表更新版本永久不可用。解除版本固定前，SWE-Pro 维护者必须
重新验证容器无法访问外网、宿主机模型调用正常，以及完整评测流程可运行，并记录准确的 Harbor、
Docker Desktop 和系统版本及运行证据；不能通过关闭网络限制来绕过兼容问题。

### 安装命令

在 CodeHelix Plugin 仓库使用统一入口：

```bash
npx . swe-pro-kit install --agent icode \
  --target /absolute/chrys --config-root /absolute/chrys-config
```

独立 Delivery 使用同一入口作为来源。下面命令仍在 CodeHelix Plugin 仓库执行，而不是在 Delivery 目录执行：

```bash
npx . add /absolute/delivery/icode-chrys-0.28 --agent icode \
  --target /absolute/chrys --config-root /absolute/chrys-config
```

省略 `python` 时使用目标现有 `.venv`。若需要复用其他已有的精确版本环境，可追加
`--set python=/absolute/existing-env/bin/python`。CLI 和 Plugin Management 复用共享安装事务。
固定实现进入 PackageStore，受管激活共 19 项：四个 Profile、十一个宿主补丁文件、三个薄接线文件和运行启动器；
安装完成后不依赖原始分发目录。现有 legacy overlay 或用户修改发生冲突时阻止覆盖，迁移步骤见
[安装说明](docs/install-v2-migration.md)。

在同一 CodeHelix Home 中检查或移除该部署，使用相同的目标和配置目录：

```bash
npx . swe-pro-kit inspect --agent icode \
  --target /absolute/chrys --config-root /absolute/chrys-config
npx . swe-pro-kit remove --agent icode \
  --target /absolute/chrys --config-root /absolute/chrys-config
```

若安装时指定了 `--home`，管理时也传入相同值。`inspect` 检查固定包、安装状态和文件漂移，
不运行模型或重新执行评测；移除会保留已有 Python 环境、任务数据和运行结果。

## 运行一次评估

在配置目录的 `models/` 准备 Chrys 模型模板，设置 provider、model_id、base_url 等非敏感字段。
用 `SWE_PRO_MODEL_PROFILE` 显式选择其 ID 或名称；API key 从启动进程的 `SWE_PRO_API_KEY`
或 `OPENAI_API_KEY` 注入。插件不加载 `.env`，不把密钥写入模型配置，也不使用模板中的历史 key。
Harbor 的数据集、容器或远程 provider 由运行环境准备。
任务环境需提供 Git、tar、base64、chmod 和兼容 GNU 的 timeout；限时命令在任务内终止进程组，避免编译进程在超时后继续堆积。搜索使用 ripgrep，缺失时回退到任务内
Python 3（Python 正则语义、仅匹配行）。

```bash
# 凭据通过当前进程环境注入；这里仅设置非敏感模型选择。
export SWE_PRO_MODEL_PROFILE=my-evaluation-model
python3 /absolute/chrys-config/swe-pro-kit/run.py \
  --setting single-decoder \
  -d scale-ai/swe-bench-pro -i '<task-name>' \
  -o /absolute/runs/baseline --n-concurrent 1
```

`run.py` 使用安装时绑定的解释器启动 Harbor。它也接受 `--bindings /absolute/bindings.json`，
其余参数交给 Harbor。setting 可传预设名或自定义 JSON 路径。

`taskpattern-evaluation` 必须显式传入完整 `--instance-id` 和 40 位 `--base-commit`，并可用
`--repository owner/repo` 和 `--issue-number N` 补充公开事实。SWE-Pro 不接受 `existing/new` 或
`leakage_check` 开关：TaskPattern 根据 target identity 自行判定，existing target 必做 target-specific
leakage check，new issue 自动跳过。若 repository 无法从完整 instance ID 或当前 GitHub origin 推断，
非交互评估会在模型调用前报错并要求补充 `--repository`。

该 setting 会先在 Harbor/计时任务之外准备完整 closed-issue catalog，并持续输出准备状态；完成后把独立准备记录绑定到三个角色共享的 TaskPattern MCP。记录缺失、过期或快照变化时会在任务开始前失败，不会让首个 Search 静默构建完整 catalog。普通 setting 仍使用 `bounded` 检索，只有此显式入口会通过受校验的启动参数选择 `evaluation`。

结果中保留 Harbor 原始 trial、各阶段 session/工具轨迹、`baseline-run.json` 与 `solution.patch`。
运行记录包含实际模型、预算、Profile SHA、版本和 token 用量；失败阶段已消耗的 token 也保留。
评估期间隔离任务原始 Git 历史，求解结束后恢复，补丁包含新文件。工具通过 Harbor task environment
执行。默认关闭用户/项目自动 Skills 与 hooks，避免无意混入其他技术。

比较基线时须固定任务集、模型、setting、Profile/bindings 和预算。不同 setting 各自构成一个基线配置；
不存在与模型和运行设置无关的单一“基线分数”。`0.3.0` 的实机记录属于本次撤回的行为改写版本，
不能作为保留原子 Prompt 的 `0.3.1` 或新 workflow `0.3.2` 的性能证据。当前回归范围见[验收记录](docs/acceptance.md)，
新方案保留在[后续优化候选](docs/future-optimization.md)。

## 扩展与批量运行

未来仅做 Prompt 实验时，编辑独立原子 Profile，再通过 bindings 选择；本次 workflow 调整未修改它们。
替换角色：将新 Profile 放入指定 config-root 的 `agents/`，在独立 bindings JSON 中更换名称，setting 保持不变。
显式扩展 Profile 可以声明新能力，其外部依赖和任务环境适配由扩展插件负责；原子 Profile 不包含 sub-agent 编排。

批量脚本在固定包的 `scripts/run-batch.sh`，也可使用本仓维护源：

```bash
CHRYS_DIR=/absolute/chrys CONFIG_ROOT=/absolute/chrys-config \
HARBOR_BIN=/absolute/existing-env/bin/harbor \
SOURCE=/absolute/tasks.txt RUN_DIR=/absolute/runs/baseline \
SETTING=three-decoder \
bash plugins/swe-pro-kit/source/scripts/run-batch.sh
```

任务清单每行一个任务名，也接受历史 PASS/FAIL TSV。批次按结果续跑，保留失败/未评分记录；
Harbor 返回后没有新增结果会停止。使用新目录保存不同配置的运行，避免续跑混合结果。

## 维护与证据

```bash
npx . build swe-pro-kit
npx . validate swe-pro-kit
uv run pytest -q tests/test_swe_pro_*.py
```

[架构与边界](docs/baseline-design.md) · [验收记录](docs/acceptance.md) ·
[TaskPattern evaluation](docs/taskpattern-evaluation.md) ·
[实机安装与模型验证](docs/live-validation.md) · [历史来源](docs/source-migration.md) · [主 Issue #4](https://github.com/yiikou/CodeHelix-Plugin/issues/4)
