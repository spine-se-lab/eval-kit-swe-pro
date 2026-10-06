"""Execute task I/O, Git recovery and the actual supported Chrys engine offline.

The host integration cases run when a patched Chrys 0.28 and Harbor are on
PYTHONPATH. They use Chrys's scriptable MockChatClient, never a real provider.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace

import pytest


pytestmark = pytest.mark.skipif(
    os.name == "nt",
    reason="Harbor task-runtime tests require POSIX container paths and /bin/sh",
)


SOURCE = Path(__file__).parents[1] / "plugins/swe-pro-kit/source"
sys.path.insert(0, str(SOURCE / "package/src"))
from swe_pro_kit.adapters.harbor.environment import HarborEnvRunner
from swe_pro_kit.runtime.workspace import isolated_history, save_patch
from swe_pro_kit.adapters.chrys.engine import update_session_usage
from swe_pro_kit.core.configuration import load_setting


class LocalTaskEnvironment:
    """Execute in a disposable task directory through Harbor's I/O contract."""
    default_user = None

    def __init__(self):
        self.commands = []

    async def exec(self, command, *, cwd, env, timeout_sec, user):
        self.commands.append((command, cwd, timeout_sec, user))
        process = await asyncio.create_subprocess_exec(
            "/bin/sh", "-c", command, cwd=cwd, env={**os.environ, **(env or {})},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout_sec)
        except BaseException:
            process.kill()
            await process.wait()
            raise
        return SimpleNamespace(stdout=stdout, stderr=stderr, return_code=process.returncode)

    async def download_file(self, source, target):
        shutil.copyfile(source, target)

    async def upload_file(self, source, target):
        shutil.copyfile(source, target)


def git(task, *args):
    return subprocess.check_output(["git", "-C", str(task), *args], text=True).strip()


def repository(tmp_path):
    task = tmp_path.resolve() / "task"
    task.mkdir()
    git(task, "init", "-q")
    git(task, "config", "user.name", "Fixture")
    git(task, "config", "user.email", "fixture@example.test")
    (task / "code.py").write_text("value = 1\n")
    git(task, "add", "code.py")
    git(task, "-c", "commit.gpgsign=false", "commit", "-qm", "original")
    git(task, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "hidden historical record")
    return task


def test_runner_binary_roundtrip_create_only_and_timeout_rounding(tmp_path):
    async def run():
        environment = LocalTaskEnvironment()
        runner = HarborEnvRunner(environment, default_cwd=str(tmp_path))
        path = str(tmp_path / "quotes ' and spaces.bin")
        contents = b"\x00\xff\nnew data"
        await runner.write_bytes(path, contents, overwrite=False)
        assert await runner.read_bytes(path) == contents
        Path(path).chmod(0o755)
        await runner.write_bytes(path, contents + b"changed", overwrite=True)
        assert Path(path).stat().st_mode & 0o777 == 0o755
        with pytest.raises(RuntimeError):
            await runner.write_bytes(path, b"must not replace", overwrite=False)
        assert await runner.read_bytes(path) == contents + b"changed"
        await runner.exec("printf ok", timeout=0.25)
        assert environment.commands[-1][2] == 5
        assert not list(tmp_path.glob("*.tmp"))
    asyncio.run(run())


@pytest.mark.parametrize("failure", [False, True])
def test_history_is_hidden_and_restored_with_untracked_patch_on_failure(tmp_path, failure):
    task = repository(tmp_path)
    original_head, original_index = git(task, "rev-parse", "HEAD"), (task / ".git/index").read_bytes()
    logs = tmp_path.resolve() / "logs"
    logs.mkdir()

    async def run():
        runner = HarborEnvRunner(LocalTaskEnvironment(), default_cwd=str(task))
        try:
            async with isolated_history(runner, logs):
                assert not (task / ".git").exists()
                assert (logs / "original-git-recovery.tar").is_file()
                (task / "code.py").write_text("value = 2\n")
                (task / "new.py").write_text("created = True\n")
                if failure:
                    raise RuntimeError("synthetic model failure")
        except RuntimeError as exc:
            assert failure and str(exc) == "synthetic model failure"
        assert git(task, "rev-parse", "HEAD") == original_head
        assert (task / ".git/index").read_bytes() == original_index
        await save_patch(runner, logs)
        patch = (logs / "solution.patch").read_text()
        assert "+value = 2" in patch and "+created = True" in patch
        assert (task / ".git/index").read_bytes() == original_index
        assert not (logs / "original-git-recovery.tar").exists()
    asyncio.run(run())


def test_session_usage_is_not_double_counted_across_interleaved_sources():
    totals = {"input": 0, "output": 0, "cache": 0}
    for source, value in [('parent', 10), ('child-one', 30), ('child-two', 60), ('parent', 70), ('child-one', 60)]:
        update_session_usage(totals, SimpleNamespace(usage_source_id=source, total_session_input_tokens=value,
                             total_session_output_tokens=value // 10, total_session_cache_hit_tokens=value // 5))
    assert totals == {"input": 70, "output": 7, "cache": 14}


def supported_host():
    pytest.importorskip("chrys")
    pytest.importorskip("harbor")
    from swe_pro_kit.adapters.chrys.compatibility import verify_host
    verify_host()


def model_config(tmp_path, monkeypatch):
    root = tmp_path.resolve() / "config"
    (root / "models").mkdir(parents=True)
    (root / "models/fixture.yaml").write_text(json.dumps({
        "id": "fixture", "name": "Fixture", "provider": "mock", "model_id": "scripted-fixture",
        "api_key": "unusable-historical-yaml-key",
    }))
    monkeypatch.setenv("SWE_PRO_MODEL_PROFILE", "fixture")
    monkeypatch.setenv("SWE_PRO_API_KEY", "runtime-fixture-key")
    return root


def test_actual_chrys_tool_registry_routes_every_builtin_into_task(tmp_path):
    supported_host()
    from chrys.service.tools.registry import ToolRegistry

    async def run():
        environment = LocalTaskEnvironment()
        runner = HarborEnvRunner(environment, default_cwd=str(tmp_path))
        registry = ToolRegistry()
        registry.load_builtins(["shell", "filesystem.read", "filesystem.write", "search"],
                               runtime=SimpleNamespace(cwd=str(tmp_path)), runner=runner)
        async def invoke(name, **arguments):
            result = await registry.get(name).invoke(arguments=arguments)
            return "".join(part.text or "" for part in result)
        await invoke("write_file", path="code.py", content="needle = 1\n")
        assert "needle = 1" in await invoke("read_file", path="code.py")
        assert "overwrite=true" in (await invoke("write_file", path="code.py", content="bad")).lower()
        await invoke("edit_file", path="code.py", old_string="1", new_string="2")
        assert "needle = 2" in (tmp_path / "code.py").read_text()
        assert "code.py" in await invoke("grep", pattern="needle")
        assert "code.py" in await invoke("glob", pattern="*.py")
        assert str(tmp_path) in await invoke("bash", command="pwd", reason="verify task cwd")
        assert all(call[1] == str(tmp_path) for call in environment.commands)
        with pytest.raises(ValueError, match="no task-environment adapter"):
            registry.load_builtins(["doc_converter"], runtime=SimpleNamespace(cwd="/app"), runner=runner)
    asyncio.run(run())


@pytest.mark.parametrize("setting_name,count", [("single-decoder", 1), ("three-decoder", 3), ("legacy-workflow", 3), ("three-decoder-icode-workflow", 3)])
def test_actual_harbor_agent_and_chrys_engine_complete_offline_workflow(tmp_path, monkeypatch, setting_name, count):
    supported_host()
    from swe_pro_kit.adapters.harbor.agent import ChrysAgent
    from harbor.agents.base import BaseAgent
    from chrys.service.llm import mock

    task = repository(tmp_path)
    config = model_config(tmp_path, monkeypatch)
    logs = tmp_path.resolve() / "logs"
    original = mock.MockChatClient
    created = []

    class ScriptedClient(original):
        def __init__(self, **kwargs):
            index = len(created)
            created.append(index)
            stages = [[("read_file", "read", {"path": "code.py"})]] * (count + (count > 1)) + [
                     [("write_file", "reproduction", {"path": "reproduction.py", "content": "print(1)\n"}),
                      ("bash", "reproduce", {"command": "python3 reproduction.py", "reason": "reproduce the issue"})],
                     [("write_file", "write", {"path": "code.py", "content": "value = 2\n", "overwrite": True})]]
            calls = stages[index]
            usage = {"input_token_count": 11, "output_token_count": 3, "prompt/cached_tokens": 4}
            super().__init__(responses=[mock.MockResponse(tool_calls=calls, usage_details=usage),
                                        mock.MockResponse(text=f"<issue_analysis>stage {index} complete</issue_analysis>", usage_details=usage)], **kwargs)

    monkeypatch.setattr(mock, "MockChatClient", ScriptedClient)
    agent = ChrysAgent(logs_dir=logs, setting=setting_name, config_root=str(config), workdir=str(task))
    assert isinstance(agent, BaseAgent)
    context = SimpleNamespace()
    environment = LocalTaskEnvironment()
    asyncio.run(agent.run("Change value to 2", environment, context))
    report = json.loads((logs / "baseline-run.json").read_text())
    assert report["status"] == "completed"
    assert [stage["role"] for stage in report["stages"]] == [f"decoder-{i}" for i in range(count)] + (["aggregator"] if count > 1 else []) + ["mapper", "solver"]
    assert (task / "code.py").read_text() == "value = 2\n"
    assert "+value = 2" in (logs / "solution.patch").read_text()
    assert git(task, "rev-list", "--count", "HEAD") == "2"
    assert len(created) == count + (count > 1) + 2
    assert (task / "reproduction.py").read_text() == "print(1)\n"
    assert agent.to_agent_info().model_info.name == 'scripted-fixture'
    assert (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens) == (22 * len(created), 6 * len(created), 8 * len(created))
    if setting_name == "three-decoder-icode-workflow":
        native = json.loads((logs / "native-workflow/run.json").read_text())
        assert native["outcome"] == "completed"
        assert native["run_id"] and native["session_id"]
        completed = [node["node_id"] for node in native["nodes"] if node["state"] == "completed"]
        assert all(role in completed for role in ["decoder-0", "decoder-1", "decoder-2", "aggregator", "mapper", "solver"])
        assert native["usage"] == report["usage"]
        private_cwds = {
            path for command, *_ in environment.commands
            for path in re.findall(r"/tmp/chrys_decoder_workspaces/[^\s'\"]+/decoder_\d+", command)
        }
        assert len(private_cwds) == 3
        assert all(not Path(cwd).exists() for cwd in private_cwds)
    for file in logs.rglob("*"):
        if file.is_file():
            assert b"runtime-fixture-key" not in file.read_bytes()
            assert b"unusable-historical-yaml-key" not in file.read_bytes()


def test_actual_host_ambient_skills_are_not_loaded(tmp_path):
    supported_host()
    from chrys.service.profiles.agents.schema import SkillsConfig
    from chrys.service.skills.adapter import create_skills_provider, _collect_skill_paths

    config = SkillsConfig(paths=[str(tmp_path)])
    assert _collect_skill_paths(config, include_ambient=False) == [str(tmp_path.resolve())]
    assert asyncio.run(create_skills_provider(SkillsConfig(), include_ambient=False)) == (None, [])


@pytest.mark.parametrize("setting_name", ["sub-agent", "sub-agent-serial"])
def test_actual_subagents_inherit_task_runner_and_follow_setting(tmp_path, monkeypatch, setting_name):
    supported_host()
    from swe_pro_kit.adapters.harbor.agent import ChrysAgent
    from chrys.service.llm import mock

    task = repository(tmp_path)
    config = model_config(tmp_path, monkeypatch)
    logs = tmp_path.resolve() / "logs"
    original = mock.MockChatClient
    created = []

    class ScriptedClient(original):
        def __init__(self, **kwargs):
            index = len(created)
            created.append(index)
            if index == 0:
                responses = [mock.MockResponse(tool_calls=[(role, f"call-{role}", {"prompt": "Consume previous stage results"})])
                             for role in ("problem_decoder", "solution_mapper", "problem_solver")]
                responses += [mock.MockResponse(text="pipeline complete")]
            elif index == 1:
                decoders = [(f"decoder_{i}", f"call-decoder-{i}", {"prompt": "Analyze the supplied task"}) for i in range(3)]
                responses = ([mock.MockResponse(tool_calls=decoders)] if setting_name == "sub-agent" else
                             [mock.MockResponse(tool_calls=[call]) for call in decoders])
                responses += [mock.MockResponse(tool_calls=[("aggregator", "aggregate", {"prompt": "Reconcile complete analyses"})]),
                              mock.MockResponse(text="<reflection>checked</reflection><issue_analysis>ensemble result</issue_analysis>")]
            else:
                calls = ([('write_file', 'write-task', {'path': 'code.py', 'content': 'value = 3\n', 'overwrite': True})]
                         if index == 7 else [('read_file', f'read-{index}', {'path': 'code.py'})])
                responses = [mock.MockResponse(tool_calls=calls, delay=0.01), mock.MockResponse(text=f"child {index} complete")]
            for response in responses:
                response.usage_details = {"input_token_count": 11, "output_token_count": 3, "prompt/cached_tokens": 4}
            super().__init__(responses=responses, **kwargs)

    monkeypatch.setattr(mock, "MockChatClient", ScriptedClient)
    agent = ChrysAgent(logs_dir=logs, setting=setting_name, config_root=str(config), workdir=str(task))
    context = SimpleNamespace()
    asyncio.run(agent.run("Change value to 3", LocalTaskEnvironment(), context))
    assert len(created) == 8
    assert (task / 'code.py').read_text() == 'value = 3\n'
    report = json.loads((logs / "baseline-run.json").read_text())
    assert report['status'] == 'completed'
    assert report['final_output'] == 'pipeline complete'
    trace = json.loads((logs / 'stages/orchestrator/trace.json').read_text())
    started = [event['tool'] for event in trace['tools'] if event['event'] == 'start']
    for tool in ['problem_decoder', 'solution_mapper', 'problem_solver', 'decoder_0', 'decoder_1', 'decoder_2', 'aggregator']:
        assert tool in started
    assert started.index('problem_decoder') < started.index('decoder_0') < started.index('aggregator') < started.index('solution_mapper') < started.index('problem_solver')
    totals = trace['session_totals']
    assert (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens) == (
        totals['input'], totals['output'], totals['cache'])
    calls = 19 if setting_name == 'sub-agent' else 21
    assert totals == {'input': 11 * calls, 'output': 3 * calls, 'cache': 4 * calls}


def test_search_falls_back_to_task_python_when_ripgrep_is_missing(tmp_path):
    supported_host()
    from chrys.service.tools.registry import ToolRegistry

    class NoRipgrep(LocalTaskEnvironment):
        async def exec(self, command, **kwargs):
            if 'rg --files' in command or 'rg -n' in command:
                return SimpleNamespace(stdout='', stderr='rg: command not found', return_code=127)
            return await super().exec(command, **kwargs)

    async def run():
        (tmp_path / 'test.py').write_text('needle = 9\n')
        registry = ToolRegistry()
        registry.load_builtins(['search'], runtime=SimpleNamespace(cwd=str(tmp_path)),
                               runner=HarborEnvRunner(NoRipgrep(), default_cwd=str(tmp_path)))
        for name, arguments in [('grep', {'pattern': 'needle'}), ('glob', {'pattern': '*.py'})]:
            result = await registry.get(name).invoke(arguments=arguments)
            output = ''.join(part.text or '' for part in result)
            assert 'python3 search fallback' in output and 'test.py' in output
    asyncio.run(run())


def test_failed_stage_keeps_spent_tokens_and_restores_history(tmp_path, monkeypatch):
    supported_host()
    from swe_pro_kit.adapters.harbor.agent import ChrysAgent
    from swe_pro_kit.adapters.chrys.engine import ChrysStageRunner
    from swe_pro_kit.core.execution import StageFailure
    from chrys.service.llm import mock

    task = repository(tmp_path)
    config = model_config(tmp_path, monkeypatch)
    logs = tmp_path.resolve() / "logs"
    original_client = mock.MockChatClient
    original_stage = ChrysStageRunner.__call__

    class ScriptedClient(original_client):
        def __init__(self, **kwargs):
            super().__init__(responses=[mock.MockResponse(text="partial stage result", usage_details={
                "input_token_count": 11, "output_token_count": 3, "prompt/cached_tokens": 4})], **kwargs)

    async def fail_after_completion(self, **kwargs):
        output = await original_stage(self, **kwargs)
        if kwargs['role'] == 'mapper':
            raise RuntimeError('synthetic output-validation failure')
        return output

    monkeypatch.setattr(mock, 'MockChatClient', ScriptedClient)
    monkeypatch.setattr(ChrysStageRunner, '__call__', fail_after_completion)
    agent = ChrysAgent(logs_dir=logs, setting='single-decoder', config_root=str(config), workdir=str(task))
    context = SimpleNamespace()
    with pytest.raises(StageFailure, match='mapper execution failed'):
        asyncio.run(agent.run('Task with failing mapper', LocalTaskEnvironment(), context))
    assert (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens) == (22, 6, 8)
    assert git(task, 'rev-list', '--count', 'HEAD') == '2'
    report = json.loads((logs / 'baseline-run.json').read_text())
    assert report['status'] == 'failed' and report['usage'] == {'input': 22, 'output': 6, 'cache': 8}
    assert report['failed_stage'] == 'mapper'


def test_native_failed_decoder_cancels_siblings_and_restores_git(tmp_path, monkeypatch):
    supported_host()
    from swe_pro_kit.adapters.harbor.agent import ChrysAgent
    from swe_pro_kit.core.contracts import StageFailure
    from chrys.service.llm import mock

    task = repository(tmp_path)
    config = model_config(tmp_path, monkeypatch)
    logs = tmp_path.resolve() / "logs"
    original = mock.MockChatClient
    created = []

    class ScriptedClient(original):
        def __init__(self, **kwargs):
            index = len(created)
            created.append(index)
            self.fail_after_read = index == 0
            response = mock.MockResponse(
                text="" if index == 0 else "sibling analysis",
                tool_calls=[("read_file", "read", {"path": "code.py"})] if index == 0 else [],
                delay=0.1 if index == 0 else 20,
                usage_details={"input_token_count": 11, "output_token_count": 3, "prompt/cached_tokens": 4},
            )
            super().__init__(responses=[response], **kwargs)

        def _next_response(self):
            if self.fail_after_read and self._call_index:
                raise ValueError("synthetic non-transient provider failure")
            return super()._next_response()

    monkeypatch.setattr(mock, "MockChatClient", ScriptedClient)
    agent = ChrysAgent(logs_dir=logs, setting="three-decoder-icode-workflow", config_root=str(config), workdir=str(task))
    context = SimpleNamespace()
    with pytest.raises(StageFailure):
        asyncio.run(agent.run("Fail a decoder", LocalTaskEnvironment(), context))
    record = json.loads((logs / "baseline-run.json").read_text())
    native = json.loads((logs / "native-workflow/run.json").read_text())
    assert record["status"] == "failed" and record["failed_stage"].startswith("decoder-")
    assert len(created) == 3
    assert not any(node["node_id"] == "aggregator" and node["state"] == "running" for node in native["nodes"])
    assert any(node["state"] == "cancelled" for node in native["nodes"])
    assert (context.n_input_tokens, context.n_output_tokens, context.n_cache_tokens) == (11, 3, 4)
    assert git(task, "rev-list", "--count", "HEAD") == "2"
    assert len(git(task, "worktree", "list").splitlines()) == 1


def test_harbor_timeout_is_normalized_but_unrelated_provider_errors_are_not():
    class Provider:
        failure = 'Command timed out after 30 seconds'
        async def exec(self, command, **kwargs):
            raise RuntimeError(self.failure)

    async def run():
        provider = Provider()
        runner = HarborEnvRunner(provider)
        with pytest.raises(TimeoutError, match='30 seconds'):
            await runner.exec('noop', timeout=30)
        provider.failure = 'container unavailable'
        with pytest.raises(RuntimeError, match='container unavailable'):
            await runner.exec('noop', timeout=30)
    asyncio.run(run())


def test_actual_tools_report_missing_files_and_wrapped_provider_timeouts(tmp_path):
    supported_host()
    from chrys.service.tools.registry import ToolRegistry

    class Provider(LocalTaskEnvironment):
        async def exec(self, command, **kwargs):
            if 'slow command' in command:
                raise RuntimeError('Command timed out after 30 seconds')
            result = await super().exec(command, **kwargs)
            # Harbor Docker merges stderr into stdout.
            return SimpleNamespace(stdout=result.stdout + result.stderr, stderr=b'', return_code=result.return_code)

    async def run():
        registry = ToolRegistry()
        registry.load_builtins(['shell', 'filesystem.read'], runtime=SimpleNamespace(cwd=str(tmp_path)),
                               runner=HarborEnvRunner(Provider(), default_cwd=str(tmp_path)))
        result = await registry.get('read_file').invoke(arguments={'path': 'missing.py'})
        message = ''.join(part.text or '' for part in result)
        assert 'missing.py' in message and 'cannot read' in message
        result = await registry.get('bash').invoke(arguments={'command': 'slow command', 'reason': 'test timeout'})
        message = ''.join(part.text or '' for part in result)
        assert 'exceeded 30s' in message and 'larger explicit timeout' in message
    asyncio.run(run())


def test_timeout_stops_task_child_processes(tmp_path):
    async def run():
        runner = HarborEnvRunner(LocalTaskEnvironment(), default_cwd=str(tmp_path))
        with pytest.raises(TimeoutError):
            await runner.exec('(sleep 2; printf orphan > child-output) & wait', timeout=1)
        await asyncio.sleep(1.3)
        assert not (tmp_path / 'child-output').exists()
        assert (await runner.exec('printf recovered', timeout=1)).stdout == 'recovered'
    asyncio.run(run())


@pytest.mark.parametrize('role', ['decoder', 'mapper', 'solver'])
def test_chrys_stage_does_not_wait_for_approval_on_long_shell_command(tmp_path, monkeypatch, role):
    """Real Engine mode and middleware; no model call or shell execution needed."""
    pytest.importorskip('chrys')
    from chrys.foundation.config.settings import Settings
    from chrys.foundation.events.types import ApprovalRequest
    from chrys.kernel.middleware import FunctionInvocationContext
    from chrys.orchestration.engine.engine import AgentEngine
    from chrys.service.agent_middleware.control.approval import ApprovalMiddleware
    from chrys.service.approval.policy import ApprovalPolicy
    from chrys.service.approval.safety_classifier import shell_command_may_access_sensitive_data
    from chrys.service.profiles.agents.loader import load_profile_from_yaml
    from chrys.service.profiles.agents.registry import AgentProfileRegistry
    from chrys.service.profiles.models.registry import ModelProfileRegistry
    from swe_pro_kit.adapters.chrys.engine import ChrysStageRunner

    command = "python3 -c 'pass #" + 'x' * 8732 + "'"
    assert shell_command_may_access_sensitive_data(command, shell_name='bash')
    profile = load_profile_from_yaml(SOURCE / f'assets/profiles/SWEPro{role.title()}.yaml')
    runner = ChrysStageRunner.__new__(ChrysStageRunner)
    runner.host_adapter = "icode-chrys-0.28"
    runner.logs_dir, runner.runner = tmp_path, object()
    runner.settings = Settings(project_hooks_enabled=False)
    runner.registry, runner.models = AgentProfileRegistry(), ModelProfileRegistry()
    runner.registry.register(profile)
    runner.stage_usage = {}
    runner.evaluation = None
    requests, executed = [], []

    async def start(engine, selected):
        async def requested(event): requests.append(event)
        async def call_next(): executed.append(True)
        await engine._bus.subscribe(ApprovalRequest, requested)
        middleware = ApprovalMiddleware(ApprovalPolicy(selected.approval), engine._bus,
                                       approval_mode=engine.approval_mode, tool_kinds={'bash': 'shell'})
        context = FunctionInvocationContext(SimpleNamespace(name='bash'), {'command': command})
        await asyncio.wait_for(middleware.process(context, call_next), timeout=.2)
        state = SimpleNamespace(run_failed=False, was_interrupted=False)
        engine.current.loaded = SimpleNamespace(bindings=SimpleNamespace(state=state))

    async def noop(engine): pass
    monkeypatch.setattr(AgentEngine, 'start', start)
    monkeypatch.setattr(AgentEngine, 'wait_for_run_task', noop)
    monkeypatch.setattr(AgentEngine, 'shutdown', noop)
    result = asyncio.run(runner(profile=profile.name, instruction='Solve the task.', workdir='/app', role=role))
    assert not result.failed
    assert executed == [True] and requests == []
    assert json.loads((tmp_path / 'stages' / role / 'trace.json').read_text())['approval_mode'] == 'bypass'


def test_chrys_028_taskpattern_events_survive_continuation_and_shutdown(tmp_path, monkeypatch):
    """Exercise the merged adapter against real 0.28 event and assembly APIs."""
    pytest.importorskip('chrys')
    from chrys.foundation.events import types as events
    if not hasattr(events, 'InvocationToolCallStart'):
        pytest.skip('requires Chrys 0.28 invocation events')
    from chrys.foundation.config.settings import Settings
    from chrys.foundation.models.invocations import InvocationOrigin
    from chrys.orchestration.engine.engine import AgentEngine
    from chrys.service.profiles.agents.loader import load_profile_from_yaml
    from chrys.service.profiles.agents.registry import AgentProfileRegistry
    from chrys.service.profiles.models.registry import ModelProfileRegistry
    from swe_pro_kit.adapters.chrys.engine import ChrysStageRunner

    profile = load_profile_from_yaml(SOURCE / 'assets/profiles/SWEProDecoder.yaml')
    runner = ChrysStageRunner.__new__(ChrysStageRunner)
    runner.host_adapter = 'icode-chrys-0.28'
    runner.logs_dir, runner.runner = tmp_path, object()
    runner.settings = Settings(project_hooks_enabled=False)
    runner.registry, runner.models = AgentProfileRegistry(), ModelProfileRegistry()
    runner.registry.register(profile)
    runner.stage_usage, runner.taskpattern_events = {}, []
    runner.evaluation = SimpleNamespace(name='taskpattern-evaluation')
    origin = InvocationOrigin(kind='turn', session_id='', invocation_id='fixture-turn', parent=None)
    prompts, closed = [], []

    async def start(engine, selected):
        state = SimpleNamespace(run_failed=False, was_interrupted=False)
        engine.current.loaded = SimpleNamespace(
            bindings=SimpleNamespace(state=state),
            mcp_adapter=SimpleNamespace(failures={}),
        )

        async def respond(event):
            prompts.append(event.text)
            if len(prompts) == 1:
                for action in ('search', 'apply'):
                    args = dict(origin=origin, tool_name=f'taskpattern-{action}', call_id=action)
                    await engine._bus.publish(events.InvocationToolCallStart(**args))
                    result = {'status': 'completed'}
                    if action == 'search':
                        result['knowledge_matches'] = [{'knowledge_id': 'known-fix'}]
                    await engine._bus.publish(events.InvocationToolCallResult(
                        **args, result=json.dumps(result)))
            else:
                await engine._bus.publish(events.InvocationMessage(origin=origin, text='Analysis complete'))
        await engine._bus.subscribe(events.UserMessage, respond)

    async def wait(engine):
        pass

    async def shutdown(engine):
        # The modern host does not accept the old close_mcp_cache keyword.
        closed.append(True)

    monkeypatch.setattr(AgentEngine, 'start', start)
    monkeypatch.setattr(AgentEngine, 'wait_for_run_task', wait)
    monkeypatch.setattr(AgentEngine, 'shutdown', shutdown)
    result = asyncio.run(runner(profile=profile.name, instruction='Analyze the issue',
                                workdir='/app', role='decoder-0'))
    assert not result.failed and result.text == 'Analysis complete'
    assert len(prompts) == 2 and 'taskpattern_stage_continuation' in prompts[1]
    assert closed == [True]
    evidence = json.loads((tmp_path / 'stages/decoder-0/taskpattern-invocations.json').read_text())
    assert [(event['event'], event['id']) for event in evidence['events']] == [
        ('start', 'search'), ('finish', 'search'), ('start', 'apply'), ('finish', 'apply')]
    assert all(event['invocation_id'] == 'fixture-turn' for event in evidence['events'])
    assert len(runner.taskpattern_events) == 4
