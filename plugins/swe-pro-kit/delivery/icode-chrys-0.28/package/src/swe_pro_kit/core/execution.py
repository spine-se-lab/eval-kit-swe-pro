"""Dispatch the explicitly selected executor; profiles and inputs are shared."""
from __future__ import annotations
from contextlib import AbstractAsyncContextManager
from .configuration import Setting, Bindings
from .contracts import StageExecution, StageFailure, WorkflowResult, StageRunner, Orchestration
from .prompts import _wrap_instruction_for_sandbox
from .stages import invoke_stage


async def execute(
    setting: Setting, bindings: Bindings, stage_runner: StageRunner,
    instruction: str, workdir: str, *, instance_id: str = "",
    taskpattern_context: str = "",
    decoder_workspaces: AbstractAsyncContextManager[list[str]] | None = None,
) -> WorkflowResult:
    if not isinstance(instruction, str) or not instruction.strip():
        raise ValueError("instruction must be nonempty")
    if not isinstance(workdir, str) or not workdir.strip():
        raise ValueError("workdir must be nonempty")
    if setting.executor == "sub-agent":
        root = await invoke_stage(stage_runner, Orchestration(setting, bindings), "orchestrator",
                                  _wrap_instruction_for_sandbox(
                                      instruction, workdir=workdir, instance_id=instance_id,
                                      taskpattern_context=taskpattern_context,
                                  ), workdir)
        return WorkflowResult([root], root.output)
    if decoder_workspaces is None:
        raise ValueError("workflow execution requires isolated decoder workspaces")
    if setting.executor == "icode-workflow":
        raise ValueError("icode-workflow must be dispatched by the Chrys native workflow adapter")
    if setting.executor == "legacy-workflow":
        from .legacy_workflow import run
    else:
        from .workflow import run
    return await run(setting, bindings, stage_runner, instruction, workdir, decoder_workspaces)
