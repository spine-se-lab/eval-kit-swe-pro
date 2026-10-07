"""Real shared-core transactions with the SWE installer and an offline host fixture.

The tiny Chrys/Harbor modules only prove installation/import plumbing. They do not
stand in for a real Harbor task, model invocation, or SWE-bench Pro score.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / "plugins/swe-pro-kit"
SOURCE = PLUGIN / "source"
CORE = REPO / "plugin-kit/installation/orchestrator.js"


def write(root: Path, relative: str, content: str | bytes) -> Path:
    file = root / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(content.encode() if isinstance(content, str) else content)
    return file


def digest(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def lock(delivery: Path) -> None:
    write(delivery, "delivery-lock.json", json.dumps({"schema": "codehelix.delivery_lock/v1", "files": {
        item.relative_to(delivery).as_posix(): digest(item)
        for item in sorted(delivery.rglob("*")) if item.is_file() and item.name != "delivery-lock.json"
    }}))


def python314() -> str:
    if sys.version_info >= (3, 14):
        return sys.executable
    command = shutil.which("python3.14")
    if command:
        return command
    if shutil.which("uv"):
        result = subprocess.run(["uv", "python", "find", "3.14", "--offline"], text=True, capture_output=True)
        if result.returncode == 0:
            return result.stdout.strip()
    pytest.skip("offline Python >=3.14 is required by the Chrys runtime binding")


@pytest.fixture
def deployment(tmp_path):
    python314()
    root = tmp_path.resolve()
    delivery, target, config = (root / name for name in ("delivery", "target", "config"))
    write(target, "pyproject.toml", '[project]\nname="chrys"\nversion="0.28.0"\n')
    write(target, "src/chrys/__init__.py", "")
    write(target, "src/harbor/__init__.py", "")
    write(target, "src/harbor/agents/__init__.py", "")
    write(target, "src/harbor/agents/base.py", "class BaseAgent: pass\n")
    write(target, "src/harbor/cli/__init__.py", "")
    write(target, "src/harbor/cli/main.py", "import json,os,sys\ndef app(): print(json.dumps({'python':sys.executable,'argv':sys.argv[1:],'retrieval_strategy':os.environ.get('LINGXI_ADVISOR_RETRIEVAL_STRATEGY'),'lingxi_model':os.environ.get('LINGXI_ADVISOR_GENERATOR_MODEL'),'lingxi_key_present':bool(os.environ.get('LINGXI_ADVISOR_GENERATOR_API_KEY'))}))\n")
    write(target, "src/harbor-0.7.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: harbor\nVersion: 0.7.0\n")
    for relative in ("src/chrys/service/__init__.py", "src/chrys/service/profiles/__init__.py", "src/chrys/service/profiles/agents/__init__.py"):
        write(target, relative, "")
    write(target, "src/chrys/service/profiles/agents/loader.py", """from types import SimpleNamespace
def load_profile_from_yaml(path):
    values = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
    values = {key.strip(): value.strip() for key, value in values.items()}
    profile = SimpleNamespace(name=values['name'])
    if profile.name == 'LingxiAdvisor':
        server = SimpleNamespace(name='lingxi-advisor', command=values['command'], args=[values['arg']])
        profile.tools = SimpleNamespace(mcp=[server])
    return profile
""")
    declaration = json.loads((PLUGIN / "targets/icode-chrys-0.28.json").read_text(encoding="utf-8"))
    manifest = {"schema": "codehelix.plugin_package/v1", "plugin": json.loads((PLUGIN / "codehelix-plugin.json").read_text(encoding="utf-8"))["plugin"],
                **{key: value for key, value in declaration.items() if key not in {"schema", "profile"}}}
    write(delivery, "codehelix-plugin.json", json.dumps(manifest))
    for relative in ("package.json", "bin/codehelix-swe-pro-kit.js", "installer/installer.py", "installer/__init__.py"):
        write(delivery, relative, (SOURCE / relative).read_bytes())
    write(delivery, "package/src/swe_pro_kit/__init__.py", "")
    write(delivery, "package/src/swe_pro_kit/adapters/__init__.py", "")
    write(delivery, "package/src/swe_pro_kit/adapters/chrys/__init__.py", "")
    write(delivery, "package/src/swe_pro_kit/adapters/chrys/tools.py", "def load_remote_tools(*args, **kwargs): return []\n")
    write(delivery, "package/src/swe_pro_kit/adapters/chrys/nested.py", "async def register_children(*args, **kwargs): return []\n")
    write(delivery, "package/src/swe_pro_kit/adapters/harbor/agent.py", "from harbor.agents.base import BaseAgent\nclass ChrysAgent(BaseAgent): pass\n")
    write(target, "src/chrys-0.28.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: chrys\nVersion: 0.28.0\n")
    write(target, "src/chrys/orchestration/engine/engine.py", "class AgentEngine: pass\n")
    write(delivery, "package/pyproject.toml", (SOURCE / "package/pyproject.toml").read_bytes())
    for name in ("Decoder", "Aggregator", "Mapper", "Solver"):
        write(delivery, f"assets/profiles/SWEPro{name}.yaml", f"name: SWEPro{name}\ninstructions: Baseline fixture\n")
    source_adapter = json.loads((SOURCE / "adapters/chrys/icode-chrys-0.28/manifest.json").read_text(encoding="utf-8"))
    files, patches = {}, []
    for relative in source_adapter["files"]:
        before = "class AgentEngine: pass\n# baseline\n" if relative.endswith("engine/engine.py") else "class SubAgentTools: pass\n# baseline\n" if relative.endswith("sub_agents/tools.py") else "# baseline\n"
        after = before.replace("# baseline", "# runner injection")
        file = write(target, relative, before)
        for parent in file.parents:
            if parent == target / "src":
                break
            write(parent, "__init__.py", "")
        files[relative] = {"baseline_sha256": hashlib.sha256(before.encode()).hexdigest(), "patched_sha256": hashlib.sha256(after.encode()).hexdigest()}
        patches += difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile=f"a/{relative}", tofile=f"b/{relative}")
    write(delivery, "adapters/chrys/icode-chrys-0.28/manifest.json", json.dumps({"schema": "swe-pro-kit.chrys-adapter/v1", "patch_file": "runner.patch", "files": files}))
    write(delivery, "adapters/chrys/icode-chrys-0.28/runner.patch", "".join(patches))
    lock(delivery)
    request = {"home": str(root / "home"), "target": {"agent_system": "icode", "harness": "chrys", "root": str(target), "config_root": str(config)},
               "configuration": {"python": python314()}}
    yield {"root": root, "delivery": delivery, "target": target, "config": config, "request": request, "original": {p: (target / p).read_bytes() for p in files}}
    # PackageStore is intentionally read-only. Make this disposable fixture removable.
    for directory, children, files_ in os.walk(root):
        os.chmod(directory, 0o755)
        for file in files_:
            path = Path(directory) / file
            if not path.is_symlink():
                path.chmod(0o644)


def core(action: str, subject: Path | str, request: dict, *, check=True) -> dict:
    code = """const fs=require('node:fs'); const core=require(process.argv[1]);
(async()=>{const r=JSON.parse(fs.readFileSync(0,'utf8'));let answer;
if(process.argv[2]==='install'){const p=await core.prepare(process.argv[3],r);answer=await core.commit(process.argv[3],{plan:p.plan});}
else answer=await core[process.argv[2]](process.argv[3],r);
console.log(JSON.stringify(answer));})().catch(e=>{console.log(JSON.stringify({status:'error',message:e.message}));process.exitCode=2});"""
    result = subprocess.run(
        ["node", "-e", code, str(CORE), action, str(subject)],
        input=json.dumps(request),
        text=True,
        encoding="utf-8",
        capture_output=True,
    )
    answer = json.loads(result.stdout)
    if check:
        assert result.returncode == 0, answer
    return answer


def upgraded_delivery(deployment: dict, *, fail_verify: bool = False) -> Path:
    upgraded = deployment["root"] / "upgraded-delivery"
    shutil.copytree(deployment["delivery"], upgraded)
    manifest_path = upgraded / "adapters/chrys/icode-chrys-0.28/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    patches = []
    for relative, expected in manifest["files"].items():
        before = deployment["original"][relative].decode()
        after = before.replace("# baseline", "# runner injection v2")
        expected["patched_sha256"] = hashlib.sha256(after.encode()).hexdigest()
        patches += difflib.unified_diff(
            before.splitlines(True), after.splitlines(True),
            fromfile=f"a/{relative}", tofile=f"b/{relative}",
        )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    (upgraded / "adapters/chrys/icode-chrys-0.28/runner.patch").write_bytes(
        "".join(patches).encode()
    )
    if fail_verify:
        installer = upgraded / "installer/installer.py"
        installer.write_text(
            installer.read_text(encoding="utf-8").replace(
                'if operation == "verify":\n',
                'if operation == "verify":\n            raise InstallError("injected upgrade verification failure")\n',
            ),
            encoding="utf-8",
        )
    lock(upgraded)
    return upgraded


def test_full_managed_lifecycle_survives_source_removal_and_never_mutates_store(deployment):
    d = deployment
    prepared = core("prepare", d["delivery"], d["request"])
    assert prepared["compatibility_assessment"]["status"] == "unverified"
    assert not Path(d["request"]["home"]).exists()
    assert not d["config"].exists()
    installed = core("commit", d["delivery"], {"plan": prepared["plan"]})
    store = Path(installed["package_ref"]["root"])
    before = {str(p.relative_to(store)): digest(p) for p in store.rglob("*") if p.is_file()}
    assert all(p.stat().st_mode & 0o222 == 0 for p in store.rglob("*") if p.is_file())
    assert installed["deployment"]["runtime_refs"]["chrys-harbor"]["managed"] is False
    assert not (d["config"] / "skills").exists()
    assert json.dumps(str(store / "package/src")) in (d["target"] / "src/chrys/orchestration/swe_pro_baseline.py").read_text(encoding="utf-8")
    repeated = core("install", d["delivery"], d["request"])
    assert repeated["package_ref"]["root"] == installed["package_ref"]["root"]
    assert repeated["package_ref"]["reused"] is True
    d["delivery"].rename(d["root"] / "source-moved")
    retained = Path(installed["kit_root"]) / "plugin-kit/cli/managed-cli.js"
    inspect = subprocess.run(["node", str(retained), "inspect", "swe-pro-kit"], input=json.dumps({"home": d["request"]["home"]}), text=True, encoding="utf-8", capture_output=True)
    assert inspect.returncode == 0, inspect.stdout + inspect.stderr
    assert json.loads(inspect.stdout)["observation"]["registered"] is True
    # Fresh process loads the actual bridge after the borrowed Delivery is gone.
    runtime_python = d["request"]["configuration"]["python"]
    probe = subprocess.run([runtime_python, "-B", "-c", f"import sys; sys.path.insert(0,{str(d['target'] / 'src')!r}); from chrys.orchestration.swe_pro_baseline import ChrysAgent; print(ChrysAgent.__name__)"], text=True, encoding="utf-8", capture_output=True)
    assert probe.returncode == 0, probe.stderr
    launched = subprocess.run([sys.executable, "-B", str(d["config"] / "swe-pro-kit/run.py"), "--setting", "three-decoder", "-d", "fixture/dataset", "-o", str(d["root"] / "runs")], text=True, encoding="utf-8", capture_output=True)
    assert launched.returncode == 0, launched.stderr
    invocation = json.loads(launched.stdout)
    assert Path(invocation["python"]).resolve() == Path(runtime_python).resolve()
    assert "setting=three-decoder" in invocation["argv"]
    assert "config_root=" + str(d["config"]) in invocation["argv"]
    assert "chrys.orchestration.swe_pro_baseline:ChrysAgent" in invocation["argv"]
    missing_identity = subprocess.run(
        [sys.executable, "-B", str(d["config"] / "swe-pro-kit/run.py"),
         "--setting", "taskpattern-evaluation", "-d", "fixture/dataset"],
        text=True, encoding="utf-8", capture_output=True,
    )
    assert missing_identity.returncode == 2
    assert "requires --instance-id and --base-commit" in missing_identity.stderr
    prep_record = d["root"] / "evaluation-preparation.json"
    prep_invocation = d["root"] / "evaluation-preparation-argv.json"
    prep_script = write(d["root"], "taskpattern-preparation.py", f"""import json, sys
from pathlib import Path
Path({str(prep_invocation)!r}).write_text(json.dumps(sys.argv[1:]))
repository = sys.argv[sys.argv.index('--evaluation-repository') + 1]
record = {{'status': 'completed', 'repository': repository, 'cache_status': 'refreshed',
          'github_request_count': 2, 'duration_ms': 15, 'snapshot': {{'sha256': 'fixture'}}}}
Path({str(prep_record)!r}).write_text(json.dumps(record))
print(Path({str(prep_record)!r}).resolve())
""")
    write(
        d["config"], "agents/LingxiAdvisor.yaml",
        f"name: LingxiAdvisor\ncommand: {runtime_python}\narg: {prep_script}\n",
    )
    instance_id = "instance_owner__repo-" + "a" * 40 + "-v1"
    eval_env = dict(os.environ)
    eval_env["SWE_PRO_API_KEY"] = "fixture-model-key"
    evaluated = subprocess.run(
        [sys.executable, "-B", str(d["config"] / "swe-pro-kit/run.py"),
         "--setting", "taskpattern-evaluation", "--instance-id", instance_id,
         "--base-commit", "a" * 40, "--repository", "owner/repo",
         "-d", "fixture/dataset", "-o", str(d["root"] / "eval-runs")],
        text=True, encoding="utf-8", capture_output=True, env=eval_env,
    )
    assert evaluated.returncode == 0, evaluated.stderr
    eval_invocation = json.loads(evaluated.stdout)
    assert eval_invocation["retrieval_strategy"] is None
    assert eval_invocation["lingxi_model"] == "deepseek/deepseek-v4-flash"
    assert eval_invocation["lingxi_key_present"] is True
    assert "instance_id=" + instance_id in eval_invocation["argv"]
    assert "base_commit=" + "a" * 40 in eval_invocation["argv"]
    assert "evaluation_preparation=" + str(prep_record.resolve()) in eval_invocation["argv"]
    assert "evaluation_repository=owner/repo" in eval_invocation["argv"]
    prep_args = json.loads(prep_invocation.read_text(encoding="utf-8"))
    assert prep_args[-5:] == [
        "--retrieval-strategy", "evaluation", "--prepare-evaluation",
        "--evaluation-repository", "owner/repo",
    ]
    assert "preparing the exhaustive closed-issue catalog" in evaluated.stderr
    assert "preparation completed; starting measured task" in evaluated.stderr
    assert {str(p.relative_to(store)): digest(p) for p in store.rglob("*") if p.is_file()} == before
    preview = core("remove", "swe-pro-kit", {"home": d["request"]["home"], "dry_run": True})
    core("remove", "swe-pro-kit", {"home": d["request"]["home"], "confirmed": True, "expected_state_digest": preview["state_digest"]})
    for relative, contents in d["original"].items():
        assert (d["target"] / relative).read_bytes() == contents
    assert not (d["target"] / "src/chrys/orchestration/swe_pro_baseline.py").exists()
    assert not (d["config"] / "agents/SWEProDecoder.yaml").exists()
    assert store.exists()


@pytest.mark.parametrize("relative", ["agents/SWEProDecoder.yaml", "swe-pro-kit/run.py"])
def test_unowned_activation_blocks_preview_without_changes(deployment, relative):
    d = deployment
    file = write(d["config"], relative, "user content")
    answer = core("prepare", d["delivery"], d["request"], check=False)
    assert answer["status"] == "error"
    assert "拒绝覆盖" in answer["message"]
    assert file.read_text(encoding="utf-8") == "user content"
    assert not Path(d["request"]["home"]).exists()


def test_owned_activation_drift_blocks_update_and_remove(deployment):
    d = deployment
    core("install", d["delivery"], d["request"])
    file = d["config"] / "swe-pro-kit/run.py"
    file.write_text(file.read_text(encoding="utf-8") + "# user edit\n", encoding="utf-8")
    for action, subject, request in [("prepare", d["delivery"], d["request"]), ("remove", "swe-pro-kit", {"home": d["request"]["home"], "confirmed": True})]:
        answer = core(action, subject, request, check=False)
        assert "drift" in answer["message"]
    assert file.read_text(encoding="utf-8").endswith("# user edit\n")


def test_owned_previous_adapter_patch_migrates_and_remove_restores_original(deployment):
    d = deployment
    core("install", d["delivery"], d["request"])
    upgraded = upgraded_delivery(d)

    result = core("install", upgraded, d["request"])

    assert result["status"] == "ok"
    for relative in d["original"]:
        assert b"# runner injection v2" in (d["target"] / relative).read_bytes()
    preview = core("remove", "swe-pro-kit", {"home": d["request"]["home"], "dry_run": True})
    core("remove", "swe-pro-kit", {
        "home": d["request"]["home"], "confirmed": True,
        "expected_state_digest": preview["state_digest"],
    })
    for relative, contents in d["original"].items():
        assert (d["target"] / relative).read_bytes() == contents


def test_owned_previous_adapter_migrates_from_recorded_crlf_original(deployment):
    d = deployment
    core("install", d["delivery"], d["request"])
    state_path = Path(d["request"]["home"]) / "state/swe-pro-kit.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    active = next(item for item in state["deployments"] if item["status"] != "removed")
    expected_originals = {}
    for activation in active["activations"]:
        if activation["kind"] != "source_patch":
            continue
        original = activation["original"]
        contents = base64.b64decode(original["bytes"])
        crlf_contents = contents.replace(b"\n", b"\r\n")
        original["bytes"] = base64.b64encode(crlf_contents).decode()
        original["sha256"] = hashlib.sha256(crlf_contents).hexdigest()
        expected_originals[activation["path"]] = crlf_contents
    state_path.write_text(json.dumps(state), encoding="utf-8")
    upgraded = upgraded_delivery(d)

    result = core("install", upgraded, d["request"])

    assert result["status"] == "ok"
    for relative in d["original"]:
        assert b"# runner injection v2" in (d["target"] / relative).read_bytes()
    preview = core("remove", "swe-pro-kit", {"home": d["request"]["home"], "dry_run": True})
    core("remove", "swe-pro-kit", {
        "home": d["request"]["home"], "confirmed": True,
        "expected_state_digest": preview["state_digest"],
    })
    for path, contents in expected_originals.items():
        assert Path(path).read_bytes() == contents


def test_owned_previous_adapter_migration_rejects_user_drift(deployment):
    d = deployment
    core("install", d["delivery"], d["request"])
    upgraded = upgraded_delivery(d)
    relative = next(iter(d["original"]))
    path = d["target"] / relative
    path.write_bytes(path.read_bytes() + b"# user edit\n")

    answer = core("prepare", upgraded, d["request"], check=False)

    assert answer["status"] == "error"
    assert "drift" in answer["message"]
    assert path.read_bytes().endswith(b"# user edit\n")


def test_owned_previous_adapter_migration_rolls_back_on_verify_failure(deployment):
    d = deployment
    core("install", d["delivery"], d["request"])
    before = {relative: (d["target"] / relative).read_bytes() for relative in d["original"]}
    upgraded = upgraded_delivery(d, fail_verify=True)

    answer = core("install", upgraded, d["request"], check=False)

    assert "injected upgrade verification failure" in answer["message"]
    for relative, contents in before.items():
        assert (d["target"] / relative).read_bytes() == contents


def test_verify_failure_rolls_back_every_declared_target(deployment):
    d = deployment
    installer = d["delivery"] / "installer/installer.py"
    content = installer.read_text(encoding="utf-8").replace('if operation == "verify":\n', 'if operation == "verify":\n            raise InstallError("injected verification failure")\n')
    installer.write_text(content, encoding="utf-8")
    lock(d["delivery"])
    answer = core("install", d["delivery"], d["request"], check=False)
    assert "injected verification failure" in answer["message"]
    for relative, contents in d["original"].items():
        assert (d["target"] / relative).read_bytes() == contents
    assert not (d["target"] / "src/chrys/orchestration/swe_pro_baseline.py").exists()
    assert not (d["config"] / "swe-pro-kit/run.py").exists()
    assert not (Path(d["request"]["home"]) / "state/swe-pro-kit.json").exists()


def test_missing_harbor_in_bound_runtime_blocks_preview(deployment, monkeypatch):
    d = deployment
    shutil.rmtree(d["target"] / "src/harbor")
    monkeypatch.delenv("PYTHONPATH", raising=False)
    answer = core("prepare", d["delivery"], d["request"], check=False)
    assert "harbor" in answer["message"].lower()
    assert "uv pip install" in answer["message"] and "harbor==0.7.0" in answer["message"]
    assert not (Path(d["request"]["home"]) / "state/swe-pro-kit.json").exists()


def test_patch_cannot_mutate_an_undeclared_host_file(deployment):
    d = deployment
    patch = d["delivery"] / "adapters/chrys/icode-chrys-0.28/runner.patch"
    patch.write_text(patch.read_text(encoding="utf-8") + "--- a/unmanaged.py\n+++ b/unmanaged.py\n@@ -1 +1 @@\n-user\n+changed\n", encoding="utf-8")
    file = write(d["target"], "unmanaged.py", "user\n")
    lock(d["delivery"])
    answer = core("prepare", d["delivery"], d["request"], check=False)
    assert "补丁实际写入" in answer["message"]
    assert file.read_text(encoding="utf-8") == "user\n"
    assert not Path(d["request"]["home"]).exists()


def test_windows_crlf_checkout_passes_exact_adapter_preflight(deployment):
    d = deployment
    for relative in d["original"]:
        path = d["target"] / relative
        path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))
    prepared = core("prepare", d["delivery"], d["request"])
    assert prepared["compatibility_assessment"]["status"] == "unverified"
    assert not Path(d["request"]["home"]).exists()


def test_unmanaged_install_cannot_write_or_create_a_private_runtime(tmp_path):
    spec = importlib.util.spec_from_file_location("swe_managed_installer", SOURCE / "installer/installer.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    answer, code = module.run_operation("install", {"target": {"root": str(tmp_path / "chrys"), "config_root": str(tmp_path / "config")}})
    assert code == 2 and "request.managed" in answer["message"]
    assert not list(tmp_path.iterdir())


def test_retired_chrys_version_is_rejected_before_activation(deployment):
    d = deployment
    write(d["target"], "pyproject.toml", '[project]\nname="chrys"\nversion="0.20.1"\n')
    answer = core("prepare", d["delivery"], d["request"], check=False)
    assert "requires Chrys 0.28.0" in answer["message"]
    assert not Path(d["request"]["home"]).exists()
    assert not d["config"].exists()
