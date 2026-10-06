"""Own one Chrys Engine per evaluation stage, including profiles, events and usage."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import re
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any
from ...runtime.distribution import distribution_root
from ...core.contracts import StageExecution, Orchestration
from .composition import build_orchestrator_profile, build_decoder_orchestrator_profile
from .compatibility import verify_host
from .taskpattern import compose_atomic_profile


def _taskpattern_action(tool: str) -> str:
    """Return the stable TaskPattern action across Chrys MCP name renderings."""
    normalized = tool.lower().replace("_", "-").replace(".", "-")
    if "taskpattern" not in normalized:
        return ""
    if normalized.endswith("-search"):
        return "search"
    if normalized.endswith("-apply"):
        return "apply"
    return ""


_FULL_TOOL_RESULT_PATTERN = re.compile(r"\[Full output saved to:\s*(.+?)\r?\n")


def _resolved_taskpattern_result(result: Any, stage_dir: Path | None = None) -> tuple[Any, Path | None]:
    """Load a Chrys-spooled MCP result without trusting arbitrary paths in model output."""
    if not isinstance(result, str):
        return result, None
    try:
        return json.loads(result), None
    except json.JSONDecodeError as direct_error:
        marker = _FULL_TOOL_RESULT_PATTERN.search(result)
        if marker is None or stage_dir is None:
            raise direct_error
        result_path = Path(marker.group(1).strip()).resolve()
        session_dir = (stage_dir / "session").resolve()
        if not result_path.is_relative_to(session_dir) or not result_path.is_file():
            raise direct_error
        return json.loads(result_path.read_text(encoding="utf-8")), result_path


def _taskpattern_result_evidence(result: dict[str, Any]) -> dict[str, Any]:
    """Keep invocation evidence reviewable while large XML/content stays in Chrys artifacts."""
    evidence = dict(result)
    matches = evidence.get("knowledge_matches")
    if isinstance(matches, list):
        compact_matches = []
        for match in matches:
            if not isinstance(match, dict):
                compact_matches.append(match)
                continue
            compact = {key: value for key, value in match.items() if key != "knowledge_xml"}
            knowledge_xml = match.get("knowledge_xml")
            if isinstance(knowledge_xml, str):
                compact["knowledge_xml_length"] = len(knowledge_xml)
                compact["knowledge_xml_sha256"] = hashlib.sha256(
                    knowledge_xml.encode("utf-8")
                ).hexdigest()
            compact_matches.append(compact)
        evidence["knowledge_matches"] = compact_matches
    content = evidence.get("content")
    if isinstance(content, str):
        sections = re.findall(r"(?m)^###\s+(general_summary/[^\r\n]+)", content)
        evidence["content"] = {
            "length": len(content),
            "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "contains_general_knowledge": bool(sections),
            "general_summary_sections": sections,
        }
    return evidence


def validate_taskpattern_invocations(
    role: str, events: list[dict[str, Any]], stage_dir: Path | None = None,
) -> bool:
    """Make the measured evaluation contract a postcondition, not a prompt hope."""
    def invocation(action: str, *, required: bool) -> dict[str, Any] | None:
        starts = [
            event for event in events
            if event.get("event") == "start"
            and _taskpattern_action(str(event.get("tool", ""))) == action
        ]
        finishes = [
            event for event in events
            if event.get("event") == "finish"
            and _taskpattern_action(str(event.get("tool", ""))) == action
        ]
        expected = 1 if required else 0
        if len(starts) != expected or len(finishes) != expected:
            raise ValueError(
                f"TaskPattern evaluation role {role} must complete exactly {expected} {action}; "
                f"observed {len(starts)} start(s) and {len(finishes)} finish(es)"
            )
        if not required:
            return None
        if starts[0].get("id") != finishes[0].get("id"):
            raise ValueError(f"TaskPattern evaluation role {role} has an unmatched {action} invocation")
        metadata = finishes[0].get("metadata") or {}
        if any(metadata.get(key) for key in ("is_error", "errored", "failed", "interrupted")):
            raise ValueError(f"TaskPattern evaluation role {role} {action} invocation failed")
        result = finishes[0].get("result")
        if isinstance(result, str):
            try:
                result, _ = _resolved_taskpattern_result(result, stage_dir)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"TaskPattern evaluation role {role} {action} returned invalid JSON"
                ) from exc
        allowed = {"completed", "partial", "no_candidates"} if action == "search" else {"completed", "partial"}
        if not isinstance(result, dict) or result.get("status") not in allowed:
            status = result.get("status") if isinstance(result, dict) else None
            raise ValueError(
                f"TaskPattern evaluation role {role} {action} returned unusable status {status!r}"
            )
        return result

    search_result = invocation("search", required=True)
    assert search_result is not None
    matches = search_result.get("knowledge_matches", [])
    if not isinstance(matches, list):
        raise ValueError(f"TaskPattern evaluation role {role} search returned invalid knowledge_matches")
    apply_required = bool(matches)
    invocation("apply", required=apply_required)
    return apply_required


def taskpattern_continuation_prompt(role: str, *, applied: bool) -> str:
    """Resume a role whose mandatory advisor turn ended without final text."""
    completed = (
        "The required TaskPattern Search and Apply calls already completed successfully"
        if applied else
        "The required TaskPattern Search completed successfully and found no historical matches"
    )
    return (
        "<taskpattern_stage_continuation>\n"
        f"{completed} "
        "in this role. Do not call either TaskPattern tool again. Now complete the "
        f"{role} work using the repository tools available to you, then return a "
        "non-empty final response for the next stage.\n"
        "</taskpattern_stage_continuation>"
    )

def update_session_usage(totals: dict[str, int], event: Any) -> None:
    # Chrys reports parent-session cumulative totals on both parent and child
    # events. They are global snapshots, not per-source amounts to add together.
    for key, field in (("input", "total_session_input_tokens"), ("output", "total_session_output_tokens"),
                       ("cache", "total_session_cache_hit_tokens")):
        totals[key] = max(totals[key], getattr(event, field) or 0)


class ChrysStageRunner:
    def __init__(self, *, runner: Any, logs_dir: Path, config_root: str,
                 bindings: Any, setting: Any, evaluation: Any = None,
                 taskpattern_context: str = "", evaluation_repository: str = "",
                 evaluation_preparation: str = ""):
        self.host_adapter = verify_host()
        self.adapter_base_commit = json.loads((distribution_root() / "adapters/chrys" / self.host_adapter / "manifest.json").read_text())["base_commit"]
        from chrys.foundation.config.settings import Settings
        from chrys.service.profiles.agents.loader import load_profile_from_yaml
        from chrys.service.profiles.agents.registry import AgentProfileRegistry
        from chrys.service.profiles.models.registry import ModelProfileRegistry

        self.runner, self.logs_dir, self.setting, self.evaluation = runner, logs_dir.resolve(), setting, evaluation
        self.profile_records = []
        self.stage_usage: dict[str, dict[str, int]] = {}
        self.taskpattern_events: list[dict[str, Any]] = []
        self.registry = AgentProfileRegistry()
        self.models = ModelProfileRegistry()
        # Settings.from_env also loads dotenv and project/global settings in this host.
        self.settings = Settings(project_hooks_enabled=False)
        config = Path(config_root).expanduser().resolve() if config_root else None
        self.models.load_all(**({"user_dir": config / "models"} if config else {}))
        if evaluation is not None:
            from chrys.service.profiles.models.loader import load_profile_from_yaml as load_model_profile
            models = [load_model_profile(distribution_root() / "assets" / evaluation.model_profile)]
        else:
            selector = os.environ.get("SWE_PRO_MODEL_PROFILE", os.environ.get("CHRYS_MODEL_PROFILE", ""))
            models = [item for item in self.models.list_profiles() if item.id == selector or item.name == selector]
        if len(models) != 1:
            raise ValueError("SWE_PRO_MODEL_PROFILE must select exactly one configured model ID or name")
        chosen = models[0]
        key = os.environ.get("SWE_PRO_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if not key:
            raise ValueError("missing runtime credential variable SWE_PRO_API_KEY (or OPENAI_API_KEY)")
        # Register only the chosen template and replace any historical YAML credential.
        self.models = ModelProfileRegistry()
        chosen = copy.deepcopy(chosen)
        chosen.api_key = key
        if chosen.http_headers:
            raise ValueError("baseline model template must not contain HTTP headers; use the runtime API key variable")
        self.models.register(chosen)
        model_fields = [
            "id", "name", "provider", "model_id", "api_style", "max_context_tokens", "max_output_tokens",
        ]
        if evaluation is not None:
            model_fields += [
                "base_url", "http_connect_timeout", "http_read_timeout", "http_max_retries",
                "verify_ssl", "bypass_proxy", "chat_options", "stream", "vision",
            ]
        self.model_record = {field: getattr(chosen, field) for field in model_fields}
        setting_overrides = {
            "model_profile": chosen.id,
            "model_profile_override": chosen.id,
            "model_profile_override_sub_agents": True,
        }
        if evaluation is not None:
            setting_overrides.update(max_transient_retries=0, frontend_default_max_transient_retries=0)
        self.settings = replace(self.settings, **setting_overrides)
        assets = distribution_root() / "assets/profiles"
        advisor = None
        if evaluation is not None:
            if config is None:
                raise ValueError("taskpattern-evaluation requires config_root")
            advisor_path = config / "agents" / f"{evaluation.advisor_profile}.yaml"
            if not advisor_path.is_file():
                raise ValueError(
                    "taskpattern-evaluation requires the installed Task Pattern Advisor Chrys profile"
                )
            advisor = load_profile_from_yaml(advisor_path)
        roles = ("decoder", "mapper", "solver") if evaluation is not None else ("decoder", "aggregator", "mapper", "solver")
        for role in roles:
            name = getattr(bindings, role)
            if Path(name).name != name or name in {".", ".."}:
                raise ValueError(f"profile binding must be a profile name, got {name!r}")
            base_name = f"SWEPro{role.title()}" if evaluation is not None and role != "aggregator" else name
            path = config / "agents" / f"{base_name}.yaml" if config else assets / f"{base_name}.yaml"
            if not path.is_file() and (assets / f"{base_name}.yaml").is_file():
                path = assets / f"{base_name}.yaml"
            profile = load_profile_from_yaml(path)
            if profile.name != base_name:
                raise ValueError(f"profile binding {name!r} resolved to a different profile name")
            if evaluation is not None and role != "aggregator":
                profile = compose_atomic_profile(
                    profile, advisor, role, evaluation,
                    taskpattern_context=taskpattern_context,
                    evaluation_repository=evaluation_repository,
                    evaluation_preparation=evaluation_preparation,
                )
            self._validate_atomic(profile, role)
            self.profile_records.append({"role": role, "name": name, "source": str(path),
                                         "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            profile.skills.auto_load_user_agents_skills = False
            profile.skills.auto_load_cwd_agents_skills = False
            profile.approval.default, profile.approval.overrides = "auto", {}
            self.registry.register(profile)

    @staticmethod
    def _validate_atomic(profile: Any, role: str) -> None:
        if profile.sub_agents.agents:
            raise ValueError(f"atomic {role} profile must not declare sub-agent composition")
        # Explicitly bound extension profiles may declare their own capabilities.
        # The shipped baseline profiles have no such extras. Their adapters own
        # task/host path translation; ambient global skills remain disabled.

    async def __call__(self, *, profile: str | Orchestration, instruction: str, workdir: str, role: str) -> StageExecution:
        from chrys.foundation.events.bus import EventBus
        from chrys.foundation.events.types import Error, UsageUpdate, UserMessage
        from chrys.foundation.events.types import InvocationMessage as AgentMessage
        from chrys.foundation.events.types import InvocationToolCallStart, InvocationToolCallResult
        from chrys.orchestration.engine.assembly import assemble_agent_engine as create_engine
        tool_events = ((InvocationToolCallStart, "start"), (InvocationToolCallResult, "finish"))
        from chrys.foundation.models.workspace import Workspace
        from chrys.service.approval.policy import ApprovalMode
        from chrys.service.profiles.agents.loader import load_profile_from_yaml
        from chrys.service.state.store import JsonFileStateStore

        stage_dir = self.logs_dir / "stages" / role
        stage_dir.mkdir(parents=True, exist_ok=True)
        if self.evaluation is not None:
            instruction = (
                "<mandatory_taskpattern_gate>\n"
                "Your first tool call MUST be taskpattern.search using the exact public "
                "context in your system instructions. Before any repository tool, if "
                "Search returns knowledge_matches, your next tool call MUST be "
                "taskpattern.apply. Pass the unchanged matches; when host truncation "
                "removed large XML, pass each Search-approved artifact_ref. Do not "
                "supply issue_mode or leakage_check. Only after Apply succeeds may you "
                "continue this stage.\n"
                "</mandatory_taskpattern_gate>\n\n"
                + instruction
            )
        if isinstance(profile, Orchestration):
            path = stage_dir / "orchestrator.json"
            path.write_text(json.dumps(build_orchestrator_profile(
                profile.setting, profile.bindings, evaluation=self.evaluation
            )), encoding="utf-8")
            selected = load_profile_from_yaml(path)
            if profile.setting.decoder_count > 1:
                ensemble_path = stage_dir / "decoder-orchestrator.json"
                ensemble_path.write_text(json.dumps(build_decoder_orchestrator_profile(profile.setting, profile.bindings)))
                ensemble = load_profile_from_yaml(ensemble_path)
                ensemble.skills.auto_load_user_agents_skills = False
                ensemble.skills.auto_load_cwd_agents_skills = False
                self.registry.register(ensemble)
        else:
            selected = copy.deepcopy(self.registry.get(profile))
        if selected is None:
            raise ValueError(f"profile not loaded: {profile}")
        selected.approval.default = "auto"
        selected.approval.overrides = {}
        selected.skills.auto_load_user_agents_skills = False
        selected.skills.auto_load_cwd_agents_skills = False
        bus = EventBus()
        texts, errors, trace, sources, taskpattern = [], [], [], {}, []
        totals = {"input": 0, "output": 0, "cache": 0}

        async def message(event):
            if event.origin.kind != "turn":
                return
            if event.is_final and not event.is_intermediate:
                texts.append(event.text)

        async def error(event):
            errors.append(event.message)

        async def usage(event):
            update_session_usage(totals, event)
            sources[event.usage_source_id or "main"] = {
                "input": event.total_session_input_tokens,
                "output": event.total_session_output_tokens,
                "cache": event.total_session_cache_hit_tokens,
            }

        async def started(event):
            trace.append({"event": "start", "tool": event.tool_name, "id": event.call_id,
                          "invocation_id": event.origin.invocation_id})
            if "taskpattern" in event.tool_name.lower():
                taskpattern.append({"event": "start", "tool": event.tool_name, "id": event.call_id,
                                    "invocation_id": event.origin.invocation_id})

        async def finished(event):
            trace.append({"event": "finish", "tool": event.tool_name, "id": event.call_id,
                          "invocation_id": event.origin.invocation_id,
                          "result": event.result, "metadata": {
                              key: event.metadata[key] for key in ("is_error", "errored", "failed", "interrupted", "status")
                              if key in event.metadata}})
            if "taskpattern" in event.tool_name.lower():
                result, result_path = _resolved_taskpattern_result(event.result, stage_dir)
                record = {
                    "event": "finish", "tool": event.tool_name, "id": event.call_id,
                    "invocation_id": event.origin.invocation_id,
                    "result": _taskpattern_result_evidence(result) if isinstance(result, dict) else result,
                    "metadata": {
                        key: event.metadata[key]
                        for key in ("is_error", "errored", "failed", "interrupted", "status")
                        if key in event.metadata
                    },
                }
                if result_path is not None:
                    record["result_artifact"] = str(result_path.relative_to(stage_dir))
                taskpattern.append(record)

        for kind, handler in ((AgentMessage, message), (Error, error), (UsageUpdate, usage)):
            await bus.subscribe(kind, handler)
        for kind, phase in tool_events:
            await bus.subscribe(kind, started if phase == "start" else finished)
        workspace = (
            Workspace(primary_cwd=workdir)
            if self.runner is not None
            else Workspace.from_cwd(workdir)
        )
        engine = create_engine(bus, self.settings, agent_registry=self.registry, model_registry=self.models,
                             runner=self.runner, state_store=JsonFileStateStore(directory=stage_dir / "session"),
                             initial_workspace=workspace, allow_user_interaction=False,
                             initial_approval_mode=ApprovalMode.BYPASS,
                             mcp_stdio_cwd=str(self.logs_dir))
        try:
            await engine.start(selected)
            if self.evaluation is not None:
                loaded = engine.current.loaded
                adapter = loaded.mcp_adapter if loaded is not None else None
                failures = getattr(adapter, "failures", {}) if adapter is not None else {}
                if adapter is None or failures:
                    details = ", ".join(f"{name}: {error}" for name, error in failures.items())
                    raise RuntimeError(
                        "TaskPattern MCP failed during evaluation preflight before model execution"
                        + (f": {details}" if details else "")
                    )
                print(
                    f"[swe-pro/taskpattern] {role}: MCP ready with the prepared exhaustive "
                    "snapshot; starting mandatory Search.",
                    file=sys.stderr,
                    flush=True,
                )
            await bus.publish(UserMessage(text=instruction))
            await engine.wait_for_run_task()
            loaded = engine.current.loaded
            executor = loaded.bindings.state if loaded else None
            failed = executor is None or executor.run_failed or executor.was_interrupted or bool(errors)
            if self.evaluation is not None and not failed:
                applied = validate_taskpattern_invocations(role, taskpattern, stage_dir)
                if not texts:
                    await bus.publish(UserMessage(text=taskpattern_continuation_prompt(role, applied=applied)))
                    await engine.wait_for_run_task()
                    loaded = engine.current.loaded
                    executor = loaded.bindings.state if loaded else None
                    failed = (
                        executor is None
                        or executor.run_failed
                        or executor.was_interrupted
                        or bool(errors)
                    )
                    if not failed:
                        validate_taskpattern_invocations(role, taskpattern, stage_dir)
            return StageExecution("\n".join(texts), totals, failed=failed)
        finally:
            try:
                await engine.shutdown()
            finally:
                self.stage_usage[role] = dict(totals)
                (stage_dir / "trace.json").write_text(json.dumps({"tools": trace, "usage_snapshots": sources,
                                                                "session_totals": totals, "errors": errors,
                                                                "approval_mode": engine.approval_mode.value}, indent=2))
                if self.evaluation is not None:
                    self.taskpattern_events.extend(dict(event, role=role) for event in taskpattern)
                    (stage_dir / "taskpattern-invocations.json").write_text(
                        json.dumps({"events": taskpattern}, indent=2), encoding="utf-8"
                    )

    def write_taskpattern_summary(self) -> None:
        """Write one reviewable cross-role artifact at the documented stable path."""
        if self.evaluation is None:
            return
        stage_dir = self.logs_dir / "stages" / "orchestrator"
        stage_dir.mkdir(parents=True, exist_ok=True)
        roles = {}
        for role in ("decoder-0", "mapper", "solver"):
            role_events = [event for event in self.taskpattern_events if event.get("role") == role]
            roles[role] = {
                action: sum(
                    event.get("event") == "finish"
                    and _taskpattern_action(str(event.get("tool", ""))) == action
                    for event in role_events
                )
                for action in ("search", "apply")
            }
        (stage_dir / "taskpattern-invocations.json").write_text(
            json.dumps(
                {
                    "schema": "swe-pro-kit.taskpattern-invocations/v1",
                    "setting": self.evaluation.name,
                    "roles": roles,
                    "events": self.taskpattern_events,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
