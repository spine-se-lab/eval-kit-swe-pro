"""Run the public iCode workflow host against the evaluator's task environment."""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import asdict

from ...core.configuration import expected_stage_roles
from ...core.contracts import StageExecution, StageFailure, StageResult, WorkflowResult
from ...core.stages import validate_workspaces
from ...runtime.distribution import distribution_root


async def run(setting, bindings, stage_runner, instruction, workdir, decoder_workspaces):
    from chrys.foundation.events.bus import EventBus
    from chrys.foundation.events.types import (
        InvocationToolCallStart, InvocationToolCallResult, UsageUpdate,
        WorkflowNodeStateChanged, WorkflowRunAccepted,
    )
    from chrys.foundation.models.workspace import Workspace
    from chrys.foundation.util.once_close import finish_close
    from chrys.orchestration.session_host import ChrysSessionHost
    from chrys.service.state.store import JsonFileStateStore

    root = stage_runner.logs_dir / "native-workflow"
    definitions = root / ".chrys/workflows"
    definitions.mkdir(parents=True, exist_ok=True)
    source = (
        '# /// script\n# requires-python = ">=3.14"\n# [tool.chrys]\n'
        f'# python = {json.dumps(sys.executable)}\n# ///\n'
        'import sys\n'
        f'sys.path.insert(0, {str(distribution_root() / "package/src")!r})\n'
        'from swe_pro_kit.core.configuration import Setting, Bindings\n'
        'from swe_pro_kit.adapters.chrys.native_graph import build_workflow\n'
        f'workflow = build_workflow(Setting(**{asdict(setting)!r}), Bindings(**{asdict(bindings)!r}))\n'
    )
    (definitions / "swe-pro.py").write_text(source, encoding="utf-8")
    roles = expected_stage_roles(setting)
    stage_runner.stage_usage.update({role: {"input": 0, "output": 0, "cache": 0} for role in roles})
    totals = {"input": 0, "output": 0, "cache": 0}
    invocations = {}
    traces = {role: [] for role in roles}
    states = []
    evidence = {"executor": "icode-workflow", "source": str(definitions / "swe-pro.py")}
    bus = EventBus()

    async def state(event):
        states.append(asdict(event))
        if event.node_id in roles:
            if event.invocation_id:
                invocations[event.invocation_id] = event.node_id
            print(f"[swe-pro/icode-workflow] {event.node_id}: {event.state}", file=sys.stderr, flush=True)

    async def accepted(event):
        evidence.update(run_id=event.run_id, session_id=event.session_id)

    async def usage(event):
        # Native nodes share a session. Ordered cumulative snapshots are counted
        # once, attributing each delta to the invocation that produced it.
        source_id = event.usage_source_id.removesuffix(":last_words")
        role = invocations.get(source_id, "unattributed")
        target = stage_runner.stage_usage.setdefault(role, {"input": 0, "output": 0, "cache": 0})
        for key, value in (("input", event.total_session_input_tokens),
                           ("output", event.total_session_output_tokens),
                           ("cache", event.total_session_cache_hit_tokens)):
            current = value or 0
            target[key] += max(0, current - totals[key])
            totals[key] = max(totals[key], current)

    async def tool(event):
        role = invocations.get(event.origin.root.invocation_id)
        if role is not None:
            traces[role].append(asdict(event))

    for kind, handler in ((WorkflowNodeStateChanged, state), (WorkflowRunAccepted, accepted),
                          (UsageUpdate, usage), (InvocationToolCallStart, tool), (InvocationToolCallResult, tool)):
        await bus.subscribe(kind, handler)

    try:
        async with decoder_workspaces as paths:
            validate_workspaces(paths, setting.decoder_count, workdir)
            workspaces = {role: Workspace.from_cwd(workdir) for role in roles}
            workspaces.update({f"decoder-{index}": Workspace.from_cwd(path) for index, path in enumerate(paths)})
            host = ChrysSessionHost(
                profile_name=bindings.decoder, settings=stage_runner.settings,
                event_bus=bus, agent_registry=stage_runner.registry, model_registry=stage_runner.models,
                state_store=JsonFileStateStore(directory=root / "sessions"), cwd=str(root),
                runner=stage_runner.runner, workflow_workspaces=workspaces, mcp_stdio_cwd=str(root),
                allow_user_interaction=False,
            )
            try:
                prepared = await host.preview_workflow(host.workflow_target("swe-pro"), trust=True)
                host.confirm_workflow(prepared)
                result = await host.run_workflow_until_final(prepared, input_text=json.dumps({
                    "instruction": instruction, "workdir": workdir, "decoder_workspaces": paths,
                }))
                evidence.update(outcome=result.outcome.value, failed_node=result.node_id)
                if result.outcome.value != "completed":
                    role = result.node_id.removeprefix("checked-")
                    raise StageFailure("iCode workflow did not complete", role=role)
                outputs = {output.node_id.removeprefix("checked-"): output.value.text for output in result.outputs}
                profiles = {"aggregator": bindings.aggregator, "mapper": bindings.mapper, "solver": bindings.solver}
                stages = [StageResult(
                    role, bindings.decoder if role.startswith("decoder-") else profiles[role],
                    StageExecution(outputs[role], dict(stage_runner.stage_usage[role])),
                ) for role in roles]
                return WorkflowResult(stages, outputs["solver"])
            finally:
                # The host drains cancelled invocations before private workspaces
                # leave their context, including external Harbor cancellation.
                await finish_close(asyncio.create_task(host.shutdown()))
    finally:
        evidence.update(usage=totals, nodes=states)
        (root / "run.json").write_text(json.dumps(evidence, indent=2, default=str), encoding="utf-8")
        for role in roles:
            directory = stage_runner.logs_dir / "stages" / role
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "trace.json").write_text(json.dumps({
                "tools": traces[role], "usage": stage_runner.stage_usage[role], "approval_mode": "bypass",
            }, indent=2, default=str), encoding="utf-8")
