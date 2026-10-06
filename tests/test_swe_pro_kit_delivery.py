"""Contracts for the clean baseline's built Delivery and detached runtime assets."""

from __future__ import annotations

import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

import pytest


ROOT = Path(__file__).parents[1]
PLUGIN = ROOT / "plugins/swe-pro-kit"
SOURCE = PLUGIN / "source"
DELIVERY = PLUGIN / "delivery/icode-chrys-0.28"
PROFILES = {f"SWEPro{role}" for role in ("Decoder", "Aggregator", "Mapper", "Solver")}
SETTINGS = {
    "three-decoder-icode-workflow",
    "single-decoder", "three-decoder", "three-decoder-serial", "sub-agent", "sub-agent-serial",
    "legacy-workflow", "taskpattern-evaluation",
}


def _json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _run(script: str, distribution: Path, *, python: str = sys.executable, host: Path | None = None):
    env = dict(os.environ)
    paths = [str(distribution / "package/src")]
    if host:
        paths.append(str(host / "src"))
    env["PYTHONPATH"] = os.pathsep.join(paths)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run(
        [python, "-B", "-c", script, str(distribution)],
        cwd=distribution, env=env, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.splitlines()[-1])


@pytest.mark.parametrize("profile,version,runtime_kind", [
    ("icode-chrys-0.28", "0.28.0", "external"),
])
def test_delivery_declares_baseline_and_managed_activation_ownership(profile, version, runtime_kind):
    delivery = PLUGIN / "delivery" / profile
    manifest = _json(delivery / "codehelix-plugin.json")
    assert manifest["plugin"]["id"] == "swe-pro-kit"
    assert manifest["plugin"]["version"] == "0.3.3"
    assert manifest["compatibility"]["target_version"] == version
    assert manifest["dependencies"] == []
    assert manifest["managed_install"]["skills"] == []
    assert manifest["installer"]["command"] == ["npx", "--package", ".", "codehelix-swe-pro-kit", "protocol"]
    runtimes = manifest["managed_install"]["runtimes"]
    assert len(runtimes) == 1 and runtimes[0]["kind"] == runtime_kind
    evaluation = _json(delivery / "assets/evaluations/taskpattern-evaluation.json")
    assert evaluation["host"]["target_version"] == version
    assert evaluation["host"]["base_commit"] == manifest["compatibility"]["base_commit"]
    assert not list((delivery / "package/src").glob("chrys-*.dist-info"))
    assert {path.name for path in (PLUGIN / "delivery").iterdir() if path.is_dir()} == {"icode-chrys-0.28"}
    assert {path.name for path in (delivery / "adapters/chrys").iterdir() if path.is_dir()} == {"icode-chrys-0.28"}
    assert {path.stem for path in (DELIVERY / "assets/profiles").glob("*.yaml")} == PROFILES
    assert {path.stem for path in (DELIVERY / "assets/settings").glob("*.json")} == SETTINGS
    assert set(_json(DELIVERY / "assets/bindings.json").values()) == PROFILES
    activations = manifest["managed_install"]["target_paths"]
    assert {(entry["root"], entry["path"]) for entry in activations if entry["kind"] == "profile"} == {
        ("config", f"agents/{name}.yaml") for name in PROFILES
    }
    assert {entry["path"] for entry in activations if entry["kind"] == "bridge"} == {
        "src/chrys/orchestration/swe_pro_baseline.py",
        "src/chrys/service/task_environment.py",
        "src/chrys/orchestration/task_nested.py",
    }
    assert [entry["path"] for entry in activations if entry["kind"] == "executable"] == ["swe-pro-kit/run.py"]
    assert all("setting" not in entry["path"] for entry in activations)


def test_delivery_lock_covers_actual_payload_and_source_assets():
    locked = _json(DELIVERY / "delivery-lock.json")["files"]
    files = {
        path.relative_to(DELIVERY).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in DELIVERY.rglob("*")
        if path.is_file() and path.name != "delivery-lock.json"
        and "__pycache__" not in path.parts and path.suffix != ".pyc" and path.name != ".DS_Store"
    }
    assert files == locked
    for subtree in ("package", "assets", "adapters", "installer", "bin"):
        for source_file in (SOURCE / subtree).rglob("*"):
            if source_file.is_file() and "__pycache__" not in source_file.parts and source_file.suffix != ".pyc":
                relative = source_file.relative_to(SOURCE)
                assert (DELIVERY / relative).read_bytes() == source_file.read_bytes(), relative


@pytest.mark.parametrize("distribution", [SOURCE, DELIVERY], ids=["source", "delivery"])
def test_independent_package_and_minimal_host_adapter(distribution):
    metadata = tomllib.loads((distribution / "package/pyproject.toml").read_text())
    assert metadata["project"]["name"] == "swe-pro-kit"
    assert metadata["project"]["version"] == _json(distribution / "package.json")["version"] == "0.3.3"
    adapter = distribution / "adapters/chrys/icode-chrys-0.28"
    manifest = _json(adapter / "manifest.json")
    patch = (adapter / manifest["patch_file"]).read_text()
    changed = re.findall(r"^\+\+\+ b/(.+)$", patch, flags=re.MULTILINE)
    assert changed and len(changed) == len(set(changed)) and set(changed) == set(manifest["files"])
    assert "if runner is not None:" in patch
    assert "mcp_tool.client = client" in patch
    assert "mcp_tool.sampling_approval_callback" in patch
    target = _json(PLUGIN / "targets/icode-chrys-0.28.json")
    declared = {entry["path"] for entry in target["managed_install"]["target_paths"] if entry["kind"] == "source_patch"}
    assert declared == set(changed)
    assert all(item["baseline_sha256"] != item["patched_sha256"] for item in manifest["files"].values())
    assert not (distribution / "assets/chrys-overlay").exists()


@pytest.mark.parametrize("distribution", [SOURCE, DELIVERY], ids=["source", "delivery"])
def test_copied_distribution_composes_every_setting_without_checkout_or_augmentation(distribution, tmp_path):
    detached = tmp_path / "fixed-package"
    for part in ("package", "assets", "adapters"):
        shutil.copytree(distribution / part, detached / part, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    script = r'''
import asyncio, json, sys
from pathlib import Path
from swe_pro_kit import __version__
from swe_pro_kit.runtime.distribution import distribution_root
from swe_pro_kit.core.configuration import load_setting, load_bindings, expected_stage_roles
from swe_pro_kit.core.execution import execute, StageExecution
from swe_pro_kit.core.contracts import Orchestration
from contextlib import asynccontextmanager
@asynccontextmanager
async def private_paths(count):
    yield [f"/private-decoder/{i}" for i in range(count)]
root = Path(sys.argv[1])
assert distribution_root() == root
bindings = load_bindings(root / "assets/bindings.json")
results = {}
async def check(path):
    setting = load_setting(path)
    calls = []
    async def stage(**call):
        calls.append(call)
        return StageExecution("<issue_analysis>completed " + call["role"] + "</issue_analysis>", {"input": 2, "output": 1})
    if setting.executor == "icode-workflow":
        try:
            await execute(setting, bindings, stage, "Original issue", "/task/repository", decoder_workspaces=private_paths(setting.decoder_count))
        except ValueError as exc:
            assert "native workflow adapter" in str(exc)
        else:
            raise AssertionError("Native workflow must never fall back to the Python stage scheduler")
        assert not calls
        results[path.stem] = ["native-adapter-required"]
        return
    result = await execute(setting, bindings, stage, "Original issue", "/task/repository", decoder_workspaces=private_paths(setting.decoder_count))
    assert all("Original issue" in call["instruction"] for call in calls)
    if setting.executor in {"workflow", "legacy-workflow"}:
        assert [call["role"] for call in calls] == list(expected_stage_roles(setting))
        assert result.final_output == "<issue_analysis>completed solver</issue_analysis>"
        assert sum(item.usage["input"] for item in result.stages) == len(calls) * 2
    else:
        assert len(calls) == 1 and calls[0]["role"] == "orchestrator"
        assert calls[0]["profile"] == Orchestration(setting, bindings)
    results[path.stem] = [item.role for item in result.stages]
for path in sorted((root / "assets/settings").glob("*.json")):
    asyncio.run(check(path))
print(json.dumps({"version": __version__, "settings": results}))
'''
    result = _run(script, detached)
    assert result["version"] == "0.3.3"
    assert set(result["settings"]) == SETTINGS


@pytest.mark.parametrize("distribution", [SOURCE, DELIVERY], ids=["source", "delivery"])
def test_runtime_payload_has_no_historical_modules_embedded_taskpattern_runtime_or_proxy(distribution):
    forbidden_names = (
        "issue-similarity-search", "plan-generator", "chrys-overlay", "taskpattern-runtime", "taskpattern_runtime",
    )
    for path in distribution.rglob("*"):
        if "__pycache__" in path.parts or path.suffix in {".pyc", ".md"}:
            continue
        relative = path.relative_to(distribution).as_posix().lower()
        assert not any(name in relative for name in forbidden_names), relative
        if not path.is_file() or path.suffix != ".py":
            continue
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                modules = []
            assert not any(term in module.lower() for module in modules for term in forbidden_names), relative
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                segment = ast.get_source_segment(text, node) or ""
                assert not (re.search(r"(?i)(?:https?|all)_proxy", segment) and re.search(r"https?://", segment)), relative
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                assert not re.search(r"(?:https?|socks5?)://[^\s'\"]+@", node.value), relative


@pytest.mark.parametrize("distribution", [SOURCE, DELIVERY], ids=["source", "delivery"])
def test_profiles_parse_with_real_supported_chrys_loader(distribution):
    """Optional real-host gate; enable explicitly so CI never substitutes a mock loader."""
    host_setting = os.environ.get("SWE_PRO_TEST_CHRYS")
    if not host_setting:
        pytest.skip("set SWE_PRO_TEST_CHRYS and SWE_PRO_TEST_PYTHON for the real Chrys 0.28 gate")
    host = Path(host_setting)
    python = os.environ.get("SWE_PRO_TEST_PYTHON", sys.executable)
    script = r'''
import json, sys, tempfile, yaml
from pathlib import Path
from chrys.service.profiles.agents.loader import load_profile_from_yaml
from swe_pro_kit.core.configuration import load_setting, load_bindings
from swe_pro_kit.adapters.chrys.composition import build_orchestrator_profile
root = Path(sys.argv[1])
bindings = load_bindings(root / "assets/bindings.json")
parsed = []
def assert_loaded(declared, loaded):
    if isinstance(declared, dict):
        for key, value in declared.items():
            if key == "reserved_context_pct":
                # Chrys 0.28 explicitly treats this historical field as obsolete.
                # Preserve the archived file; do not invent a new compaction policy.
                from chrys.service.profiles.agents.schema import CompactionConfig
                assert value == 0.15 and loaded == CompactionConfig()
                continue
            child = loaded[key] if isinstance(loaded, dict) else getattr(loaded, key)
            assert_loaded(value, child)
    elif isinstance(declared, list):
        assert len(declared) == len(loaded)
        for expected, actual in zip(declared, loaded):
            assert_loaded(expected, actual)
    else:
        assert declared == loaded
for name in bindings.to_dict().values():
    path = root / "assets/profiles" / (name + ".yaml")
    declared = yaml.safe_load(path.read_text(encoding="utf-8"))
    profile = load_profile_from_yaml(path)
    assert profile.name == name and not profile.sub_agents.agents
    assert not profile.skills.paths and not profile.skills.inline
    assert not profile.tools.mcp and not profile.tools.custom
    assert_loaded(declared, profile)
    parsed.append(name)
with tempfile.TemporaryDirectory() as directory:
    for path in (root / "assets/settings").glob("*.json"):
        setting = load_setting(path)
        if setting.executor != "sub-agent":
            continue
        root_profile = Path(directory) / "root.json"
        data = build_orchestrator_profile(setting, bindings)
        root_profile.write_text(json.dumps(data), encoding="utf-8")
        loaded = load_profile_from_yaml(root_profile)
        assert_loaded(data, loaded)
        assert loaded.tools.builtins == ["filesystem.read", "search", "shell"]
        assert loaded.sub_agents.max_total_concurrency == data["sub_agents"]["max_total_concurrency"]
        assert len(loaded.sub_agents.agents) == 3
        assert {child.profile for child in loaded.sub_agents.agents} == {"SWEProDecoderOrchestrator", "SWEProMapper", "SWEProSolver"}
        assert [child.tool_name for child in loaded.sub_agents.agents] == [item["tool_name"] for item in data["sub_agents"]["agents"]]
print(json.dumps({"profiles": parsed}))
'''
    assert set(_run(script, distribution, python=python, host=host)["profiles"]) == PROFILES
