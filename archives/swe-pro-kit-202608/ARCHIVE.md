# SWE-Pro Kit 202608 历史快照

本目录按用户要求保留拆分前的 SWE-Pro Kit，供后续决定与
`swe-pro-kit-with-taskpattern` 的保留关系。它不是第二个活动插件。

- 来源：本工作区 `plugins/swe-pro-kit/`，Git 基点记录于 `snapshot.json`。
- 含此前未提交修复草稿；Source 与旧 Delivery 尚未同步构建，因此不作为已验收发行版。
- `snapshot.json` 记录备份时 119 个文件的 SHA-256 和权限，原文件未改写。
- `regression-tests/` 附存拆分前的测试草稿，活动测试以仓库 `tests/` 为准。
- 历史知识实现仅保存在此处，本次不迁入 Task Pattern。
- 历史交付可能保留旧配置和默认值；此快照用于追溯，不应按当前安装指南直接部署。

对比时纯版 Delivery 有 49 个文件，组合版有 148 个文件（不计 Python 缓存）。
两者共享 16 个相对路径，但这些文件的字节内容均不同；组合版另含 110 个 runtime 文件。
纯版带两个独立知识 Skill 和两个 knowledge Profile，组合版带 TaskPattern runtime。
功能存在重叠，不能视作可直接互删的重复副本。本次保留二者，后续另作取舍。
