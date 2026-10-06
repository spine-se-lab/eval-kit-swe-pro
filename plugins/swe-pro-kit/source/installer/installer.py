"""SWE-Pro's four managed operations; storage and transactions belong to Plugin Kit."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PROFILES = tuple(f"SWEPro{name}.yaml" for name in ("Decoder", "Aggregator", "Mapper", "Solver"))
ADAPTER = "icode-chrys-0.28"
BRIDGE = "src/chrys/orchestration/swe_pro_baseline.py"
TASK_ENVIRONMENT_BRIDGE = "src/chrys/service/task_environment.py"
TASK_NESTED_BRIDGE = "src/chrys/orchestration/task_nested.py"
LAUNCHER = "swe-pro-kit/run.py"
RECOMMENDED_HARBOR_VERSION = "0.7.0"


class InstallError(RuntimeError):
    pass


def _sha256(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def _adapter_sha256(file: Path) -> str:
    """Compare Git-managed Python sources independently of checkout EOL policy."""
    return hashlib.sha256(file.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _safe(path: Path) -> None:
    for item in (*reversed(path.parents), path):
        if item.is_symlink():
            raise InstallError(f"拒绝写入符号链接：{item}")
    if path.exists() and not path.is_file():
        raise InstallError(f"预期普通文件：{path}")


def _roots(request: dict[str, Any]) -> tuple[Path, Path, Path]:
    if not all(request.get("target", {}).get(key) for key in ("root", "config_root")):
        raise InstallError("managed request 缺少 target.root 或 target.config_root")
    managed = request.get("managed")
    if not isinstance(managed, dict) or not managed.get("package_root") or not managed.get("deployment_id"):
        raise InstallError("请通过统一 Plugin Kit 安装入口调用；需要 request.managed 的固定 Package 和事务上下文")
    paths = []
    for value in (request["target"]["root"], request["target"]["config_root"], managed["package_root"]):
        path = Path(value).expanduser().absolute()
        if not Path(value).expanduser().is_absolute():
            raise InstallError("目标、配置和 Package 路径必须是绝对路径")
        for parent in (*reversed(path.parents), path):
            if parent.is_symlink():
                raise InstallError(f"目录不允许符号链接：{parent}")
        paths.append(path)
    return tuple(paths)


def _adapter() -> tuple[dict[str, Any], Path]:
    root = PACKAGE_ROOT / "adapters/chrys" / ADAPTER
    value = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if value.get("schema") != "swe-pro-kit.chrys-adapter/v1" or not value.get("files"):
        raise InstallError("Chrys Adapter 清单无效")
    patch = (root / value["patch_file"]).read_text(encoding="utf-8")
    before = {line.removeprefix("--- a/") for line in patch.splitlines() if line.startswith("--- a/")}
    after = {line.removeprefix("+++ b/") for line in patch.splitlines() if line.startswith("+++ b/")}
    if before != set(value["files"]) or after != set(value["files"]):
        raise InstallError("Chrys 补丁实际写入与 Adapter 清单不一致")
    return value, root


def _owned(request: dict[str, Any]) -> dict[str, dict[str, Any]]:
    managed = request["managed"]
    state = Path(managed["state_root"]) / "swe-pro-kit.json"
    if not state.exists():
        return {}
    value = json.loads(state.read_text(encoding="utf-8"))
    deployment = next((item for item in value.get("deployments", [])
                       if item.get("id") == managed["deployment_id"] and item.get("status") != "removed"), {})
    return {item["path"]: item for item in deployment.get("activations", [])}


def _assert_owned(path: Path, owned: dict[str, dict[str, Any]]) -> None:
    _safe(path)
    if not path.exists():
        return
    previous = owned.get(str(path), {}).get("post_state", {})
    if previous.get("type") != "file" or previous.get("sha256") != _sha256(path):
        raise InstallError(f"文件未受当前部署管理或已发生漂移，拒绝覆盖：{path}")


def _version(target: Path) -> str:
    with (target / "pyproject.toml").open("rb") as file:
        project = tomllib.load(file).get("project", {})
    if project.get("name") != "chrys" or not project.get("version"):
        raise InstallError("目标不是可识别的 Chrys checkout")
    if str(project["version"]) != "0.28.0":
        raise InstallError("SWE-Pro requires Chrys 0.28.0")
    return str(project["version"])


def _python(request: dict[str, Any], target: Path) -> Path:
    value = request.get("configuration", {}).get("python")
    if value and not Path(value).expanduser().is_absolute():
        raise InstallError("python 配置必须是已有解释器的绝对路径")
    candidates = [Path(value).expanduser()] if value else [target / ".venv/bin/python", target / ".venv/Scripts/python.exe"]
    python = next((item.absolute() for item in candidates if item.is_file() and os.access(item, os.X_OK)), None)
    if python is None:
        raise InstallError("没有可用的现有 Chrys/Harbor Python；请用 --set python=/绝对路径/python 绑定已有环境")
    return python


def _run(command: list[str], target: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=target, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                          capture_output=True, text=True, check=False, timeout=45)


def _probe(python: Path, target: Path, package: Path, config: Path, *, installed: bool) -> dict[str, Any]:
    profile_root = config / "agents" if installed else package / "assets/profiles"
    expected_chrys_version = "0.28.0"
    code = "\n".join([
        "import sys, json, inspect, importlib.metadata",
        "from pathlib import Path",
        f"sys.path[:0] = {[str(package / 'package/src'), str(target / 'src')]!r}",
        "assert sys.version_info >= (3, 14), 'Chrys requires Python >=3.14'",
        "from harbor.agents.base import BaseAgent",
        "from harbor.cli.main import app",
        f"harbor_version = importlib.metadata.version('harbor')",
        f"assert harbor_version == {RECOMMENDED_HARBOR_VERSION!r}, 'SWE-Pro recommends Harbor {RECOMMENDED_HARBOR_VERSION}; got ' + harbor_version",
        "chrys_version = importlib.metadata.version('chrys')",
        f"assert chrys_version == {expected_chrys_version!r}, 'SWE-Pro requires Chrys {expected_chrys_version}; got ' + chrys_version",
        "from swe_pro_kit.adapters.harbor.agent import ChrysAgent",
        "assert issubclass(ChrysAgent, BaseAgent) and not inspect.isabstract(ChrysAgent)",
        f"assert Path(inspect.getfile(ChrysAgent)).resolve().is_relative_to(Path({str(package / 'package/src')!r}).resolve()), 'SWE import escaped fixed package'",
        "import chrys",
        f"assert Path(chrys.__file__).resolve().is_relative_to(Path({str(target / 'src/chrys')!r}).resolve()), 'Chrys import escaped selected target'",
        "from chrys.orchestration.engine.engine import AgentEngine",
        "from chrys.orchestration.sub_agents.tools import SubAgentTools",
        "from chrys.service.profiles.agents.loader import load_profile_from_yaml",
        f"for name in {PROFILES!r}:",
        f"    profile = load_profile_from_yaml(Path({str(profile_root)!r}) / name)",
        "    assert profile.name == name.removesuffix('.yaml'), 'unexpected profile identity'",
        *( [
            "from chrys.orchestration.swe_pro_baseline import ChrysAgent as BoundAgent",
            "from chrys.service.task_environment import load_remote_tools",
            "from chrys.orchestration.task_nested import register_children",
            "assert BoundAgent is ChrysAgent and callable(load_remote_tools) and callable(register_children)",
        ] if installed else [] ),
        "print(json.dumps({'python':sys.executable, 'version':'.'.join(map(str,sys.version_info[:3])), 'harbor':'loaded', 'harbor_version':harbor_version, 'chrys':'loaded', 'chrys_version':chrys_version}))",
    ])
    result = _run([str(python), "-B", "-c", code], target)
    if result.returncode:
        if "No module named 'harbor'" in result.stderr or 'No module named "harbor"' in result.stderr:
            raise InstallError(
                "Harbor 0.7.0 is missing from the selected Python. Prepare a supported environment with: "
                "uv venv --python 3.14 /absolute/swe-pro-harbor && "
                "uv pip install --python /absolute/swe-pro-harbor/bin/python 'harbor==0.7.0'; "
                "then retry with --set python=/absolute/swe-pro-harbor/bin/python"
            )
        # The shared caller redacts credential values. Keep diagnostics limited to the final error line.
        diagnostic = next((line for line in reversed(result.stderr.splitlines()) if line.strip()), "未知加载错误")
        raise InstallError(f"绑定的 Python 无法加载真实 Chrys/Harbor/SWE Agent：{diagnostic}")
    try:
        value = json.loads(result.stdout.splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise InstallError("运行环境探针没有返回有效证据") from exc
    cli = "import sys; sys.path[:0] = " + repr([str(package / "package/src"), str(target / "src")]) + "; from harbor.cli.main import app; app()"
    cli_result = _run([str(python), "-B", "-c", cli, "--help"], target)
    if cli_result.returncode:
        raise InstallError("绑定 Python 中的 Harbor CLI 无法启动")
    return {"kind": "runtime_binding", **value, "managed": False, "recommended_harbor_version": RECOMMENDED_HARBOR_VERSION,
            "harbor_cli": "started", "profiles": "loaded"}


def _bridge(package: Path) -> bytes:
    return _adapter_bridge(package, "swe_pro_kit.adapters.harbor.agent", "ChrysAgent")


def _adapter_bridge(package: Path, module: str, symbol: str) -> bytes:
    return ("# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.\n\n"
            '"""Managed by CodeHelix SWE-Pro Kit; implementation is pinned in PackageStore."""\n\n'
            "from __future__ import annotations\n\n"
            "import sys\nfrom importlib import import_module\n\n"
            f"_source = {json.dumps(str(package / 'package/src'), ensure_ascii=False)}\n"
            "if _source not in sys.path:\n    sys.path.insert(0, _source)\n\n"
            f"{symbol} = import_module({json.dumps(module)}).{symbol}\n\n"
            f"__all__ = [{json.dumps(symbol)}]\n").encode()


def _launcher(python: Path, target: Path, config: Path, package: Path) -> bytes:
    # This is an activation, not business logic. Settings and bindings are runtime arguments.
    return ("#!/usr/bin/env python3\n"
            '"""Launch one Harbor run with the installed SWE-Pro baseline."""\n'
            "import argparse, json, os, re, subprocess, sys\n"
            "p = argparse.ArgumentParser(description=__doc__)\n"
            "p.add_argument('--setting', required=True)\n"
            "p.add_argument('--bindings')\n"
            "p.add_argument('--repository')\n"
            "p.add_argument('--instance-id')\n"
            "p.add_argument('--base-commit')\n"
            "p.add_argument('--issue-number', type=int)\n"
            "args, harbor_args = p.parse_known_args()\n"
            "for flag in ('--agent-import-path', '-a', '--agent'):\n"
            "    if any(value == flag or value.startswith(flag + '=') for value in harbor_args):\n"
            "        p.error('Agent is supplied by this SWE-Pro activation')\n"
            f"python = {str(python)!r}\n"
            f"paths = {[str(package / 'package/src'), str(target / 'src')]!r}\n"
            "fixed = []\n"
            "evaluation_repository = ''\n"
            "evaluation_preparation = ''\n"
            "if args.setting == 'taskpattern-evaluation':\n"
            "    if not args.instance_id or not args.base_commit:\n"
            "        p.error('taskpattern-evaluation requires --instance-id and --base-commit')\n"
            "    if any(value == '--agent-timeout-multiplier' or value.startswith('--agent-timeout-multiplier=') for value in harbor_args):\n"
            "        p.error('taskpattern-evaluation fixes --agent-timeout-multiplier=4')\n"
            "    match = re.fullmatch(r'instance_(?P<owner>[^/]+?)__(?P<repo>.+)-(?P<base>[0-9a-fA-F]{40})(?:-v.*)?', args.instance_id)\n"
            "    inferred_repository = (match.group('owner') + '/' + match.group('repo')) if match else ''\n"
            "    if args.repository and inferred_repository and args.repository != inferred_repository:\n"
            "        p.error('--repository does not match --instance-id')\n"
            "    evaluation_repository = args.repository or inferred_repository\n"
            "    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', evaluation_repository):\n"
            "        p.error('taskpattern-evaluation requires --repository owner/repo when it cannot be inferred')\n"
            "    evaluation_key = os.environ.get('SWE_PRO_API_KEY') or os.environ.get('OPENAI_API_KEY')\n"
            "    if evaluation_key:\n"
            "        for role in ('JUDGE', 'GENERATOR'):\n"
            "            os.environ.setdefault('TASKPATTERN_' + role + '_API_KEY', evaluation_key)\n"
            "            os.environ.setdefault('TASKPATTERN_' + role + '_MODEL', 'deepseek/deepseek-v4-flash')\n"
            "            os.environ.setdefault('TASKPATTERN_' + role + '_BASE_URL', 'https://openrouter.ai/api/v1')\n"
            "    print('[swe-pro/taskpattern] evaluation mode: preparing the exhaustive closed-issue catalog before measured task execution; preparation progress follows.', file=sys.stderr, flush=True)\n"
            "    profile_code = \"; \".join([\n"
            "        'import json, sys',\n"
            "        'from pathlib import Path',\n"
            "        'sys.path[:0] = ' + repr(paths),\n"
            "        'from chrys.service.profiles.agents.loader import load_profile_from_yaml',\n"
            f"        {('profile = load_profile_from_yaml(Path(' + repr(str(config / 'agents/CodeTaskPatternAdvisor.yaml')) + '))')!r},\n"
            "        \"servers = [server for server in profile.tools.mcp if server.name == 'taskpattern']\",\n"
            "        \"assert len(servers) == 1, 'installed TaskPattern profile must expose one runtime server'\",\n"
            "        \"print(json.dumps([servers[0].command, *servers[0].args]))\",\n"
            "    ])\n"
            "    profile_result = subprocess.run([python, '-B', '-c', profile_code], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)\n"
            "    if profile_result.returncode:\n"
            "        raise SystemExit('[swe-pro/taskpattern] preparation failed before task start: installed CodeTaskPatternAdvisor profile is missing or invalid')\n"
            "    try:\n"
            "        advisor_command = json.loads(profile_result.stdout.splitlines()[-1])\n"
            "    except (ValueError, IndexError):\n"
            "        raise SystemExit('[swe-pro/taskpattern] preparation failed before task start: TaskPattern command could not be resolved')\n"
            "    prepared = subprocess.run([*advisor_command, '--retrieval-strategy', 'evaluation', '--prepare-evaluation', '--evaluation-repository', evaluation_repository], text=True, stdout=subprocess.PIPE, check=False)\n"
            "    if prepared.returncode:\n"
            "        raise SystemExit('[swe-pro/taskpattern] catalog preparation failed; measured task execution was not started')\n"
            "    try:\n"
            "        evaluation_preparation = prepared.stdout.splitlines()[-1].strip()\n"
            "    except IndexError:\n"
            "        evaluation_preparation = ''\n"
            "    if not evaluation_preparation or not os.path.isabs(evaluation_preparation) or not os.path.isfile(evaluation_preparation):\n"
            "        raise SystemExit('[swe-pro/taskpattern] catalog preparation returned no verifiable record; measured task execution was not started')\n"
            "    print('[swe-pro/taskpattern] preparation completed; starting measured task with the verified shared snapshot: ' + evaluation_preparation, file=sys.stderr, flush=True)\n"
            "    fixed = ['--agent-timeout-multiplier', '4']\n"
            "code = 'import sys; sys.path[:0] = ' + repr(paths) + '; from harbor.cli.main import app; app()'\n"
            "command = [python, '-B', '-c', code, 'run', *harbor_args, *fixed,\n"
            "           '--agent-import-path', 'chrys.orchestration.swe_pro_baseline:ChrysAgent',\n"
            "           '--agent-kwarg', 'setting=' + args.setting,\n"
            f"           '--agent-kwarg', {'config_root=' + str(config)!r}]\n"
            "if args.bindings:\n    command += ['--agent-kwarg', 'bindings=' + os.path.abspath(args.bindings)]\n"
            "if args.repository:\n    command += ['--agent-kwarg', 'repo=' + args.repository]\n"
            "if args.instance_id:\n    command += ['--agent-kwarg', 'instance_id=' + args.instance_id]\n"
            "if args.base_commit:\n    command += ['--agent-kwarg', 'base_commit=' + args.base_commit]\n"
            "if args.issue_number is not None:\n    command += ['--agent-kwarg', 'issue_number=' + str(args.issue_number)]\n"
            "if evaluation_preparation:\n"
            "    command += ['--agent-kwarg', 'evaluation_repository=' + evaluation_repository,\n"
            "                '--agent-kwarg', 'evaluation_preparation=' + evaluation_preparation]\n"
            "if os.name == 'nt':\n    raise SystemExit(subprocess.call(command))\n"
            "os.execv(python, command)\n").encode()


def _payload(target: Path, config: Path, package: Path, python: Path) -> dict[Path, bytes]:
    payload = {config / "agents" / name: (PACKAGE_ROOT / "assets/profiles" / name).read_bytes() for name in PROFILES}
    payload[target / BRIDGE] = _bridge(package)
    payload[target / TASK_ENVIRONMENT_BRIDGE] = _adapter_bridge(
        package, "swe_pro_kit.adapters.chrys.tools", "load_remote_tools",
    )
    payload[target / TASK_NESTED_BRIDGE] = _adapter_bridge(
        package, "swe_pro_kit.adapters.chrys.nested", "register_children",
    )
    payload[config / LAUNCHER] = _launcher(python, target, config, package)
    return payload


def _owned_original_bytes(
    path: Path,
    owned: dict[str, dict[str, Any]],
    expected_baseline: str,
) -> bytes | None:
    activation = owned.get(str(path), {})
    post_state = activation.get("post_state") or {}
    original = activation.get("original") or {}
    if (
        activation.get("kind") != "source_patch"
        or activation.get("ownership") != "codehelix"
        or post_state.get("type") != "file"
        or post_state.get("sha256") != _sha256(path)
        or original.get("type") != "file"
        or not isinstance(original.get("bytes"), str)
    ):
        return None
    try:
        contents = base64.b64decode(original["bytes"], validate=True)
    except (ValueError, TypeError):
        return None
    if hashlib.sha256(contents.replace(b"\r\n", b"\n")).hexdigest() != expected_baseline:
        return None
    return contents


def _patch_states(
    target: Path,
    adapter: dict[str, Any],
    owned: dict[str, dict[str, Any]],
) -> dict[str, str]:
    states = {}
    for relative, expected in adapter["files"].items():
        path = target / relative
        if path.is_absolute() and not path.is_relative_to(target) or ".." in Path(relative).parts:
            raise InstallError("Adapter target 超出 Chrys root")
        _safe(path)
        if not path.is_file():
            raise InstallError(f"目标缺少 Adapter 能力：{relative}")
        digest = _adapter_sha256(path)
        state = (
            "baseline"
            if digest == expected["baseline_sha256"]
            else "applied"
            if digest == expected["patched_sha256"]
            else "owned_previous"
            if _owned_original_bytes(path, owned, expected["baseline_sha256"]) is not None
            else "unknown"
        )
        if state == "unknown":
            raise InstallError(f"Chrys Adapter 与源码不匹配（可能有其他插件或用户修改）：{path}")
        states[relative] = state
    return states


def _preflight(
    request: dict[str, Any],
    target: Path,
    payload: dict[Path, bytes],
    states: dict[str, str],
    owned: dict[str, dict[str, Any]],
) -> None:
    for path in payload:
        _assert_owned(path, owned)
    for relative, state in states.items():
        if state in {"applied", "owned_previous"}:
            _assert_owned(target / relative, owned)
    state_set = set(states.values())
    upgrade = "owned_previous" in state_set and state_set <= {"applied", "owned_previous"}
    if len(state_set) != 1 and not upgrade:
        raise InstallError("Chrys Adapter 仅部分应用；请先恢复一致状态")
    declarations = json.loads(
        (PACKAGE_ROOT / "codehelix-plugin.json").read_text(encoding="utf-8")
    )["managed_install"]["target_paths"]
    target_paths = {str((Path(request["target"]["config_root"]) if item["root"] == "config" else target) / item["path"])
                    for item in declarations}
    if {str(path) for path in payload} | {str(target / path) for path in states} != target_paths:
        raise InstallError("安装写入路径与 managed_install.target_paths 不一致")


def run_operation(operation: str, request: dict[str, Any]) -> tuple[dict[str, Any], int]:
    changes: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    mutated = False

    def result(status: str, message: str, *, planned=None):
        facts = list(evidence)
        if operation == "install" and status != "ok":
            facts.append({"kind": "mutation_state", "state": "modified" if mutated else "unchanged"})
        return {"status": status, "message": message, "changes": changes if planned is None else planned, "evidence": facts}

    if (not isinstance(request, dict) or ("target" in request and not isinstance(request["target"], dict))
            or any(name in request.get("target", {}) and not isinstance(request["target"][name], str)
                   for name in ("root", "config_root"))
            or not isinstance(request.get("configuration", {}), dict)):
        return {"status": "failed", "message": "installer request 格式无效", "changes": [], "evidence": []}, 1
    try:
        target, config, package = _roots(request)
        version = _version(target)
        evidence.append({"kind": "target_identity", "version": version, "root": str(target)})
        adapter, adapter_root = _adapter()
        owned = _owned(request)
        states = _patch_states(target, adapter, owned)
        python = _python(request, target)
        payload = _payload(target, config, package, python)
        if operation != "verify":
            _preflight(request, target, payload, states, owned)
        evidence.append(_probe(python, target, PACKAGE_ROOT, config, installed=operation == "verify"))
        evidence.append({"kind": "compatibility", "adapter": ADAPTER, "status": "compatible", "verified": False,
                         "reason": "精确源码与真实 import 探针通过；尚未声明该环境完成真实 SWE-bench Pro 任务验收"})
        plan = [{"kind": "profile", "path": str(config / "agents" / name)} for name in PROFILES]
        plan += [{"kind": "source_patch", "path": str(target / relative), "state": state} for relative, state in states.items()]
        plan += [
            {"kind": "bridge", "path": str(target / path)}
            for path in (BRIDGE, TASK_ENVIRONMENT_BRIDGE, TASK_NESTED_BRIDGE)
        ]
        plan += [{"kind": "executable", "path": str(config / LAUNCHER)}]
        if operation == "check":
            return result("ok", f"已绑定 Harbor {RECOMMENDED_HARBOR_VERSION} 和 SWE-Pro Adapter 预检通过"), 0
        if operation == "plan":
            return result("ok", f"固定纯基线包，激活 {len(PROFILES)} 个原子 Profile、Harbor 入口和 {len(states)} 处最小接线", planned=plan), 0
        if operation == "install":
            if PACKAGE_ROOT != package or not package.is_dir():
                raise InstallError("安装阶段必须从统一框架固定的 PackageStore 中执行")
            if "owned_previous" in states.values():
                with tempfile.TemporaryDirectory(prefix="swe-pro-adapter-") as temporary:
                    staged_root = Path(temporary)
                    for relative, expected in adapter["files"].items():
                        path = target / relative
                        original = _owned_original_bytes(
                            path, owned, expected["baseline_sha256"]
                        )
                        if original is None:
                            raise InstallError(
                                f"Previously managed Chrys Adapter cannot be migrated safely: {path}"
                            )
                        staged = staged_root / relative
                        staged.parent.mkdir(parents=True, exist_ok=True)
                        # The managed original may come from a Windows checkout. The
                        # adapter manifest deliberately hashes normalized newlines,
                        # so stage the same canonical LF form before applying the
                        # release patch with core.autocrlf disabled.
                        staged.write_bytes(original.replace(b"\r\n", b"\n"))
                    patch = adapter_root / adapter["patch_file"]
                    command = [
                        "git", "-c", "core.autocrlf=false", "-c", "core.eol=lf",
                        "-c", "core.safecrlf=false", "apply",
                    ]
                    check = _run([*command, "--check", str(patch)], staged_root)
                    if check.returncode:
                        diagnostic = next(
                            (line for line in reversed(check.stderr.splitlines()) if line.strip()),
                            "patch check failed",
                        )
                        raise InstallError(
                            "Previously managed Chrys Adapter cannot be migrated to this release: "
                            + diagnostic
                        )
                    applied = _run([*command, str(patch)], staged_root)
                    if applied.returncode:
                        raise InstallError(
                            "Previously managed Chrys Adapter staging failed before host mutation"
                        )
                    if any(
                        _adapter_sha256(staged_root / relative) != expected["patched_sha256"]
                        for relative, expected in adapter["files"].items()
                    ):
                        raise InstallError("Migrated Chrys Adapter output did not match this release")
                    previous = {
                        relative: (target / relative).read_bytes()
                        for relative in adapter["files"]
                    }
                    try:
                        for relative in adapter["files"]:
                            (target / relative).write_bytes((staged_root / relative).read_bytes())
                            mutated = True
                    except OSError:
                        for relative, contents in previous.items():
                            (target / relative).write_bytes(contents)
                        raise
                    changes.extend(
                        {"kind": "source_patch", "path": str(target / relative)}
                        for relative in states
                    )
            elif set(states.values()) == {"baseline"}:
                patch = adapter_root / adapter["patch_file"]
                check = _run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false",
                              "apply", "--check", str(patch)], target)
                if check.returncode:
                    raise InstallError("Chrys 接线补丁无法完整应用")
                applied = _run(["git", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.safecrlf=false",
                                "apply", str(patch)], target)
                if applied.returncode:
                    raise InstallError("Chrys 接线补丁应用失败；共享事务将恢复受管文件")
                mutated = True
                changes.extend({"kind": "source_patch", "path": str(target / relative)} for relative in states)
            for path, contents in payload.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
                mutated = True
                path.chmod(0o755 if path == config / LAUNCHER else 0o644)
                changes.append({"kind": "activation", "path": str(path)})
            return result("ok", "SWE-Pro 基线激活已写入，等待统一框架执行只读验证"), 0
        if operation == "verify":
            if set(states.values()) != {"applied"}:
                raise InstallError("Chrys 接线补丁尚未完成")
            for path, expected in payload.items():
                _safe(path)
                if not path.is_file() or path.read_bytes() != expected:
                    raise InstallError(f"激活内容与固定 Package 不一致：{path}")
            evidence.append({"kind": "post_state", "profiles": len(PROFILES), "patch_files": len(states), "bridge": "loaded"})
            return result("ok", "SWE-Pro 基线安装验证通过；模型、任务环境与评测结果需在真实运行时验收"), 0
        raise InstallError(f"不支持的 operation：{operation}")
    except (InstallError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        return result("blocked" if operation in {"check", "plan"} else "failed", str(exc)), 2


def main() -> int:
    parser = argparse.ArgumentParser(description="SWE-Pro managed installer protocol")
    parser.add_argument("mode", choices=["protocol"])
    parser.add_argument("operation", choices=["check", "plan", "install", "verify"])
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.read())
    except ValueError:
        print(json.dumps({"status": "failed", "message": "installer request 必须是 JSON", "changes": [], "evidence": []}))
        return 1
    answer, code = run_operation(args.operation, request)
    print(json.dumps(answer, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
