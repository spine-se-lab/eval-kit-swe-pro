"""Opt-in compatibility with the historical forced-stage result-selection rules."""
from __future__ import annotations
import asyncio
from contextlib import AbstractAsyncContextManager
from .configuration import Setting, Bindings
from .contracts import StageResult, WorkflowResult, StageRunner
from .stages import invoke_stage, validate_workspaces
from .prompts import _decoder_sample_prompt, _decoder_aggregate_prompt, _mapper_stage_prompt, _solver_stage_prompt


async def run(setting: Setting, bindings: Bindings, stage_runner: StageRunner,
              instruction: str, workdir: str,
              decoder_workspaces: AbstractAsyncContextManager[list[str]]) -> WorkflowResult:
    async def run(role, profile, prompt, cwd=workdir):
        return await invoke_stage(stage_runner, profile, role, prompt, cwd)

    async with decoder_workspaces as paths:
        validate_workspaces(paths, setting.decoder_count, workdir)
        async def decode(index):
            return await run(f"decoder-{index}", bindings.decoder,
                             _decoder_sample_prompt(instruction, paths[index], index, len(paths)), paths[index])
        if setting.decoder_execution == "parallel":
            samples = await asyncio.gather(*(decode(i) for i in range(len(paths))), return_exceptions=True)
        else:
            samples = []
            for i in range(len(paths)):
                try:
                    samples.append(await decode(i))
                except Exception as exc:
                    samples.append(exc)
        stages = [s for s in samples if isinstance(s, StageResult)]
        successful = [s.output for s in stages if "<issue_analysis>" in s.output]
        # Historical forced-stage semantics: no valid XML -> forward all returned
        # strings; one valid result -> skip aggregation; two or more -> aggregate.
        analysis = "\n\n".join(s.output for s in stages)
        if len(successful) == 1:
            analysis = successful[0]
        elif len(successful) > 1:
            aggregation = await run("aggregator", bindings.aggregator,
                                    _decoder_aggregate_prompt(instruction, workdir, successful))
            stages.append(aggregation)
            analysis = aggregation.output
    mapping = await run("mapper", bindings.mapper, _mapper_stage_prompt(instruction, workdir, analysis))
    stages.append(mapping)
    solution = await run("solver", bindings.solver, _solver_stage_prompt(instruction, workdir, mapping.output))
    stages.append(solution)
    return WorkflowResult(stages, solution.output)
