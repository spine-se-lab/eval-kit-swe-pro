"""Evaluation results and the role-execution interface shared by executors."""
from dataclasses import dataclass, field
from typing import Any, Protocol
from .configuration import Setting, Bindings

@dataclass(frozen=True)
class StageExecution:
    text: str
    usage: dict[str, Any] = field(default_factory=dict)
    failed: bool = False


@dataclass(frozen=True)
class StageResult:
    role: str
    profile: str
    execution: StageExecution

    @property
    def output(self) -> str:
        return self.execution.text

    @property
    def usage(self) -> dict[str, Any]:
        return self.execution.usage


@dataclass(frozen=True)
class WorkflowResult:
    stages: list[StageResult]
    final_output: str


class StageFailure(RuntimeError):
    """A stage failed under the selected executor's policy."""
    def __init__(self, message: str, *, role: str | None = None):
        super().__init__(message)
        self.role = role


@dataclass(frozen=True)
class Orchestration:
    """Host-independent request to compose atomic roles as sub-agents."""
    setting: Setting
    bindings: Bindings


class StageRunner(Protocol):
    async def __call__(self, *, profile: str | Orchestration, instruction: str,
                       workdir: str, role: str) -> str | StageExecution: ...

