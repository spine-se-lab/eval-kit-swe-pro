# Copyright (c) 2026 Chrys. All rights reserved.

"""Runtime dev-knowledge construction from similar historical issues (Lingxi).

Port of codexray's two-step knowledge pipeline to the harbor+chrys stack,
built lazily at trial time (no offline pre-build):

1. **Step analysis** — an agent with read-only repo access browses the
   repository *at the historical fix commit* (a ``git worktree`` of the
   target container's clone — the historical commit predates the target
   base commit, so it is normally present in the same history) and produces
   a 12-section XML deep analysis of the historical issue + its fix patch.
2. **Step summary** — a no-tools LLM pass distills that analysis into a
   generalized, transferable 10-tag XML summary.

Summaries are cached on the host under ``~/.chrys/lingxi/dev_knowledge/``
keyed by ``{repo}_{issue}`` — unique historical issues (~1450 for the
SWE-bench Pro top-3 file) are shared across target instances and reruns.

Consumption mirrors codexray's role slicing: decoder gets 7 tags, mapper 4,
solver 1, each wrapped in a role-specific "how to use" preamble.  In the
forced pipeline each of the three decoder samples is injected with the
knowledge of a *different* similar issue (one-knowledge-per-sample TTS).

This module is harness-agnostic: it never imports harbor.  The caller
(``chrys.harbor_agent``) supplies stage execution and container exec.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Limits — historical patches in the Pro dataset can be hundreds of KB.
# ---------------------------------------------------------------------------

MAX_PATCH_CHARS = 50_000
MAX_ISSUE_CHARS = 20_000
MAX_ANALYSIS_CHARS = 60_000


def _clip(text: str, limit: int, label: str) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [{label} truncated at {limit} chars]"


# ---------------------------------------------------------------------------
# Prompts (ported from codexray src/prompts/dev_knowledge_prompts.py)
# ---------------------------------------------------------------------------

ANALYSIS_USER_PROMPT = """\
You are an expert software developer tasked with analyzing a historical bug report and its corresponding fix. Your goal is to provide a detailed analysis of the issue and the solution.

The repository is checked out AT THE HISTORICAL FIX COMMIT in this directory (read-only):
{HIST_REPO_PATH}
Use your tools to explore it and ground every claim in the actual code.

First, carefully review the following information:

1. The bug report (including title, description, and discussion):
<bug_report>
{ISSUE_DESCRIPTION}
</bug_report>

2. The fix (code patch, commit message, and related context):
<patch>
{PATCH}
</patch>

Your task is to analyze this information and provide a comprehensive report structured in XML format.
Here are the sections you need to cover — provide the final output for each inside the corresponding XML tag:

1. Repository Knowledge Hierarchy Categorization — the issue's location in the repo's architectural hierarchy, from high-level subsystems down to affected classes/functions.
<repository_hierarchy>...</repository_hierarchy>

2. Issue Location Dependency Analysis — trace imports/calls/inheritance of the affected areas; for each dependency, name, type, and where/why it arises.
<dependency_analysis>...</dependency_analysis>

3. Call Trace — the call order/flow across the related subsystems, components, files, classes, functions.
<call_trace>...</call_trace>

4. Bug Categorization — the type of bug and where it occurred (file, class, method, lines).
<bug_category>...</bug_category>

5. Example Usage Context — how/when the affected component is used in a real scenario; why this code matters.
<usage_context>...</usage_context>

6. Concrete Root Cause Analysis — the specific conditions/logic that caused the failure; why the modified files are relevant; environmental constraints if any.
<root_cause>...</root_cause>

7. Current vs Expected Behavior — what the code did before vs intended; overlooked aspects useful for future similar issues; flow of logic in the affected areas.
<behavior_comparison>...</behavior_comparison>

8. Fix Logic — fix location and responsibilities; how the fix resolves the issue; changed operations, guards, invariants; refactor vs patch.
<fix_logic>...</fix_logic>

9. Concrete Fix Steps — numbered, reusable steps (e.g. "Step 1. Add null check before ...").
<fix_steps>...</fix_steps>

10. Fix Checklist — key conditions/heuristics/caveats to check when implementing a similar fix.
<fix_checklist>...</fix_checklist>

11. Test Case — a test from the patch confirming the fix, or one you derive that reproduces the issue and validates the fix.
<test_case>...</test_case>

12. Concluding Statement — a high-level summary of bug, affected subsystems, behavior before/after, fix location and design pattern.
<conclusion>...</conclusion>

Ensure your analysis is thorough, technically accurate, specific, and transferable — future developers will use it to fix similar issues. Keep total exploration focused: aim to finish within roughly 20 tool calls.
"""

PATCH_ONLY_ANALYSIS_PREFIX = """\
NOTE: The repository checkout for the historical commit is unavailable, so base your
analysis on the bug report and patch alone. Skip claims that would require reading
the code; keep every section but mark uncertain parts as "(inferred from patch)".

"""

SUMMARY_USER_PROMPT = """\
Given the following issue analysis report of a historic issue, generate a comprehensive summary with the key knowledge and background needed to solve this issue — abstracted into a more general description that a newcomer could apply to similar issues in the future.

Here is the issue analysis:
<historic_analysis>
{HISTORIC_ISSUE_ANALYSIS}
</historic_analysis>

Here is the patch info:
<historic_patch>
{PATCH}
</historic_patch>

Your generated response MUST be structured using EXACTLY the following XML tags and contain ALL of them:

<general_root_cause_analysis_steps>[General root-cause analysis steps]</general_root_cause_analysis_steps>
<bug_categorization>[Bug categorization]</bug_categorization>
<relevant_architecture>[Relevant architecture]</relevant_architecture>
<involved_components>[Involved components]</involved_components>
<specific_involved_classes_functions_methods>[Specific involved classes/functions/methods]</specific_involved_classes_functions_methods>
<feature_or_functionality_of_issue>[Feature or functionality of the issue]</feature_or_functionality_of_issue>
<general_fix_pattern>[General fix pattern]</general_fix_pattern>
<summary_of_fix_checklist>[Fix checklist from the perspective of the categorized bug type]</summary_of_fix_checklist>
<design_patterns_and_coding_practices>[Design patterns and coding practices required to follow]</design_patterns_and_coding_practices>
<additional_concepts>[Additional domain/system knowledge and best practices]</additional_concepts>

Within each tag you may use lists or sub-sections. Keep it general and abstracted, educational and transferable, structured, and insightful — focus on the most critical aspects without repetition.
"""

_DECODER_WRAPPER = """\
You have privileged access to the following project level development knowledge:
<dev_knowledge>
{knowledge_content}
</dev_knowledge>
The development knowledge above was extracted from a historical issue similar to the current issue.

How to use it:
1. First perform your own READING and EXPLORATION of the current issue.
2. Then consult these sections and make sure you have covered all aspects:
   2.1 If you have not covered <general_root_cause_analysis_steps>, continue exploring the repository if necessary.
   2.2 If you have not considered <involved_components> or <relevant_architecture>, reconsider whether the current issue relates to those components/architecture and explore further if necessary.
3. Consider the other sections when you perform the issue analysis.
"""

_MAPPER_WRAPPER = """\
You have privileged access to the following project level development knowledge:
<dev_knowledge>
{knowledge_content}
</dev_knowledge>
The development knowledge above was extracted from historical issues similar to the current issue.

How to use it:
1. When you perform the FIX ANALYSIS phase, consider the <general_fix_pattern> and <design_patterns_and_coding_practices> sections.
2. After you have generated the fix solution, make sure the <summary_of_fix_checklist> section is covered.
3. Consider the <additional_concepts> section if applicable.
"""

_SOLVER_WRAPPER = """\
You have privileged access to the following project level development knowledge:
<dev_knowledge>
{knowledge_content}
</dev_knowledge>
The development knowledge above was extracted from historical issues similar to the current issue.
When you edit the code, consider the <design_patterns_and_coding_practices> section.
"""

_ROLE_TAGS: dict[str, list[str]] = {
    "decoder": [
        "general_root_cause_analysis_steps",
        "bug_categorization",
        "relevant_architecture",
        "involved_components",
        "specific_involved_classes_functions_methods",
        "feature_or_functionality_of_issue",
        "additional_concepts",
    ],
    "mapper": [
        "general_fix_pattern",
        "summary_of_fix_checklist",
        "design_patterns_and_coding_practices",
        "additional_concepts",
    ],
    "solver": [
        "design_patterns_and_coding_practices",
    ],
}

_ROLE_WRAPPERS = {"decoder": _DECODER_WRAPPER, "mapper": _MAPPER_WRAPPER, "solver": _SOLVER_WRAPPER}


def extract_xml_content(text: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.DOTALL)
    return m.group(1).strip() if m else None


def slice_for_role(summary_xml: str, role: str) -> str:
    """Extract the role's tags from a 10-tag summary and wrap with its usage preamble.

    Returns "" when none of the role's tags are present (malformed summary).
    """
    tags = _ROLE_TAGS[role]
    parts = []
    for tag in tags:
        content = extract_xml_content(summary_xml, tag)
        if content:
            parts.append(f"<{tag}>\n{content}\n</{tag}>")
    if not parts:
        return ""
    return _ROLE_WRAPPERS[role].format(knowledge_content="\n".join(parts))


# ---------------------------------------------------------------------------
# Reranked-similarity dataset access (byte-offset index over the big JSONL)
# ---------------------------------------------------------------------------


@dataclass
class SimilarIssue:
    repo: str  # e.g. "NodeBB/NodeBB"
    issue_number: int
    issue_desc: str
    issue_body: str
    patch: str
    commit_id: str
    relevance_score: float
    reranked_position: int

    @property
    def cache_key(self) -> str:
        return f"{self.repo.replace('/', '+')}_{self.issue_number}"


class RerankedIndex:
    """Lazy byte-offset index over the reranked top-k JSONL (instance → rows).

    The data file is ~1.2 GB; scanning it per trial is wasteful.  On first
    use we stream it once, recording {lowercased instance_id: [byte offsets]},
    and persist that next to the cache dir.  The index is invalidated when
    the data file's size or mtime changes.
    """

    def __init__(self, data_path: str | Path, cache_dir: str | Path) -> None:
        self.data_path = Path(data_path)
        self.cache_dir = Path(cache_dir)
        self._offsets: dict[str, list[int]] | None = None

    def _index_path(self) -> Path:
        return self.cache_dir / "reranked_index.json"

    def _load_or_build(self) -> dict[str, list[int]]:
        if self._offsets is not None:
            return self._offsets
        st = self.data_path.stat()
        stamp = {"size": st.st_size, "mtime": int(st.st_mtime)}
        idx_path = self._index_path()
        if idx_path.is_file():
            try:
                cached = json.loads(idx_path.read_text())
                if cached.get("stamp") == stamp:
                    self._offsets = dict(cached["offsets"])
                    return self._offsets
            except Exception:
                logger.warning("reranked index unreadable; rebuilding", exc_info=True)
        logger.info("building reranked index over %s (one-off)", self.data_path.name)
        offsets: dict[str, list[int]] = {}
        with open(self.data_path, "rb") as f:
            pos = 0
            for line in f:
                # Cheap key sniff before full JSON parse.
                m = re.search(rb'"instance_id"\s*:\s*"([^"]+)"', line[:4096])
                if m:
                    offsets.setdefault(m.group(1).decode().lower(), []).append(pos)
                pos += len(line)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        tmp = idx_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"stamp": stamp, "offsets": offsets}))
        tmp.replace(idx_path)
        self._offsets = offsets
        logger.info("reranked index built: %d instances", len(offsets))
        return offsets

    def lookup(self, instance_id: str, top_k: int) -> list[SimilarIssue]:
        """Return up to ``top_k`` similar issues for the instance, best first.

        Falls back to unique-prefix matching: harbor derives the instance id
        from the trial directory name, which truncates the base-commit SHA
        (e.g. ``instance_ansible__ansible-83fb24``), while the index keys hold
        the full ids.  A truncated id is still a unique prefix in practice.
        """
        table = self._load_or_build()
        key = instance_id.lower().strip()
        offsets = table.get(key, [])
        if not offsets and len(key) >= 12:
            matches = [k for k in table if k.startswith(key)]
            if len(matches) == 1:
                logger.info("reranked lookup: prefix-matched %r -> %r", key, matches[0])
                offsets = table[matches[0]]
            elif len(matches) > 1:
                logger.warning("reranked lookup: prefix %r ambiguous (%d matches); skipping", key, len(matches))
        rows = []
        with open(self.data_path, "rb") as f:
            for off in offsets:
                f.seek(off)
                try:
                    d = json.loads(f.readline())
                except Exception:
                    logger.debug("skipping unparsable reranked row at offset %d", off, exc_info=True)
                    continue
                rows.append(d)
        rows.sort(key=lambda d: d.get("reranked_position", 0))
        out = []
        for d in rows[:top_k]:
            try:
                out.append(
                    SimilarIssue(
                        repo=d.get("instance_repo") or d.get("repo") or "",
                        issue_number=int(d["retrieved_issue_number"]),
                        issue_desc=d.get("retrieved_issue_desc") or "",
                        issue_body=d.get("retrieved_issue_body") or "",
                        patch=d.get("retrieved_patch") or "",
                        commit_id=d.get("retrieved_commit_id") or "",
                        relevance_score=float(d.get("relevance_score") or 0.0),
                        reranked_position=int(d.get("reranked_position") or 0),
                    )
                )
            except Exception:
                logger.warning("skipping malformed reranked row for %s", instance_id, exc_info=True)
        return out


def default_data_path() -> Path | None:
    """Resolve the reranked JSONL: env override, then the repo-relative copy."""
    env = os.environ.get("CHRYS_LINGXI_RERANKED_PATH", "").strip()
    if env:
        p = Path(env).expanduser()
        return p if p.is_file() else None
    repo_root = Path(__file__).resolve().parents[2]
    fname = "swebenchpro_historical_similarity.qwen3_reranked.top3.jsonl"
    # New dir name is ``ranked_data``; keep the legacy ``reranked data`` as a
    # fallback so older checkouts still resolve.
    for dirname in ("ranked_data", "reranked data"):
        candidate = repo_root / dirname / fname
        if candidate.is_file():
            return candidate
    return None


def default_cache_dir() -> Path:
    override = os.environ.get("CHRYS_LINGXI_CACHE_DIR", "").strip()
    return Path(override).expanduser().resolve() if override else Path.home() / ".chrys" / "lingxi" / "dev_knowledge"


# ---------------------------------------------------------------------------
# Two-step construction (caller supplies stage execution)
# ---------------------------------------------------------------------------


def build_analysis_prompt(issue: SimilarIssue, hist_repo_path: str | None) -> str:
    """Prompt for the step-analysis agent (worktree browse or patch-only)."""
    desc = _clip(issue.issue_desc or issue.issue_body, MAX_ISSUE_CHARS, "issue")
    patch = _clip(issue.patch, MAX_PATCH_CHARS, "patch")
    body = ANALYSIS_USER_PROMPT.format(
        HIST_REPO_PATH=hist_repo_path or "(unavailable)",
        ISSUE_DESCRIPTION=desc,
        PATCH=patch,
    )
    if hist_repo_path is None:
        body = PATCH_ONLY_ANALYSIS_PREFIX + body
    return body


def build_summary_prompt(analysis: str, issue: SimilarIssue) -> str:
    return SUMMARY_USER_PROMPT.format(
        HISTORIC_ISSUE_ANALYSIS=_clip(analysis, MAX_ANALYSIS_CHARS, "analysis"),
        PATCH=_clip(issue.patch, MAX_PATCH_CHARS, "patch"),
    )


def load_cached_summary(cache_dir: Path, issue: SimilarIssue) -> str | None:
    p = cache_dir / f"{issue.cache_key}_step_summary.txt"
    if p.is_file():
        try:
            return p.read_text(encoding="utf-8")
        except Exception:
            return None
    return None


def default_pregenerated_dir() -> Path | None:
    """Resolve the pre-generated knowledge directory.

    Order: ``$CHRYS_LINGXI_KNOWLEDGE_DIR`` env override, then the repo-relative
    ``swebench pro issues/``. Returns None if neither exists — callers then fall
    back to runtime generation, so this is fully backward-compatible.

    ``CHRYS_LINGXI_KNOWLEDGE_DIR=off`` (or none/0/no/false/disabled) disables
    all knowledge and plan injection at the harness boundary. To use runtime
    generation, leave this variable unset and provide the reranked dataset.
    """
    override = os.environ.get("CHRYS_LINGXI_KNOWLEDGE_DIR")
    if override is not None and override.strip().lower() in {"", "off", "none", "0", "no", "false", "disabled"}:
        return None
    if override and Path(override).is_dir():
        return Path(override)
    cand = Path(__file__).resolve().parent.parent.parent / "swebench pro issues"
    return cand if cand.is_dir() else None


def load_pregenerated_summary(knowledge_dir: Path, instance_id: str, rank: int) -> str | None:
    """Load a pre-generated dev-knowledge summary by (target instance, rank).

    Files are named ``{...}{base_commit}{...}__r{rank}__c{sim_commit}_step_summary.txt``;
    we match by the target instance's 40-hex base commit + the rank (r0/r1/r2 ==
    reranked top-1/2/3, verified identical ordering). No reranked file needed for
    ordering — the rank is in the filename.
    """
    import glob as _glob
    import re as _re

    m = _re.search(r"[0-9a-f]{40}", instance_id)
    if not m:
        return None
    pattern = str(Path(knowledge_dir) / f"*{m.group(0)}*__r{rank}__*_step_summary.txt")
    files = sorted(_glob.glob(pattern))
    if not files:
        return None
    try:
        return Path(files[0]).read_text(encoding="utf-8")
    except OSError:
        return None


def save_summary(cache_dir: Path, issue: SimilarIssue, kind: str, content: str) -> None:
    """Atomically persist a step artifact (kind: 'step_analysis' | 'step_summary')."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    p = cache_dir / f"{issue.cache_key}_{kind}.txt"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(p)
