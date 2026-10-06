"""Harbor external-agent entry point. Missing Harbor is an import failure."""

from __future__ import annotations

import json
import os
from dataclasses import asdict
from pathlib import Path

from harbor.agents.base import BaseAgent

from ... import __version__
from ..chrys.engine import ChrysStageRunner
from ...runtime.distribution import distribution_root
from ...runtime.workspace import isolated_history, save_patch
from ...runtime.decoder_workspaces import decoder_workspaces
from .environment import HarborEnvRunner
from ...core.configuration import load_bindings, load_setting
from ...core.taskpattern import (
    EVALUATION_PRESET,
    load_taskpattern_evaluation,
    public_task_context,
    repository_from_remote,
    render_task_context,
)
from ...core.execution import execute
from ...core.contracts import StageFailure


class ChrysAgent(BaseAgent):
    SUPPORTS_ATIF = False
    SUPPORTS_WINDOWS = False

    def __init__(self, *args, setting: str = "", bindings: str = "", config_root: str = "",
                 workdir: str = "/app", repo: str = "", base_commit: str = "",
                 instance_id: str = "", issue_number: int | str | None = None,
                 evaluation_repository: str = "", evaluation_preparation: str = "", **kwargs):
        if "profile" in kwargs:
            raise ValueError("select composition with setting and atomic profiles with bindings")
        assets = distribution_root() / "assets"
        self.evaluation = load_taskpattern_evaluation(assets) if setting == EVALUATION_PRESET else None
        if self.evaluation is not None:
            if bindings:
                raise ValueError("taskpattern-evaluation has fixed role bindings; do not pass bindings")
            self.setting, self.bindings = self.evaluation.setting, self.evaluation.bindings
        else:
            self.setting = load_setting(setting, settings_dir=assets / "settings")
            self.bindings = load_bindings(bindings or assets / "bindings.json")
        self.task_repo, self.task_base_commit = repo, base_commit
        self.task_instance_id, self.task_issue_number = instance_id, issue_number
        self.evaluation_repository = evaluation_repository.strip()
        self.evaluation_preparation = evaluation_preparation.strip()
        if self.evaluation is not None:
            if not self.evaluation_repository or not self.evaluation_preparation:
                raise ValueError(
                    "taskpattern-evaluation requires the pre-task catalog preparation record"
                )
            if not Path(self.evaluation_preparation).is_absolute():
                raise ValueError("evaluation preparation record path must be absolute")
        self.config_root, self.workdir = config_root, workdir
        super().__init__(*args, **kwargs)

    @staticmethod
    def name() -> str:
        return "swe-pro-kit"

    def version(self) -> str:
        from ... import __version__
        return __version__

    def _infer_instance_id(self) -> str:
        """Use only a complete benchmark identity for measured evaluation."""
        if self.task_instance_id.strip():
            return self.task_instance_id.strip()
        try:
            config = Path(self.logs_dir).parent / "config.json"
            if config.is_file():
                name = json.loads(
                    config.read_text(encoding="utf-8")
                ).get("task", {}).get("name", "")
                if name:
                    probe = public_task_context("repository probe", instance_id=name)
                    if probe.get("instance_id"):
                        return name
        except Exception:
            pass
        if self.evaluation is not None:
            return ""
        trial = Path(self.logs_dir).parent.name
        return trial.rsplit("__", 1)[0] if "__" in trial else trial

    async def setup(self, environment) -> None:
        # Fail before model calls if the task cannot enforce its command budget.
        result = await environment.exec(
            "command -v git tar base64 timeout && timeout --kill-after=2s 1s true",
            cwd=self.workdir, timeout_sec=30,
        )
        if result.return_code:
            raise RuntimeError("task environment requires git, tar, base64 and GNU-compatible timeout")

    async def _repository(self, runner: HarborEnvRunner, instance_id: str) -> str:
        """Resolve public repository identity without exposing a local path."""
        if self.task_repo:
            return self.task_repo
        inferred = public_task_context("repository probe", instance_id=instance_id).get("repo", "")
        if inferred:
            return str(inferred)
        result = await runner.exec("git config --get remote.origin.url", cwd=self.workdir, timeout=30)
        if result.return_code == 0:
            inferred = repository_from_remote(result.stdout)
        if not inferred:
            raise ValueError(
                "TaskPattern evaluation could not infer repository; pass "
                "--repository owner/repo (interactive TaskPattern use should ask the user)"
            )
        return inferred

    async def run(self, instruction, environment, context) -> None:
        logs = Path(self.logs_dir).resolve()
        logs.mkdir(parents=True, exist_ok=True)
        runner = HarborEnvRunner(environment, default_cwd=self.workdir)
        instance_id = self._infer_instance_id()
        task_context = ""
        public_context = None
        if self.evaluation is not None:
            repository = await self._repository(runner, instance_id)
            if repository != self.evaluation_repository:
                raise ValueError("prepared TaskPattern repository does not match the task")
            public_context = public_task_context(
                instruction, instance_id=instance_id, repo=repository,
                base_commit=self.task_base_commit, issue_number=self.task_issue_number,
            )
            missing = [key for key in ("instance_id", "base_commit") if not public_context.get(key)]
            if missing:
                raise ValueError(
                    "taskpattern-evaluation requires a complete public benchmark identity before model execution; "
                    "pass --instance-id and --base-commit"
                )
            task_context = render_task_context(public_context)
        stage_runner = ChrysStageRunner(
            runner=runner, logs_dir=logs, config_root=self.config_root,
            bindings=self.bindings, setting=self.setting, evaluation=self.evaluation,
            taskpattern_context=task_context,
            evaluation_repository=self.evaluation_repository,
            evaluation_preparation=self.evaluation_preparation,
        )
        selected_model = stage_runner.model_record
        model_identity = f"{selected_model['provider']}/{selected_model['model_id']}"
        if self.model_name and self.model_name not in {selected_model["model_id"], model_identity}:
            raise ValueError("Harbor model_name conflicts with SWE_PRO_MODEL_PROFILE")
        self.model_name = model_identity
        self._init_model_info()
        record = {"setting": asdict(self.setting), "bindings": asdict(self.bindings), "status": "running",
                  "profiles": stage_runner.profile_records, "model": stage_runner.model_record,
                  "plugin_version": __version__, "adapter": getattr(stage_runner, "host_adapter", None),
                  "adapter_base_commit": getattr(stage_runner, "adapter_base_commit", None)}
        if self.evaluation is not None:
            record["evaluation"] = dict(self.evaluation.raw)
            preparation_path = Path(self.evaluation_preparation)
            try:
                preparation = json.loads(preparation_path.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ValueError("TaskPattern evaluation preparation record is unreadable") from exc
            record["evaluation_preparation"] = {
                "record": str(preparation_path),
                "scope": preparation.get("scope"),
                "repository": preparation.get("repository"),
                "status": preparation.get("status"),
                "cache_status": preparation.get("cache_status"),
                "github_request_count": preparation.get("github_request_count"),
                "duration_ms": preparation.get("duration_ms"),
                "snapshot": preparation.get("snapshot"),
            }
            record["taskpattern_context"] = {
                key: value for key, value in public_context.items() if key != "issue_description"
            }
        try:
            scrub = self.setting.executor in {"workflow", "icode-workflow"} or os.environ.get("CHRYS_SCRUB_GIT", "1").strip().lower() not in {"0", "false", "no", "off"}
            async with isolated_history(runner, logs, hide=self.setting.executor == "sub-agent", enabled=scrub):
                workspaces = decoder_workspaces(runner, self.setting.decoder_count, sanitize_history=scrub)
                if self.setting.executor == "icode-workflow":
                    from ..chrys.native_workflow import run
                    result = await run(self.setting, self.bindings, stage_runner, instruction, self.workdir, workspaces)
                else:
                    result = await execute(
                        self.setting, self.bindings, stage_runner, instruction, self.workdir,
                        decoder_workspaces=workspaces,
                        instance_id=instance_id, taskpattern_context=task_context,
                    )
            await save_patch(runner, logs)
            record.update(status="completed", stages=[asdict(stage) for stage in result.stages],
                          final_output=result.final_output)
        except BaseException as exc:
            # Provider exception strings may contain request credentials/headers.
            record.update(status="failed", error_type=type(exc).__name__)
            if isinstance(exc, StageFailure):
                record["failed_stage"] = exc.role
            raise
        finally:
            stage_runner.write_taskpattern_summary()
            totals = {key: sum(usage[key] for usage in stage_runner.stage_usage.values())
                      for key in ("input", "output", "cache")}
            context.n_input_tokens = totals["input"]
            context.n_output_tokens = totals["output"]
            context.n_cache_tokens = totals["cache"]
            record["usage"] = totals
            (logs / "baseline-run.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
