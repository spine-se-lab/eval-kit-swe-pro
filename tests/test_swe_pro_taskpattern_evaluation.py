"""Focused contracts for the opt-in TaskPattern evaluation setting."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest


SOURCE = Path(__file__).parents[1] / "plugins/swe-pro-kit/source"
ASSETS = SOURCE / "assets"
sys.path.insert(0, str(SOURCE / "package/src"))

from swe_pro_kit.adapters.chrys.engine import (  # noqa: E402
    taskpattern_continuation_prompt,
    validate_taskpattern_invocations,
)
from swe_pro_kit.adapters.chrys.taskpattern import bind_taskpattern, compose_atomic_profile  # noqa: E402
from swe_pro_kit.core.taskpattern import (  # noqa: E402
    TASKPATTERN_PROMPT_FRAGMENTS,
    load_taskpattern_evaluation,
    public_task_context,
    repository_from_remote,
    render_task_context,
)


def _base(role: str):
    return SimpleNamespace(
        name=f"SWEPro{role.title()}",
        id=f"base-{role}",
        display_name=role.title(),
        description=f"Baseline {role}",
        instructions=f"Baseline {role} instructions.",
        skills=SimpleNamespace(
            paths=[], inline=[], auto_load_user_agents_skills=True, auto_load_cwd_agents_skills=True,
        ),
        tools=SimpleNamespace(mcp=[], builtins=["filesystem.read", "search", "shell"]),
        model=SimpleNamespace(profile_id=""),
    )


def _advisor():
    server = SimpleNamespace(
        name="lingxi-advisor", command="managed-python", args=["managed-launcher"],
        allowed_tools=["lingxi.advisor.search", "lingxi.advisor.apply"], enabled=True,
    )
    return SimpleNamespace(
        name="LingxiAdvisor",
        skills=SimpleNamespace(paths=["/managed/skills/lingxi-advisor", "/managed/skills/knowledge-preparation-operator"]),
        tools=SimpleNamespace(mcp=[server, SimpleNamespace(name="lingxi-advisor-operator")]),
    )


def test_fixed_setting_runs_three_serial_roles_deterministically_and_pins_model():
    evaluation = load_taskpattern_evaluation(ASSETS)
    assert evaluation.setting.to_dict() == {
        "executor": "workflow", "decoder_count": 1, "decoder_execution": "serial", "aggregate": False,
    }
    assert evaluation.bindings.to_dict() == {
        "decoder": "SWEProTaskPatternDecoder", "aggregator": "SWEProAggregator",
        "mapper": "SWEProTaskPatternMapper", "solver": "SWEProTaskPatternSolver",
    }
    assert evaluation.raw["topology"] == {
        "driver": "deterministic_host_workflow",
        "order": ["decoder", "mapper", "solver"],
        "max_total_concurrency": 1,
        "decoder_count": 1,
        "aggregator_enabled": False,
    }


@pytest.mark.parametrize("role", ["decoder", "mapper", "solver"])
def test_atomic_profiles_copy_baseline_and_reuse_one_installed_skill_and_runtime_server(role):
    evaluation = load_taskpattern_evaluation(ASSETS)
    baseline = _base(role)
    advisor = _advisor()
    context = render_task_context({
        "issue_description": "Public issue", "repo": "owner/repo", "issue_number": 17,
    })
    composed = compose_atomic_profile(
        baseline, advisor, role, evaluation, taskpattern_context=context,
        evaluation_repository="owner/repo",
        evaluation_preparation="/taskpattern/preparations/record.json",
    )

    assert baseline.skills.paths == [] and baseline.tools.mcp == []
    assert composed.name == getattr(evaluation.bindings, role)
    assert composed.skills.paths == ["/managed/skills/lingxi-advisor"]
    assert [server.name for server in composed.tools.mcp] == ["lingxi-advisor"]
    assert composed.tools.mcp[0].allowed_tools == ["lingxi.advisor.search", "lingxi.advisor.apply"]
    assert composed.tools.mcp[0].request_timeout == 1000
    assert composed.tools.mcp[0].args[-6:] == [
        "--retrieval-strategy", "evaluation",
        "--evaluation-repository", "owner/repo",
        "--evaluation-preparation", "/taskpattern/preparations/record.json",
    ]
    assert composed.model.profile_id == "swe-openrouter-flash"
    if role in {"decoder", "mapper"}:
        assert composed.tools.builtins == ["filesystem.read", "search"]
    else:
        assert composed.tools.builtins == baseline.tools.builtins
    marker = TASKPATTERN_PROMPT_FRAGMENTS[role].splitlines()[0]
    assert composed.instructions.count(marker) == 1
    assert composed.instructions.count("<taskpattern_evaluation_context>") == 1
    assert '"repo": "owner/repo"' in composed.instructions
    assert '"issue_number": 17' in composed.instructions
    recomposed = compose_atomic_profile(
        deepcopy(composed), advisor, role, evaluation, taskpattern_context=context,
        evaluation_repository="owner/repo",
        evaluation_preparation="/taskpattern/preparations/record.json",
    )
    assert recomposed.instructions.count(marker) == 1
    assert recomposed.instructions.count("<taskpattern_evaluation_context>") == 1
    if role == "mapper":
        assert "overrides the baseline request" in composed.instructions
        assert "never call run_skill_script" in composed.instructions


def test_skill_and_mcp_binding_is_reusable_without_three_agent_orchestration():
    profile = _base("general")
    bound = bind_taskpattern(profile, _advisor(), advisor_profile="LingxiAdvisor")
    assert bound.name == profile.name and bound.instructions == profile.instructions
    assert bound.skills.paths == ["/managed/skills/lingxi-advisor"]
    assert [item.name for item in bound.tools.mcp] == ["lingxi-advisor"]


def test_measured_evaluation_requires_one_successful_search_and_apply_per_role():
    events = []
    for action in ("search", "apply"):
        result = {"status": "completed"}
        if action == "search":
            result["knowledge_matches"] = [{"knowledge_id": "known-fix"}]
        events.extend([
            {"event": "start", "tool": f"lingxi-advisor-{action}", "id": action},
            {"event": "finish", "tool": f"lingxi-advisor-{action}", "id": action,
             "metadata": {}, "result": json.dumps(result)},
        ])
    assert validate_taskpattern_invocations("decoder-0", events) is True
    with pytest.raises(ValueError, match="exactly 1 apply"):
        validate_taskpattern_invocations("mapper", events[:2])
    failed = deepcopy(events)
    failed[-1]["metadata"] = {"failed": True}
    with pytest.raises(ValueError, match="apply invocation failed"):
        validate_taskpattern_invocations("solver", failed)
    unusable = deepcopy(events)
    unusable[-1]["result"] = json.dumps({"status": "failed"})
    with pytest.raises(ValueError, match="unusable status 'failed'"):
        validate_taskpattern_invocations("solver", unusable)


@pytest.mark.parametrize("status", ["completed", "partial", "no_candidates"])
def test_measured_evaluation_accepts_search_without_matches_and_requires_no_apply(status):
    events = [
        {"event": "start", "tool": "lingxi-advisor-search", "id": "search"},
        {"event": "finish", "tool": "lingxi-advisor-search", "id": "search",
         "metadata": {}, "result": {"status": status, "knowledge_matches": []}},
    ]
    assert validate_taskpattern_invocations("mapper", events) is False

    unexpected_apply = events + [
        {"event": "start", "tool": "lingxi-advisor-apply", "id": "apply"},
        {"event": "finish", "tool": "lingxi-advisor-apply", "id": "apply",
         "metadata": {}, "result": {"status": "completed"}},
    ]
    with pytest.raises(ValueError, match="exactly 0 apply"):
        validate_taskpattern_invocations("mapper", unexpected_apply)


def test_measured_evaluation_loads_chrys_spooled_result_before_strict_validation(tmp_path):
    stage_dir = tmp_path / "decoder-0"
    result_dir = stage_dir / "session" / "abc" / "tool_results"
    result_dir.mkdir(parents=True)
    result_path = result_dir / "mcp_search.txt"
    result_path.write_text(json.dumps({
        "status": "completed", "knowledge_matches": [{"knowledge_id": "known-fix"}],
    }), encoding="utf-8")
    truncated = (
        '{\n  "status": "completed",\n[...truncated]\n'
        f"[Full output saved to: {result_path}\n2 lines]\n"
    )
    events = []
    for action in ("search", "apply"):
        events.extend([
            {"event": "start", "tool": f"lingxi-advisor-{action}", "id": action},
            {"event": "finish", "tool": f"lingxi-advisor-{action}", "id": action,
             "metadata": {}, "result": truncated if action == "search" else {"status": "completed"}},
        ])
    validate_taskpattern_invocations("decoder-0", events, stage_dir)


def test_measured_evaluation_does_not_load_spooled_results_outside_stage_session(tmp_path):
    stage_dir = tmp_path / "decoder-0"
    (stage_dir / "session").mkdir(parents=True)
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"status": "completed"}), encoding="utf-8")
    invalid = f"[Full output saved to: {outside}\n1 line]\n"
    events = [
        {"event": "start", "tool": "lingxi-advisor-search", "id": "search"},
        {"event": "finish", "tool": "lingxi-advisor-search", "id": "search",
         "metadata": {}, "result": invalid},
        {"event": "start", "tool": "lingxi-advisor-apply", "id": "apply"},
        {"event": "finish", "tool": "lingxi-advisor-apply", "id": "apply",
         "metadata": {}, "result": {"status": "completed"}},
    ]
    with pytest.raises(ValueError, match="search returned invalid JSON"):
        validate_taskpattern_invocations("decoder-0", events, stage_dir)


def test_empty_advisor_turn_continuation_does_not_repeat_taskpattern_calls():
    prompt = taskpattern_continuation_prompt("mapper", applied=True)
    assert "already completed successfully" in prompt
    assert "Do not call either Lingxi Advisor tool again" in prompt
    assert "complete the mapper work" in prompt
    assert "non-empty final response" in prompt
    no_match = taskpattern_continuation_prompt("mapper", applied=False)
    assert "found no historical matches" in no_match


def test_public_context_maps_only_allowlisted_task_identity_and_never_paths_or_secrets():
    instance = "instance_owner__repo-" + "A" * 40 + "-v1"
    value = public_task_context("Public issue", instance_id=instance)
    assert value == {
        "issue_description": "Public issue", "repo": "owner/repo", "instance_id": instance,
        "base_commit": "a" * 40,
    }
    rendered = render_task_context(value)
    for forbidden in ("gold", "hidden", "verifier", "credential", "worktree", "harbor"):
        assert forbidden not in rendered.lower()
    with pytest.raises(ValueError, match="does not match"):
        public_task_context("issue", instance_id=instance, repo="other/repo")
    with pytest.raises(ValueError, match="not a path"):
        public_task_context("issue", repo="/private/worktree")


def test_local_harbor_task_name_is_not_misrepresented_as_target_issue_identity():
    value = public_task_context(
        "Public issue", instance_id="local-smoke-task", repo="owner/repo", issue_number=17,
    )
    assert value == {
        "issue_description": "Public issue", "repo": "owner/repo", "issue_number": 17,
    }
    new_issue = public_task_context(
        "Unfiled issue", instance_id="local-smoke-task", repo="owner/repo",
    )
    assert new_issue == {"issue_description": "Unfiled issue", "repo": "owner/repo"}


@pytest.mark.parametrize("remote", [
    "https://github.com/owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
])
def test_repository_can_be_inferred_only_from_public_github_remotes(remote):
    assert repository_from_remote(remote) == "owner/repo"
    assert repository_from_remote("/private/worktree") == ""


def test_evaluation_assets_do_not_embed_or_depend_on_legacy_combined_runtime():
    paths = [
        ASSETS / "evaluations/taskpattern-evaluation.json",
        ASSETS / "settings/taskpattern-evaluation.json",
        ASSETS / "taskpattern-bindings.json",
        SOURCE / "package/src/swe_pro_kit/core/taskpattern.py",
        SOURCE / "package/src/swe_pro_kit/adapters/chrys/taskpattern.py",
    ]
    text = "\n".join(path.read_text(encoding="utf-8") for path in paths).lower()
    assert "swe-pro-kit-with-taskpattern" not in text
    assert "taskpattern 0.7" not in text
    assert "capability_export" not in text
    assert "venv" not in text
    assert "runtime/taskpattern" not in text
    descriptor = json.loads(paths[0].read_text(encoding="utf-8"))
    assert descriptor["task_context_allowlist"] == [
        "repo", "issue_description", "instance_id", "base_commit", "issue_number",
    ]
    assert descriptor["issue_policy"] == {
        "owner": "lingxi-advisor-runtime",
        "inputs": ["instance_id", "issue_number"],
        "issue_mode": "derived_not_user_configurable",
        "target_leakage_check": "existing=true,new=false",
    }
    assert descriptor["preparation"] == {
        "mode": "required_before_task",
        "scope": "repository_closed_issue_catalog",
        "record": "<lingxi-advisor-data>/outputs/evaluation_preparations/*.json",
        "missing_or_invalid": "stop_before_task",
    }
    assert descriptor["taskpattern_binding"] == {
        "profile": "LingxiAdvisor",
        "skill": "lingxi-advisor",
        "mcp_server": "lingxi-advisor",
        "allowed_tools": ["lingxi.advisor.search", "lingxi.advisor.apply"],
    }
    assert all("Do not pass issue_mode or leakage_check" in fragment.replace("\n", " ")
               for fragment in TASKPATTERN_PROMPT_FRAGMENTS.values())
