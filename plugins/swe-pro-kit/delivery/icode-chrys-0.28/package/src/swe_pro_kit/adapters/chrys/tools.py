"""Task tools for the Chrys adapter; never fall back to host filesystem or shell."""

from __future__ import annotations

import posixpath
import shlex
import json
from pathlib import Path
from typing import Annotated, Any

from chrys.service.tools.kinds import KIND_FILESYSTEM_READ, KIND_FILESYSTEM_WRITE, KIND_SHELL, tool
from chrys.service.tools.result_metadata import tool_error


def _bounded(value: str, max_tokens: int) -> str:
    from chrys.foundation.text.tokenizer import MixedLanguageTokenizer

    budget = max(100, min(max_tokens, 32000))
    tokenizer = MixedLanguageTokenizer()
    if tokenizer.count_tokens(value) <= budget:
        return value
    low, high = 0, len(value)
    while low < high:
        mid = (low + high + 1) // 2
        if tokenizer.count_tokens(value[:mid]) <= budget:
            low = mid
        else:
            high = mid - 1
    return value[:low] + "\n[Output truncated; narrow the command or requested line range.]"


class TaskTools:
    def __init__(self, runtime: Any, runner: Any, shell_filter: Any = None):
        self.cwd, self.runner, self.shell_filter = runtime.cwd, runner, shell_filter

    def path(self, path: str) -> str:
        if path.startswith("~"):
            raise ValueError("use an absolute task path, not a host home-directory alias")
        return posixpath.normpath(path if posixpath.isabs(path) else posixpath.join(self.cwd, path))

    async def _search_fallback(self, **request):
        code = Path(__file__).with_name("task_search.py").read_text(
            encoding="utf-8"
        )
        result = await self.runner.exec(shlex.join(["python3", "-c", code, json.dumps(request)]), timeout=30)
        if result.return_code != 0:
            return tool_error("search_failed", "task search requires ripgrep or python3; " + result.stderr[:400])
        return "[python3 search fallback: Python regex, matching lines only]\n" + _bounded(result.stdout or "No matches", 8000)

    @tool(kind=KIND_SHELL)
    async def bash(self, command: Annotated[str, "Bash command inside the evaluation task."],
                   reason: Annotated[str, "Purpose of the command."], timeout: int = 30,
                   working_dir: str | None = None, max_tokens: int = 8000) -> str:
        """Run a noninteractive command inside the task environment."""
        if self.shell_filter is not None:
            decision = self.shell_filter.validate(command)
            if not decision.allowed:
                return tool_error("command_blocked", decision.reason)
        try:
            result = await self.runner.exec(command, cwd=self.path(working_dir or "."), timeout=max(1, timeout))
        except TimeoutError:
            return tool_error("command_timeout", f"task command exceeded {timeout}s; inspect whether it is still running before retrying with a larger explicit timeout")
        return _bounded(f"{result.stdout}\n{result.stderr}\n[exit_code: {result.return_code}]", max_tokens)

    @tool(kind=KIND_FILESYSTEM_READ)
    async def read_file(self, path: str, max_tokens: int = 5000, line_range: list[int] | None = None) -> str:
        """Read a task file with one-based line numbers; end=-1 reads to EOF."""
        resolved = self.path(path)
        try:
            content = (await self.runner.read_bytes(resolved)).decode("utf-8", errors="replace")
        except (RuntimeError, OSError) as exc:
            return tool_error("read_failed", f"cannot read task file {resolved}: {exc}")
        lines = content.splitlines()
        start, end = 1, len(lines)
        if line_range is not None:
            if (len(line_range) != 2 or any(type(v) is not int for v in line_range)
                    or line_range[0] < 1 or (line_range[1] != -1 and line_range[1] < line_range[0])):
                return tool_error("invalid_line_range", "expected [start >= 1, end >= start or -1]")
            start, end = line_range
            end = len(lines) if end == -1 else min(end, len(lines))
        return _bounded(f"File: {resolved} ({len(lines)} lines)\n" +
                        "\n".join(f"{i}|{lines[i-1]}" for i in range(start, end + 1)), max_tokens)

    @tool(kind=KIND_FILESYSTEM_WRITE)
    async def write_file(self, path: str, content: str, overwrite: bool = False) -> str:
        """Write a task file; overwrite must be explicit for existing files."""
        resolved = self.path(path)
        if not overwrite and await self.runner.exists(resolved):
            return tool_error("file_exists", "use overwrite=true to replace an existing task file")
        await self.runner.write_bytes(resolved, content.encode("utf-8"), overwrite=overwrite)
        return f"Written {len(content)} characters to {resolved}"

    @tool(kind=KIND_FILESYSTEM_WRITE)
    async def edit_file(self, path: str, old_string: str, new_string: str, replace_all: bool = False) -> str:
        """Replace an exact match in a task file; ambiguous matches require replace_all."""
        resolved = self.path(path)
        content = (await self.runner.read_bytes(resolved)).decode("utf-8")
        if not old_string or old_string == new_string:
            return tool_error("invalid_edit", "old_string must be nonempty and different from new_string")
        count = content.count(old_string)
        if count == 0 or (count > 1 and not replace_all):
            return tool_error("ambiguous_edit", f"found {count} occurrences; provide a unique match")
        await self.runner.write_bytes(resolved, content.replace(old_string, new_string, -1 if replace_all else 1).encode())
        return f"Edited {resolved}"

    @tool(kind=KIND_FILESYSTEM_READ)
    async def grep(self, pattern: str, path: str = ".", glob: str | None = None,
                   context_lines: int = 2, max_results: int = 100) -> str:
        """Search task files using ripgrep; excludes Git metadata."""
        args = ["rg", "-n", "--no-heading", "--no-messages", "--glob", "!.git/**",
                "-C", str(max(0, min(context_lines, 20))), "-m", str(max(1, min(max_results, 100))), "-e", pattern]
        if glob:
            args.extend(["--glob", glob])
        args.extend(["--", self.path(path)])
        result = await self.runner.exec(shlex.join(args), timeout=30)
        if result.return_code == 127:
            return await self._search_fallback(mode="grep", pattern=pattern, path=self.path(path), glob=glob,
                                               max_results=max_results)
        if result.return_code not in (0, 1):
            return tool_error("search_failed", result.stderr or "task ripgrep failed")
        return _bounded(result.stdout or "No matches", 8000)

    @tool(kind=KIND_FILESYSTEM_READ)
    async def glob(self, pattern: str, path: str = ".", max_results: int = 100) -> str:
        """List matching task files using ripgrep."""
        result = await self.runner.exec(shlex.join(["rg", "--files", "--glob", "!.git/**", "--glob", pattern,
                                                   "--", self.path(path)]), timeout=30)
        if result.return_code == 127:
            return await self._search_fallback(mode="glob", pattern=pattern, path=self.path(path), max_results=max_results)
        if result.return_code not in (0, 1):
            return tool_error("search_failed", result.stderr or "task ripgrep failed")
        return "\n".join(result.stdout.splitlines()[:max(1, min(max_results, 100))]) or "No matches"


def load_remote_tools(registry: Any, categories: list[str], runtime: Any, runner: Any,
                      shell_filter_config: Any) -> list[Any]:
    from chrys.service.tools.registry import _build_shell_filter

    if runtime is None:
        raise ValueError("task tools require a Chrys runtime")
    tools = TaskTools(runtime, runner, _build_shell_filter(shell_filter_config))
    allowed = {"shell": [tools.bash], "filesystem.read": [tools.read_file],
               "filesystem.write": [tools.write_file, tools.edit_file], "search": [tools.grep, tools.glob]}
    loaded = []
    for category in categories:
        if category not in allowed:
            raise ValueError(f"built-in {category!r} has no task-environment adapter")
        for item in allowed[category]:
            registry.register(item, category=category)
            loaded.append(item)
    return loaded
