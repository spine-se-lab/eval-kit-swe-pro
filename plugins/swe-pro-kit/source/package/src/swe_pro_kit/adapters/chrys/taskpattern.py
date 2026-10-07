"""Compose the evaluation profiles from installed Lingxi Advisor bindings."""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from ...core.taskpattern import (
    LINGXI_ADVISOR_SERVER,
    LINGXI_ADVISOR_SKILL,
    LINGXI_ADVISOR_TOOLS,
    TASKPATTERN_PROMPT_FRAGMENTS,
    TaskPatternEvaluation,
    inject_prompt_fragment,
)


ROLE_IDS = {
    "decoder": "7a51c0de0321",
    "mapper": "7a51c0de0322",
    "solver": "7a51c0de0323",
}


def bind_taskpattern(profile: Any, advisor: Any, *, advisor_profile: str) -> Any:
    """Copy any Chrys profile and attach only the Lingxi Advisor Runtime Skill/MCP."""
    if advisor.name != advisor_profile:
        raise ValueError("installed Lingxi Advisor profile identity mismatch")
    skills = [path for path in advisor.skills.paths if Path(path).name == LINGXI_ADVISOR_SKILL]
    if len(skills) != 1:
        raise ValueError("installed Lingxi Advisor must expose exactly one lingxi-advisor Skill path")
    servers = [server for server in advisor.tools.mcp if server.name == LINGXI_ADVISOR_SERVER]
    if len(servers) != 1:
        raise ValueError("installed Lingxi Advisor must expose exactly one lingxi-advisor MCP server")
    server = servers[0]
    if tuple(server.allowed_tools or ()) != LINGXI_ADVISOR_TOOLS:
        raise ValueError(
            "installed Lingxi Advisor MCP must expose lingxi.advisor.search and "
            "lingxi.advisor.apply only"
        )

    result = deepcopy(profile)
    result.skills.paths = skills
    result.skills.inline = []
    result.skills.auto_load_user_agents_skills = False
    result.skills.auto_load_cwd_agents_skills = False
    result.tools.mcp = [deepcopy(server)]
    result.tools.mcp[0].request_timeout = 120
    return result


def compose_atomic_profile(
    base: Any,
    advisor: Any,
    role: str,
    evaluation: TaskPatternEvaluation,
    *,
    taskpattern_context: str,
    evaluation_repository: str,
    evaluation_preparation: str,
) -> Any:
    """Copy one baseline role, bind Lingxi Advisor, and inject its stage fragment."""
    if role not in TASKPATTERN_PROMPT_FRAGMENTS:
        raise ValueError(f"unsupported TaskPattern role: {role}")
    result = bind_taskpattern(base, advisor, advisor_profile=evaluation.advisor_profile)
    result.tools.mcp[0].request_timeout = evaluation.raw["timeouts"]["taskpattern_request_seconds"]
    if not evaluation_repository.strip() or not evaluation_preparation.strip():
        raise ValueError("taskpattern-evaluation requires a prepared closed-issue snapshot")
    result.tools.mcp[0].args.extend([
        "--retrieval-strategy", "evaluation",
        "--evaluation-repository", evaluation_repository,
        "--evaluation-preparation", evaluation_preparation,
    ])
    expected_name = getattr(evaluation.bindings, role)
    result.name = expected_name
    result.id = ROLE_IDS[role]
    result.display_name = f"{base.display_name} + Lingxi Advisor"
    result.description = f"{base.description} Uses the installed Lingxi Advisor runtime during {role}."
    if role in {"decoder", "mapper"}:
        result.tools.builtins = [
            tool for tool in result.tools.builtins
            if tool in {"filesystem.read", "search"}
        ]
    result.instructions = inject_prompt_fragment(result.instructions, role)
    if not taskpattern_context.strip():
        raise ValueError("taskpattern-evaluation requires a public task context")
    context_marker = "<taskpattern_evaluation_context>"
    if context_marker not in result.instructions:
        result.instructions += (
            "\n" + context_marker + "\n"
            "The following public context was resolved by the evaluation adapter. "
            "Use its full issue_description and every non-null identity field verbatim "
            "in lingxi.advisor.search. Do not replace values with null and do not infer "
            "identity from the container path.\n"
            + taskpattern_context
            + "\nThis is a mandatory measured evaluation step. Do not skip Search "
            "because the coding task appears simple. If Search returns one or more "
            "knowledge_matches, call lingxi.advisor.apply with the unchanged full list, "
            "or its Search-approved artifact_ref if host output was truncated.\n"
            "</taskpattern_evaluation_context>\n"
        )
    result.model.profile_id = "swe-openrouter-flash"
    return result


def compose_orchestrator_profile(profile: dict[str, Any], evaluation: TaskPatternEvaluation) -> dict[str, Any]:
    """Give the fixed root profile an identity and preserve public context."""
    result = deepcopy(profile)
    result.update(
        name=evaluation.main_profile,
        id=evaluation.main_profile_id,
        display_name="SWE-Pro Lingxi Advisor Evaluation",
        description="Fixed main + Decoder/Mapper/Solver Lingxi Advisor evaluation setting",
    )
    marker = "<taskpattern_orchestrator_contract>"
    if marker not in result["instructions"]:
        result["instructions"] = result["instructions"].rstrip() + "\n\n" + (
            marker + "\nPass <taskpattern_context> unchanged to problem_decoder, "
            "solution_mapper, and problem_solver. Run them exactly once in that order. "
            "Do not add private paths, hidden tests, verifier data, target patches, "
            "reference solutions, credentials, or unrelated Harbor configuration to "
            "Lingxi Advisor calls.\n</taskpattern_orchestrator_contract>\n"
        )
    result["model"] = {"profile_id": "swe-openrouter-flash"}
    return result
