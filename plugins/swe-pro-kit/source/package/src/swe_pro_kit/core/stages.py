"""Normalize host responses without imposing a workflow's failure policy."""
from .contracts import StageExecution, StageResult, StageFailure, StageRunner, Orchestration


async def invoke_stage(runner: StageRunner, profile: str | Orchestration, role: str,
                       instruction: str, workdir: str) -> StageResult:
    response = await runner(profile=profile, role=role, instruction=instruction, workdir=workdir)
    if isinstance(response, str):
        response = StageExecution(response)
    if not isinstance(response, StageExecution) or not isinstance(response.text, str):
        raise StageFailure(f"{role} returned an invalid runner response", role=role)
    return StageResult(role, profile if isinstance(profile, str) else "orchestrator", response)


def validate_workspaces(paths: list[str], count: int, canonical: str) -> None:
    if len(paths) != count or len(set(paths)) != len(paths) or canonical in paths:
        raise ValueError("provide one private workspace per Decoder, distinct from the canonical repository")
