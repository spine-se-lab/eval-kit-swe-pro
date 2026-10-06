"""Register the historical nested profile tree through Chrys's existing sub-agent API.

This adapter only wires declared children. It does not schedule calls or judge
stage order; the archived root and ensemble prompts still control that behavior.
"""
from __future__ import annotations
from typing import Any


async def register_children(parent: Any, profile: Any, runtime: Any, *, settings: Any,
                            fallback_profile: Any, model_registry: Any) -> list[Any]:
    from chrys.orchestration.sub_agents.tools import SubAgentTools

    registry = parent._agent_registry
    if registry is None:
        raise ValueError("nested composition requires an agent registry")
    ancestry = parent._profile_ancestry
    if profile.name in ancestry:
        raise ValueError(f"cyclic sub-agent composition: {profile.name}")
    # Use the host's existing call, usage, approval and cleanup machinery at
    # each level, with separate concurrency accounting for each parent.
    fields = (
        "session_id", "session_dir", "on_sub_agent_usage", "on_side_call_usage",
        "drain_parent_usage_publishes", "mutation_tracker", "mutation_coordinator",
        "approval_mode", "approval_judge", "workspace_roots", "approval_log_dir",
        "mcp_cache", "hook_manager", "workspace_cwd", "serialize_implicit_windows",
        "spill_quota", "runner", "ask_user_timeout_seconds", "turn_context",
        "max_transient_retries", "tool_result_ceiling_tokens", "allow_user_interaction",
        "mcp_stdio_cwd",
    )
    children = SubAgentTools(
        human_failure_decisions=parent._human_failure_decisions,
        **{name: getattr(parent, f"_{name}") for name in fields},
        max_total_concurrency=profile.sub_agents.max_total_concurrency,
        event_bus=parent._bus, parent_approval=profile.approval, agent_registry=registry,
        profile_ancestry=(*ancestry, profile.name),
    )
    parent._nested_tools.append(children)
    try:
        for ref in profile.sub_agents.agents:
            child = registry.get(ref.profile)
            if child is None:
                raise ValueError(f"nested profile not loaded: {ref.profile}")
            await children.register(ref, child, runtime, settings=settings,
                                    fallback_profile=fallback_profile, model_registry=model_registry)
        return children.get_tools()
    except BaseException:
        await children.cleanup()
        parent._nested_tools.remove(children)
        raise
