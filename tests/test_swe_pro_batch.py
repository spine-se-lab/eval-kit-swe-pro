"""Exercise the shipped batch launcher with a local Harbor process double."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


pytestmark = pytest.mark.skipif(
    os.name == "nt",
    reason="the shipped batch launcher requires a POSIX Bash environment",
)


ROOT = Path(__file__).parents[1]
SCRIPT = Path(os.environ.get("SWE_BATCH_SCRIPT", ROOT / "plugins/swe-pro-kit/source/scripts/run-batch.sh"))


@pytest.fixture
def batch(tmp_path):
    caller = tmp_path / "caller"
    host = tmp_path / "chrys host"
    store = tmp_path / "fixed package" / "assets" / "scripts"
    commands = tmp_path / "commands"
    for directory in (caller, host, store, commands):
        directory.mkdir(parents=True)
    (host / "pyproject.toml").write_text('[project]\nname="chrys"\nversion="0.28.0"\n')
    script = store / "run.sh"
    shutil.copyfile(SCRIPT, script)
    source = caller / "task list.tsv"
    source.write_text("FAIL\trepo/task-one\n")
    log = tmp_path / "calls.jsonl"
    uv = commands / "harbor"
    uv.write_text(f"#!{sys.executable}\n" + '''
import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as stream:
    stream.write(json.dumps({'argv': args, 'cwd': os.getcwd()}) + '\\n')
if os.environ.get('NO_RESULTS') == '1':
    sys.exit(0)
output = pathlib.Path(args[args.index('-o') + 1])
tasks = [args[i + 1] for i, value in enumerate(args) if value == '-i']
for i, task in enumerate(tasks):
    trial = output / 'job' / str(i)
    trial.mkdir(parents=True, exist_ok=True)
    (trial / 'result.json').write_text(json.dumps({'config': {'task': {'name': task}}}))
''')
    uv.chmod(0o755)
    script.chmod(0o444)
    store.chmod(0o555)
    environment = {
        **os.environ,
        "PATH": str(commands) + os.pathsep + os.environ["PATH"],
        "HOME": str(tmp_path / "home"),
        "CHRYS_DIR": str(host),
        "SOURCE": "task list.tsv",
        "RUN_DIR": "run files",
        "OUT_JOBS": "result files",
        "CONFIG_ROOT": "agent config",
        "HARBOR_BIN": str(uv),
        "SETTING": "three-decoder",
        "EXCLUDE": "",
        "BATCH": "20",
        "CONCURRENT": "2",
        "BINDINGS": "",
        "CALL_LOG": str(log),
    }

    def run(**overrides):
        return subprocess.run(["bash", str(script)], cwd=caller,
                              env={**environment, **overrides}, capture_output=True,
                              text=True, timeout=10)

    yield run, caller, host, store, source, log
    store.chmod(0o755)


def test_batch_separates_fixed_scripts_host_and_writable_outputs(batch):
    run, caller, host, store, source, log = batch
    before = hashlib.sha256((store / "run.sh").read_bytes()).hexdigest()
    completed = run()
    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert len(calls) == 1
    assert calls[0]["cwd"] == str(host)
    args = calls[0]["argv"]
    assert args[args.index("-o") + 1] == str(caller / "result files")
    assert "setting=three-decoder" in args
    assert "chrys.orchestration.swe_pro_baseline:ChrysAgent" in args
    assert f"config_root={caller / 'agent config'}" in args
    assert "No remaining tasks; all done." in completed.stdout
    assert list(store.iterdir()) == [store / "run.sh"]
    assert hashlib.sha256((store / "run.sh").read_bytes()).hexdigest() == before
    assert list((caller / "run files").iterdir()) == []


def test_batch_treats_task_and_setting_as_literal_arguments(batch):
    run, caller, host, store, source, log = batch
    task = "repo/quote' $(touch injected) ; task"
    source.write_text(f"FAIL\t{task}\n")
    completed = run(SETTING="Custom Setting; touch injected")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    args = json.loads(log.read_text().splitlines()[0])["argv"]
    assert args[args.index("-i") + 1] == task
    assert "setting=Custom Setting; touch injected" in args
    assert not (host / "injected").exists()


@pytest.mark.parametrize("overrides,diagnostic", [
    ({"SOURCE": ""}, "SOURCE must point"),
    ({"SETTING": ""}, "SETTING is required"),
    ({"BINDINGS": "missing.json"}, "BINDINGS must point"),
    ({"BATCH": "0"}, "positive integers"),
    ({"CONCURRENT": "-1"}, "positive integers"),
])
def test_batch_rejects_bad_inputs_before_harbor(batch, overrides, diagnostic):
    run, caller, host, store, source, log = batch
    completed = run(**overrides)
    assert completed.returncode == 2
    assert diagnostic in completed.stderr
    assert not log.exists()


def test_batch_stops_if_successful_harbor_produces_no_results(batch):
    run, caller, host, store, source, log = batch
    completed = run(NO_RESULTS="1")
    assert completed.returncode == 2
    assert "without new task results" in completed.stderr
    assert len(log.read_text().splitlines()) == 1


def test_batch_accepts_unlabelled_tasks_and_explicit_bindings(batch):
    run, caller, host, store, source, log = batch
    source.write_text("# fresh baseline task list\nrepo/first\n")
    bindings = caller / "roles.json"
    bindings.write_text('{}')
    completed = run(BINDINGS="roles.json")
    assert completed.returncode == 0, completed.stdout + completed.stderr
    args = json.loads(log.read_text().splitlines()[0])["argv"]
    assert args[args.index("-i") + 1] == "repo/first"
    assert f"bindings={bindings}" in args
