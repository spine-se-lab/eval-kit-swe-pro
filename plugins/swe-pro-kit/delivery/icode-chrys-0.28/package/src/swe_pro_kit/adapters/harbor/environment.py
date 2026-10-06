"""Provider-independent task I/O through the exact Harbor environment."""

from __future__ import annotations

import base64
import math
import posixpath
import re
import shlex
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ExecResult:
    stdout: str
    stderr: str
    return_code: int


def text(value: Any) -> str:
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value or "")


class HarborEnvRunner:
    def __init__(self, environment: Any, *, default_cwd: str = "/app"):
        if not posixpath.isabs(default_cwd):
            raise ValueError("task workdir must be an absolute container path")
        self.environment = environment
        self.default_cwd = default_cwd

    async def download_file(self, source: str, target: str) -> None:
        await self.environment.download_file(source, target)

    async def upload_file(self, source: str, target: str) -> None:
        await self.environment.upload_file(source, target)

    async def exec(self, command: str, *, cwd: str | None = None,
                   env: dict[str, str] | None = None, timeout: float | None = None) -> ExecResult:
        seconds = max(1, math.ceil(timeout)) if timeout is not None else None
        if seconds is not None:
            # Bound the process group inside the task. Killing only Harbor's
            # docker-exec client leaves compilers running in the container.
            command = shlex.join(["timeout", "--signal=TERM", "--kill-after=2s", f"{seconds}s", "/bin/sh", "-c", command])
        try:
            result = await self.environment.exec(
                command, cwd=cwd or self.default_cwd, env=env,
                timeout_sec=seconds + 4 if seconds is not None else None,
                user=getattr(self.environment, "default_user", None),
            )
        except RuntimeError as exc:
            # Harbor Docker 0.7 wraps asyncio.TimeoutError in this exact form.
            # Normalize at the provider seam; unrelated provider errors propagate.
            if re.fullmatch(r"Command timed out after [0-9.]+ seconds", str(exc)):
                raise TimeoutError(str(exc)) from exc
            raise
        if seconds is not None and result.return_code == 124:
            raise TimeoutError(f"task process group exceeded {seconds}s")
        return ExecResult(text(result.stdout), text(result.stderr), int(result.return_code))

    async def checked(self, command: str, *, cwd: str | None = None, timeout: float = 120) -> str:
        result = await self.exec(command, cwd=cwd, timeout=timeout)
        if result.return_code:
            diagnostic = result.stderr or result.stdout  # Docker combines stderr into stdout.
            raise RuntimeError(f"task command failed ({result.return_code}): {diagnostic[-1000:]}")
        return result.stdout

    async def read_bytes(self, path: str) -> bytes:
        encoded = await self.checked(f"base64 -w0 < {shlex.quote(path)}")
        return base64.b64decode(encoded, validate=True)

    async def exists(self, path: str) -> bool:
        result = await self.exec(f"test -e {shlex.quote(path)}")
        if result.return_code not in (0, 1):
            raise OSError(f"failed to inspect task file {path!r}")
        return result.return_code == 0

    async def write_bytes(self, path: str, data: bytes, *, overwrite: bool = True) -> None:
        # noclobber protects the create-only operation against concurrent writers.
        target = f"{path}.swe-pro-{uuid.uuid4().hex}.tmp"
        parent = shlex.quote(posixpath.dirname(path) or ".")
        encoded = shlex.quote(base64.b64encode(data).decode("ascii"))
        install = (f"if [ -f {shlex.quote(path)} ]; then chmod --reference={shlex.quote(path)} {shlex.quote(target)}; fi && "
                   f"mv -f -- {shlex.quote(target)} {shlex.quote(path)}" if overwrite else
                   f"ln -- {shlex.quote(target)} {shlex.quote(path)} && rm -- {shlex.quote(target)}")
        try:
            await self.checked(f"mkdir -p -- {parent} && printf %s {encoded} | base64 -d > {shlex.quote(target)} && {install}")
        finally:
            await self.exec(f"rm -f -- {shlex.quote(target)}")
