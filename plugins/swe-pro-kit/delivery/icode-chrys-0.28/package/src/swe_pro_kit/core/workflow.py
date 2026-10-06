"""Explicit stage execution with complete sampling and no implicit degradation.

This executor does not import the historical scheduler or interpret XML to decide
which stages to skip. Setting controls composition; profiles retain their prompts.
"""
from __future__ import annotations
import asyncio
from contextlib import AbstractAsyncContextManager
from .configuration import Setting, Bindings
from .contracts import StageResult, WorkflowResult, StageFailure, StageRunner
from .stages import invoke_stage, validate_workspaces
from .prompts import _decoder_sample_prompt, _decoder_aggregate_prompt, _mapper_stage_prompt, _solver_stage_prompt


async def run(setting: Setting, bindings: Bindings, stage_runner: StageRunner,
              instruction: str, workdir: str,
              decoder_workspaces: AbstractAsyncContextManager[list[str]]) -> WorkflowResult:
    async def stage(role: str, profile: str, prompt: str, cwd: str = workdir) -> StageResult:
        try:
            result = await invoke_stage(stage_runner, profile, role, prompt, cwd)
        except StageFailure:
            raise
        except Exception as exc:
            raise StageFailure(f"{role} execution failed", role=role) from exc
        if result.execution.failed:
            raise StageFailure(f"{role} was reported failed by the host", role=role)
        if not result.output.strip():
            raise StageFailure(f"{role} returned no output", role=role)
        return result

    async with decoder_workspaces as paths:
        validate_workspaces(paths, setting.decoder_count, workdir)
        async def decode(index: int) -> StageResult:
            return await stage(f"decoder-{index}", bindings.decoder,
                               _decoder_sample_prompt(instruction, paths[index], index, len(paths)), paths[index])
        if setting.decoder_execution == "parallel":
            pending = [asyncio.create_task(decode(i)) for i in range(len(paths))]
            try:
                stages = list(await asyncio.gather(*pending))
            except BaseException:
                # Join cancellations before leaving the workspace context so no
                # remaining stage can access a directory while it is removed.
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                raise
        else:
            stages = [await decode(i) for i in range(len(paths))]
        analysis = stages[0].output
        if setting.aggregate:
            aggregation = await stage("aggregator", bindings.aggregator,
                                      _decoder_aggregate_prompt(instruction, workdir, [s.output for s in stages]))
            stages.append(aggregation)
            analysis = aggregation.output
    mapping = await stage("mapper", bindings.mapper, _mapper_stage_prompt(instruction, workdir, analysis))
    stages.append(mapping)
    solution = await stage("solver", bindings.solver, _solver_stage_prompt(instruction, workdir, mapping.output))
    stages.append(solution)
    return WorkflowResult(stages, solution.output)
