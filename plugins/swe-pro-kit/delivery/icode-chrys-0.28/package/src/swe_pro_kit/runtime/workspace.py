"""Temporarily hide task Git history, preserving the original verifier metadata."""

from __future__ import annotations

import shlex
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from typing import Protocol, Any


class TaskWorkspace(Protocol):
    """Remote workspace operations; implementations own provider-specific I/O."""
    default_cwd: str
    async def checked(self, command: str, *, cwd: str | None = None, timeout: float = 120) -> str: ...
    async def exec(self, command: str, **kwargs: Any) -> Any: ...
    async def download_file(self, source: str, target: str) -> None: ...
    async def upload_file(self, source: str, target: str) -> None: ...


@asynccontextmanager
async def isolated_history(runner: TaskWorkspace, logs_dir: Path, *, hide: bool = True, enabled: bool = True):
    """Preserve verifier Git metadata outside the task during model execution.

    Sub-agent mode hides Git as in the historical harness. Workflow mode leaves
    history to the extracted Decoder sanitizer (HEAD and its ancestors).
    """
    if not enabled:
        yield
        return
    token = uuid.uuid4().hex
    remote = f"/tmp/swe-pro-git-{token}.tar"
    restore = f"/tmp/swe-pro-restore-{token}"
    archive = logs_dir / "original-git-recovery.tar"
    repo = shlex.quote(runner.default_cwd)
    await runner.checked(f"test -d {repo}/.git && tar -C {repo} -cf {shlex.quote(remote)} .git", cwd="/")
    try:
        await runner.download_file(remote, str(archive))
    finally:
        await runner.checked(f"rm -f -- {shlex.quote(remote)}", cwd="/")
    if not archive.is_file() or not archive.stat().st_size:
        raise RuntimeError("original Git archive was not transferred to the host")
    try:
        if hide:
            await runner.checked(f"rm -rf -- {repo}/.git", cwd="/", timeout=600)
        yield
    finally:
        await runner.upload_file(str(archive), remote)
        await runner.checked(
            f"mkdir -p -- {shlex.quote(restore)} && tar -C {shlex.quote(restore)} -xf {shlex.quote(remote)} && "
            f"test -d {shlex.quote(restore)}/.git && rm -rf -- {repo}/.git && "
            f"mv -- {shlex.quote(restore)}/.git {repo}/.git",
            cwd="/", timeout=600,
        )
        await runner.checked(f"git -C {repo} rev-parse --is-inside-work-tree", cwd="/")
        await runner.checked(f"rm -rf -- {shlex.quote(restore)} {shlex.quote(remote)}", cwd="/")
        archive.unlink()


async def save_patch(runner: TaskWorkspace, logs_dir: Path) -> None:
    """Include newly created files without changing the verifier's Git index."""
    index = f"/tmp/swe-pro-index-{uuid.uuid4().hex}"
    prefix = f"GIT_INDEX_FILE={shlex.quote(index)} git"
    try:
        await runner.checked(f"{prefix} read-tree HEAD && {prefix} add -A", timeout=120)
        patch = await runner.checked(f"{prefix} diff --cached --binary HEAD", timeout=120)
        (logs_dir / "solution.patch").write_text(patch, encoding="utf-8")
    finally:
        await runner.exec(f"rm -f -- {shlex.quote(index)}")
