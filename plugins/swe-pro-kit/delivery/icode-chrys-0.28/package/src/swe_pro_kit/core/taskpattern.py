"""Fixed Lingxi Advisor evaluation contract, independent of any agent host."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .configuration import Bindings, Setting, load_bindings, load_setting


EVALUATION_PRESET = "taskpattern-evaluation"
LINGXI_ADVISOR_PROFILE = "LingxiAdvisor"
LINGXI_ADVISOR_SKILL = "lingxi-advisor"
LINGXI_ADVISOR_SERVER = "lingxi-advisor"
LINGXI_ADVISOR_TOOLS = ("lingxi.advisor.search", "lingxi.advisor.apply")

_INSTANCE_RE = re.compile(
    r"^instance_(?P<owner>[^/]+?)__(?P<repo>.+)-(?P<base>[0-9a-fA-F]{40})(?:-v.*)?$"
)
_SHA_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


TASKPATTERN_PROMPT_FRAGMENTS = {
    "decoder": """<taskpattern_analysis_prompt>
This evaluation stage MUST use the installed Lingxi Advisor Skill during analysis.
Before using any repository tool, call lingxi.advisor.search exactly once with
the full public issue description and only the non-null public identity fields in
<taskpattern_context>. If Search returns knowledge_matches, call lingxi.advisor.apply
exactly once before finishing the analysis. Preserve the returned artifact_ref;
if the host truncates a large result, Apply can restore that Search-approved
match from the ref. Do not pass issue_mode
or leakage_check; Lingxi Advisor resolves the target and leakage policy itself.

Use the result to identify potentially relevant modules, files, symbols,
behaviors, and failure patterns. Retain only evidence directly relevant to the
current issue, and verify every historical claim against the current repository
and worktree. Lingxi Advisor is advisory; the current code is authoritative.
This role is read-only: do not create, edit, or delete repository files.
</taskpattern_analysis_prompt>""",
    "mapper": """<taskpattern_planning_prompt>
This evaluation stage MUST use the installed Lingxi Advisor Skill during planning.
Before using any repository tool, call lingxi.advisor.search exactly once with
the full public issue description and only the non-null public identity fields in
<taskpattern_context>; when Search returns knowledge_matches, pass them unchanged
to exactly one lingxi.advisor.apply call. If host output truncation removes XML,
pass the Search-approved artifact_ref rather than reconstructing content. Do not
pass issue_mode or leakage_check; Lingxi Advisor owns
target resolution and the mandatory leakage policy.

Map applicable knowledge to the current repository's change locations,
dependencies, risks, and test plan. Explicitly distinguish historical evidence
from conclusions verified in current code. Historical patches are references
only and must never be copied without current-repository verification.
This role is read-only: produce a plan, but do not create, edit, or delete files.
For this fixed evaluation, that read-only rule overrides the baseline request to
create or run reproduction.py. Inspect existing files/tests and describe the
reproduction and verification steps in the plan instead. The Lingxi Advisor Skill
has no executable workflow script; never call run_skill_script.
</taskpattern_planning_prompt>""",
    "solver": """<taskpattern_implementation_prompt>
This evaluation stage MUST use the installed Lingxi Advisor Skill before implementation.
Before using any repository tool, call lingxi.advisor.search exactly once with the full public issue description and only the non-null
public identity fields in <taskpattern_context>; when Search returns
knowledge_matches, pass them unchanged to exactly one lingxi.advisor.apply call. Do not pass
issue_mode or leakage_check; Lingxi Advisor derives both behaviors internally. If
the host truncates XML, preserve and pass the Search-approved artifact_ref.

Validate suggested files, symbols, and edits against the current code version,
then implement, test, and run regression checks. If historical knowledge
conflicts with the repository or test results, follow the current repository and
tests. Lingxi Advisor is advisory and never overrides current evidence.
</taskpattern_implementation_prompt>""",
}


@dataclass(frozen=True)
class TaskPatternEvaluation:
    name: str
    main_profile: str
    main_profile_id: str
    advisor_profile: str
    model_profile: str
    setting: Setting
    bindings: Bindings
    source: Path
    raw: Mapping[str, Any]


def load_taskpattern_evaluation(assets: str | Path) -> TaskPatternEvaluation:
    """Load and validate the one supported Lingxi Advisor evaluation setting."""
    root = Path(assets)
    source = root / "evaluations" / f"{EVALUATION_PRESET}.json"
    value = json.loads(source.read_text(encoding="utf-8"))
    if value.get("schema") != "swe-pro-kit.taskpattern_evaluation/v1":
        raise ValueError("TaskPattern evaluation schema mismatch")
    if value.get("name") != EVALUATION_PRESET:
        raise ValueError("TaskPattern evaluation name mismatch")
    provider = value.get("taskpattern_binding") or {}
    if provider != {
        "profile": LINGXI_ADVISOR_PROFILE,
        "skill": LINGXI_ADVISOR_SKILL,
        "mcp_server": LINGXI_ADVISOR_SERVER,
        "allowed_tools": list(LINGXI_ADVISOR_TOOLS),
    }:
        raise ValueError("TaskPattern Skill/MCP binding is not the fixed runtime contract")
    if value.get("issue_policy") != {
        "owner": "lingxi-advisor-runtime",
        "inputs": ["instance_id", "issue_number"],
        "issue_mode": "derived_not_user_configurable",
        "target_leakage_check": "existing=true,new=false",
    }:
        raise ValueError("TaskPattern issue/leakage policy ownership drifted")
    setting = load_setting(root / "settings" / f"{EVALUATION_PRESET}.json")
    bindings = load_bindings(root / "taskpattern-bindings.json")
    if setting != Setting("workflow", 1, "serial", False):
        raise ValueError("TaskPattern evaluation topology must deterministically run Decoder/Mapper/Solver")
    expected = {
        "decoder": "SWEProTaskPatternDecoder",
        "aggregator": "SWEProAggregator",
        "mapper": "SWEProTaskPatternMapper",
        "solver": "SWEProTaskPatternSolver",
    }
    if bindings.to_dict() != expected:
        raise ValueError("TaskPattern evaluation role bindings drifted")
    model = value.get("model") or {}
    model_profile = str(model.get("profile") or "")
    if model_profile != "models/swe-openrouter-flash.yaml":
        raise ValueError("TaskPattern evaluation model profile drifted")
    return TaskPatternEvaluation(
        name=value["name"],
        main_profile=value["main_profile"]["name"],
        main_profile_id=value["main_profile"]["id"],
        advisor_profile=provider["profile"],
        model_profile=model_profile,
        setting=setting,
        bindings=bindings,
        source=source,
        raw=value,
    )


def inject_prompt_fragment(instructions: str, role: str) -> str:
    """Append a shared stage fragment once, even under repeated composition."""
    try:
        fragment = TASKPATTERN_PROMPT_FRAGMENTS[role]
    except KeyError as exc:
        raise ValueError(f"TaskPattern has no prompt fragment for role {role!r}") from exc
    marker = fragment.splitlines()[0]
    if marker in instructions:
        return instructions
    return instructions.rstrip() + "\n\n" + fragment + "\n"


def public_task_context(
    issue_description: str,
    *,
    instance_id: str = "",
    repo: str = "",
    base_commit: str = "",
    issue_number: int | str | None = None,
) -> dict[str, Any]:
    """Return only TaskPattern's allow-listed public SWE task identity."""
    if not isinstance(issue_description, str) or not issue_description.strip():
        raise ValueError("issue_description must be nonempty")
    instance_id = instance_id.strip()
    match = _INSTANCE_RE.fullmatch(instance_id)
    if match:
        inferred_repo = f"{match.group('owner')}/{match.group('repo')}"
        inferred_base = match.group("base").lower()
        if repo and repo != inferred_repo:
            raise ValueError("repo does not match the SWE task instance identity")
        if base_commit and base_commit.lower() != inferred_base:
            raise ValueError("base_commit does not match the SWE task instance identity")
        repo, base_commit = inferred_repo, inferred_base
    repo, base_commit = repo.strip(), base_commit.strip().lower()
    if repo and not _REPO_RE.fullmatch(repo):
        raise ValueError("repo must be a public owner/repository identity, not a path")
    if base_commit and not _SHA_RE.fullmatch(base_commit):
        raise ValueError("base_commit must be a 40-character Git SHA")
    if issue_number not in (None, ""):
        if isinstance(issue_number, bool):
            raise ValueError("issue_number must be a positive integer")
        try:
            issue_number = int(issue_number)
        except (TypeError, ValueError) as exc:
            raise ValueError("issue_number must be a positive integer") from exc
        if issue_number < 1:
            raise ValueError("issue_number must be a positive integer")
    else:
        issue_number = None
    context: dict[str, Any] = {"issue_description": issue_description}
    for key, value in (
        ("repo", repo),
        # A Harbor/local task label is an execution identifier, not proof that
        # the target is an existing issue. Only the recognized benchmark form
        # is a public target identity; regular GitHub issues use issue_number.
        ("instance_id", instance_id if match else ""),
        ("base_commit", base_commit),
        ("issue_number", issue_number),
    ):
        if value not in (None, ""):
            context[key] = value
    return context


def render_task_context(context: Mapping[str, Any]) -> str:
    return "<taskpattern_context>\n" + json.dumps(dict(context), ensure_ascii=False) + "\n</taskpattern_context>"


def repository_from_remote(remote: str) -> str:
    """Normalize a public GitHub origin URL without accepting local paths."""
    value = remote.strip()
    for prefix in ("https://github.com/", "http://github.com/", "ssh://git@github.com/"):
        if value.startswith(prefix):
            value = value[len(prefix):]
            break
    else:
        scp = re.fullmatch(r"git@github\.com:(.+)", value)
        if not scp:
            return ""
        value = scp.group(1)
    value = value.removesuffix(".git").strip("/")
    return value if _REPO_RE.fullmatch(value) else ""
