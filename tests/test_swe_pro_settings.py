"""Verify the baseline's public topology, binding, and execution contracts."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest
import yaml


SOURCE = Path(__file__).parents[1] / "plugins/swe-pro-kit/source"
ASSETS = SOURCE / "assets"
sys.path.insert(0, str(SOURCE / "package/src"))

from swe_pro_kit.core.configuration import (  # noqa: E402
    PRESET_NAMES,
    Bindings,
    Setting,
    expected_stage_roles,
    load_bindings,
    load_setting,
)
from swe_pro_kit.adapters.chrys.composition import build_orchestrator_profile, build_decoder_orchestrator_profile
from swe_pro_kit.core.contracts import Orchestration
from swe_pro_kit.core.execution import StageExecution, StageFailure, execute as execute_core  # noqa: E402


@asynccontextmanager
async def private_paths(count):
    yield [f"/private-decoder/{i}" for i in range(count)]

async def execute(setting, *args):
    return await execute_core(setting, *args, decoder_workspaces=private_paths(setting.decoder_count))


def preset(name):
    return load_setting(name, settings_dir=ASSETS / "settings")


def bindings():
    return load_bindings(ASSETS / "bindings.json")


def test_setting_is_explicit_and_canonical_file_is_loaded(tmp_path):
    with pytest.raises(ValueError, match="explicit"):
        load_setting(None)
    with pytest.raises(ValueError, match="settings_dir"):
        load_setting("single-decoder")
    custom = Setting("workflow", 2, "serial", True).to_dict()
    (tmp_path / "single-decoder.json").write_text(json.dumps(custom))
    assert load_setting("single-decoder", settings_dir=tmp_path).decoder_count == 2
    assert {path.stem for path in (ASSETS / "settings").glob("*.json")} == set(PRESET_NAMES)
    for name in PRESET_NAMES:
        assert load_setting(ASSETS / "settings" / f"{name}.json") == preset(name)


@pytest.mark.parametrize("change,match", [
    ({"decoder_count": 0}, "positive integer"),
    ({"decoder_count": True}, "positive integer"),
    ({"decoder_count": 1.5}, "positive integer"),
    ({"decoder_count": 3, "aggregate": False}, "Aggregator"),
    ({"decoder_execution": "automatic"}, "parallel.*serial"),
    ({"decoder_execution": []}, "parallel.*serial"),
    ({"executor": "legacy"}, "workflow.*sub-agent"),
    ({"executor": {}}, "workflow.*sub-agent"),
    ({"aggregate": "false"}, "boolean"),
    ({"knowledge": True}, "unknown knowledge"),
    ({"profile": "Example"}, "unknown profile"),
])
def test_invalid_or_mixed_settings_fail_before_execution(change, match):
    value = preset("single-decoder").to_dict() | change
    with pytest.raises(ValueError, match=match):
        load_setting(value)


def test_settings_and_bindings_reject_partial_or_legacy_files():
    with pytest.raises(ValueError, match="missing"):
        load_setting({"executor": "workflow"})
    with pytest.raises(ValueError, match="missing"):
        load_bindings({"decoder": "CustomDecoder"})
    with pytest.raises(ValueError, match="nonempty"):
        load_bindings(bindings().to_dict() | {"solver": " "})


def test_single_decoder_preserves_full_issue_and_stage_output():
    calls = []
    issue = "issue\n" + "boundary evidence; " * 3000
    results = {"decoder-0": "analysis\n" + "source evidence; " * 3000, "mapper": "complete plan", "solver": "verified repair"}

    async def runner(**call):
        calls.append(call)
        return StageExecution(results[call["role"]], {"input_tokens": 7, "output_tokens": 3})

    result = asyncio.run(execute(preset("single-decoder"), bindings(), runner, issue, "/testbed"))
    assert [call["role"] for call in calls] == ["decoder-0", "mapper", "solver"]
    assert [stage.role for stage in result.stages] == [call["role"] for call in calls]
    assert all(issue in call["instruction"] for call in calls)
    assert [call["workdir"] for call in calls] == ["/private-decoder/0", "/testbed", "/testbed"]
    assert results["decoder-0"] in calls[1]["instruction"]
    assert results["decoder-0"] not in calls[2]["instruction"]
    assert results["mapper"] in calls[2]["instruction"]
    assert result.final_output == results["solver"]
    assert result.stages[-1].usage == {"input_tokens": 7, "output_tokens": 3}


def test_parallel_decoders_overlap_and_aggregator_receives_every_result_in_index_order():
    async def scenario():
        all_started = asyncio.Event()
        started, completed, calls = [], [], []

        async def runner(**call):
            role = call["role"]
            calls.append(call)
            if role.startswith("decoder-"):
                started.append(role)
                if len(started) == 3:
                    all_started.set()
                await asyncio.wait_for(all_started.wait(), 1)
                completed.append(role)
                return f"<issue_analysis>result for {role}</issue_analysis>"
            assert len(completed) == 3
            return f"<issue_analysis>result for {role}</issue_analysis>"

        result = await execute(preset("three-decoder"), bindings(), runner, "original issue", "/app")
        assert [stage.role for stage in result.stages] == list(expected_stage_roles(preset("three-decoder")))
        aggregate = next(call for call in calls if call["role"] == "aggregator")
        positions = [aggregate["instruction"].index(f"result for decoder-{index}") for index in range(3)]
        assert positions == sorted(positions)
        assert "result for aggregator" in next(call for call in calls if call["role"] == "mapper")["instruction"]
        assert all("result for decoder-" not in call["instruction"] for call in calls[:3])

    asyncio.run(scenario())


def test_serial_decoders_complete_before_the_next_starts():
    transitions = []

    async def runner(**call):
        role = call["role"]
        transitions.append(f"start:{role}")
        await asyncio.sleep(0)
        transitions.append(f"end:{role}")
        return f"<issue_analysis>{role}</issue_analysis>"

    setting = preset("three-decoder-serial")
    asyncio.run(execute(setting, bindings(), runner, "issue", "/app"))
    assert transitions == [f"{action}:{role}" for role in expected_stage_roles(setting) for action in ("start", "end")]


def test_replacing_atomic_profiles_keeps_the_setting_and_prompts_identical():
    setting = preset("three-decoder")
    observed = []

    async def runner(**call):
        observed.append(call)
        return f"<issue_analysis>{call['role']}</issue_analysis>"

    asyncio.run(execute(setting, bindings(), runner, "same issue", "/app"))
    original = observed[:]
    observed.clear()
    replacement = Bindings("OtherDecoder", "OtherAggregator", "OtherMapper", "OtherSolver")
    asyncio.run(execute(setting, replacement, runner, "same issue", "/app"))
    assert setting == preset("three-decoder")
    assert [call["instruction"] for call in observed] == [call["instruction"] for call in original]
    assert [call["role"] for call in observed] == [call["role"] for call in original]
    assert [call["profile"] for call in observed] == ["OtherDecoder"] * 3 + ["OtherAggregator", "OtherMapper", "OtherSolver"]



@pytest.mark.parametrize("mode", ["parallel", "serial"])
@pytest.mark.parametrize("valid_count", [0, 1, 2])
def test_partial_decoder_failures_follow_historical_selection(mode, valid_count):
    calls = []
    async def runner(**call):
        calls.append(call)
        if call["role"].startswith("decoder-"):
            i = int(call["role"][-1])
            if i == 2:
                raise RuntimeError("sample failure")
            return f"<issue_analysis>{i}</issue_analysis>" if i < valid_count else f"invalid sample {i}"
        return call["role"]
    result = asyncio.run(execute(Setting("legacy-workflow", 3, mode, True), bindings(), runner, "issue", "/app"))
    roles = [call["role"] for call in calls]
    assert ("aggregator" in roles) == (valid_count >= 2)
    assert roles[-2:] == ["mapper", "solver"]
    mapper = calls[-2]["instruction"]
    if valid_count == 0:
        assert "invalid sample 0\n\ninvalid sample 1" in mapper
    elif valid_count == 1:
        assert "<issue_analysis>0</issue_analysis>" in mapper and "invalid sample 1" not in mapper
    assert result.final_output == "solver"

@pytest.mark.parametrize("role", ["aggregator", "mapper", "solver"])
def test_non_decoder_exception_propagates_and_stops_dependents(role):
    calls = []
    async def runner(**call):
        calls.append(call["role"])
        if call["role"] == role:
            raise RuntimeError("fixture failure")
        return "<issue_analysis>analysis</issue_analysis>"
    with pytest.raises(StageFailure, match=f"{role} execution failed"):
        asyncio.run(execute(preset("three-decoder"), bindings(), runner, "issue", "/app"))
    assert calls[-1] == role

@pytest.mark.parametrize("name,concurrency", [("sub-agent", 3), ("sub-agent-serial", 1)])
def test_sub_agent_setting_preserves_nested_roles_and_exact_bindings(name, concurrency):
    setting = preset(name)
    selected = replace(bindings(), decoder="ReplacementDecoder")
    root = build_orchestrator_profile(setting, selected)
    children = root["sub_agents"]["agents"]
    assert root["tools"]["builtins"] == ["filesystem.read", "search", "shell"]
    assert root["sub_agents"]["max_total_concurrency"] == 1
    assert [child["tool_name"] for child in children] == ["problem_decoder", "solution_mapper", "problem_solver"]
    assert children[0]["profile"] == "SWEProDecoderOrchestrator"
    ensemble = build_decoder_orchestrator_profile(setting, selected)
    assert ensemble["sub_agents"]["max_total_concurrency"] == concurrency
    assert "sub_agents" not in ensemble["tools"]
    assert [child["profile"] for child in ensemble["sub_agents"]["agents"]] == ["ReplacementDecoder"] * 3 + [selected.aggregator]
    assert "waiting for each result" in ensemble["instructions"] if concurrency == 1 else "3 parallel tool calls" in ensemble["instructions"]

    calls = []

    async def runner(**call):
        calls.append(call)
        return StageExecution("root final output", {"input_tokens": 1})

    result = asyncio.run(execute(setting, selected, runner, "complete issue", "/app"))
    assert len(calls) == 1 and calls[0]["role"] == "orchestrator"
    assert calls[0]["profile"] == Orchestration(setting, selected)
    assert "complete issue" in calls[0]["instruction"]
    assert result.final_output == "root final output"


def test_single_decoder_sub_agent_uses_same_atomic_roles_without_aggregator():
    setting = Setting("sub-agent", 1, "serial", False)
    root = build_orchestrator_profile(setting, bindings())
    assert [child["tool_name"] for child in root["sub_agents"]["agents"]] == ["problem_decoder", "solution_mapper", "problem_solver"]


def test_baseline_profiles_have_no_augmentation_or_embedded_orchestration():
    paths = sorted((ASSETS / "profiles").glob("*.yaml"))
    assert {path.stem for path in paths} == set(bindings().to_dict().values())
    for path in paths:
        text = path.read_text()
        profile = yaml.safe_load(text)
        assert profile["name"] == path.stem
        assert not profile.get("sub_agents")
        assert not profile.get("skills")
        assert not profile["tools"].get("custom")
        assert not profile["tools"].get("mcp")
        assert "knowledge" not in text.lower()


@pytest.mark.parametrize('mode', ['parallel', 'serial'])
@pytest.mark.parametrize('failure', ['exception', 'empty', 'host-status'])
@pytest.mark.parametrize('role', ['decoder-0', 'aggregator', 'mapper', 'solver'])
def test_clean_workflow_stops_on_failure_without_implicit_degradation(mode, failure, role):
    calls = []
    async def runner(**call):
        calls.append(call['role'])
        if call['role'] == role:
            if failure == 'exception':
                raise RuntimeError('provider failure')
            if failure == 'empty':
                return '  \n'
            return StageExecution('partial output', failed=True)
        return '<issue_analysis>full output</issue_analysis>'
    with pytest.raises(StageFailure) as caught:
        asyncio.run(execute(Setting('workflow', 3, mode, True), bindings(), runner, 'issue', '/app'))
    assert caught.value.role == role
    forbidden = {'decoder-0': ['aggregator', 'mapper', 'solver'],
                 'aggregator': ['mapper', 'solver'], 'mapper': ['solver'], 'solver': []}[role]
    assert not set(calls) & set(forbidden)
    if mode == 'serial' and role == 'decoder-0':
        assert calls == ['decoder-0']


def test_clean_parallel_failure_joins_decoders_before_workspace_cleanup():
    async def scenario():
        started, finished = [], []
        ready = asyncio.Event()
        @asynccontextmanager
        async def workspaces():
            try:
                yield ['/decoder/0', '/decoder/1', '/decoder/2']
            finally:
                assert sorted(finished) == ['decoder-0', 'decoder-1', 'decoder-2']
        async def runner(**call):
            role = call['role']
            started.append(role)
            if len(started) == 3:
                ready.set()
            try:
                await ready.wait()
                if role == 'decoder-1':
                    raise RuntimeError('sample failed')
                await asyncio.Future()
            finally:
                finished.append(role)
        with pytest.raises(StageFailure, match='decoder-1'):
            await asyncio.wait_for(execute_core(preset('three-decoder'), bindings(), runner, 'issue', '/app',
                                               decoder_workspaces=workspaces()), 2)
    asyncio.run(scenario())


@pytest.mark.parametrize('aggregate', [False, True])
def test_clean_aggregation_is_controlled_by_setting_even_with_one_sample(aggregate):
    calls = []
    async def runner(**call):
        calls.append(call)
        # Nonempty text is forwarded in full, never used to infer a smaller topology.
        return 'full stage output'
    setting = Setting('workflow', 1, 'serial', aggregate)
    asyncio.run(execute(setting, bindings(), runner, 'issue', '/app'))
    assert [call['role'] for call in calls] == list(expected_stage_roles(setting))


def test_clean_and_legacy_share_identical_successful_stage_inputs_and_profiles():
    observed = []
    async def runner(**call):
        observed.append(call)
        return f"<issue_analysis>{call['role']}</issue_analysis>"
    asyncio.run(execute(preset('three-decoder'), bindings(), runner, 'issue', '/app'))
    clean = observed[:]
    observed.clear()
    asyncio.run(execute(preset('legacy-workflow'), bindings(), runner, 'issue', '/app'))
    assert observed == clean
