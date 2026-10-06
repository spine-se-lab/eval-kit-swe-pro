"""Compare against the immutable pre-refactor implementation, not new expectations."""
import ast
import asyncio
import os
from pathlib import Path
import sys
import pytest
import yaml

ROOT = Path(__file__).parents[1]
OLD = ROOT / 'archives/swe-pro-kit-202608/source/swe_pro_kit'
SOURCE = ROOT / 'plugins/swe-pro-kit/source'
sys.path.insert(0, str(SOURCE / 'package/src'))
from swe_pro_kit.core import prompts
from swe_pro_kit.adapters.chrys.composition import build_decoder_orchestrator_profile, build_orchestrator_profile
from swe_pro_kit.core.configuration import Setting, load_bindings


def legacy_prompts():
    text = (OLD / 'harness/harbor_agent.py').read_text(encoding='utf-8')
    names = {'_NO_CHEAT_CLAUSE', '_FINAL_NOCHEAT_REMINDER', '_nocheat_enabled', '_nocheat_block',
             '_decoder_sample_prompt', '_decoder_aggregate_prompt', '_mapper_stage_prompt',
             '_solver_stage_prompt', '_wrap_instruction_for_sandbox'}
    nodes = []
    for node in ast.parse(text).body:
        name = node.name if isinstance(node, ast.FunctionDef) else node.targets[0].id if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) else ''
        if name in names:
            nodes.append(node)
    namespace = {'os': os, '_lingxi_knowledge_enabled': lambda: False}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'archived-prompts', 'exec'), namespace)
    return namespace


@pytest.mark.parametrize('switch', ['', '0', 'true'], ids=['unset', 'disabled', 'enabled'])
@pytest.mark.parametrize(
    'issue',
    ['issue\nwith XML <tag> and 中文', 'complete evidence; ' * 3000],
    ids=['short', 'long'],
)
def test_stage_inputs_are_byte_identical_to_legacy_with_knowledge_disabled(monkeypatch, switch, issue):
    monkeypatch.setenv('CHRYS_NOCHEAT_CLAUSE', switch)
    old = legacy_prompts()
    workdir = '/task with spaces/repo'
    assert prompts._decoder_sample_prompt(issue, workdir, 1, 3) == old['_decoder_sample_prompt'](issue, workdir, '', '', 1, 3)
    samples = [' <issue_analysis>one</issue_analysis> ', '<issue_analysis>two\nfull</issue_analysis>']
    assert prompts._decoder_aggregate_prompt(issue, workdir, samples) == old['_decoder_aggregate_prompt'](issue, workdir, samples)
    assert prompts._mapper_stage_prompt(issue, workdir, samples[0]) == old['_mapper_stage_prompt'](issue, workdir, samples[0], '', '')
    assert prompts._solver_stage_prompt(issue, workdir, 'full plan\nno truncation') == old['_solver_stage_prompt'](issue, workdir, 'full plan\nno truncation', '')
    assert prompts._wrap_instruction_for_sandbox(issue, workdir=workdir, instance_id='task-1') == old['_wrap_instruction_for_sandbox'](issue, profile='LingxiV2', workdir=workdir, instance_id='task-1')


@pytest.mark.parametrize('old,new', [('LingxiDecoder', 'SWEProDecoder'), ('LingxiDecoderAggregator', 'SWEProAggregator'), ('LingxiMapper', 'SWEProMapper'), ('LingxiSolver', 'SWEProSolver')])
def test_atomic_profiles_preserve_every_field_except_installation_name(old, new):
    before = yaml.safe_load((OLD / f'profiles/{old}.yaml').read_text(encoding='utf-8'))
    after = yaml.safe_load((SOURCE / f'assets/profiles/{new}.yaml').read_text(encoding='utf-8'))
    before['name'] = new
    assert after == before


def test_nested_ensemble_keeps_original_prompt_and_root_keeps_only_authorized_edits():
    binding = load_bindings(SOURCE / 'assets/bindings.json')
    setting = Setting('sub-agent', 3, 'parallel', True)
    old = yaml.safe_load((OLD / 'profiles/LingxiDecoderOrchestrator.yaml').read_text(encoding='utf-8'))
    after = build_decoder_orchestrator_profile(setting, binding)
    for field in ['instructions', 'tools', 'compaction', 'approval']:
        assert after[field] == old[field]
    for count, name in [(1, 'Lingxi'), (3, 'LingxiV2')]:
        old = yaml.safe_load((OLD / f'profiles/{name}.yaml').read_text(encoding='utf-8'))
        after = build_orchestrator_profile(Setting('sub-agent', count, 'parallel', count > 1), binding)
        assert after['tools'] == old['tools']
        assert after['approval'] == old['approval']
        # Only the knowledge sentence is removed; all other text remains.
        if count == 1:
            expected = old['instructions'].replace(' Knowledge search and plan generation are best-effort: use the\ninstalled skills when their data and configuration are available, but never\nmake them a prerequisite for the repair pipeline.', '')
        else:
            expected = old['instructions'].replace('Knowledge search and plan generation are best-effort: use the installed skills\nwhen their data and configuration are available, but never make them a\nprerequisite for the repair pipeline. ', '')
        assert after['instructions'] == expected


def test_worktree_helpers_are_extracted_without_algorithm_changes():
    old = ast.parse((OLD / 'harness/harbor_agent.py').read_text(encoding='utf-8'))
    new = ast.parse((SOURCE / 'package/src/swe_pro_kit/runtime/decoder_workspaces.py').read_text(encoding='utf-8'))
    for name in ['_create_isolated_decoder_workspaces', '_remove_isolated_decoder_workspaces']:
        before = next(n for n in old.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
        after = next(n for n in new.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
        before.args.args[0].annotation = ast.Name(id='TaskWorkspace', ctx=ast.Load())
        assert ast.dump(before) == ast.dump(after)


@pytest.mark.skipif(os.name == "nt", reason="Harbor task paths are POSIX container paths")
def test_real_worktrees_keep_base_ancestry_isolate_mutations_and_restore_gold_for_verifier(tmp_path):
    from test_swe_pro_harbor_runtime import LocalTaskEnvironment, repository, git
    from swe_pro_kit.adapters.harbor.environment import HarborEnvRunner
    from swe_pro_kit.runtime.workspace import isolated_history
    from swe_pro_kit.runtime.decoder_workspaces import decoder_workspaces
    task = repository(tmp_path)
    base = git(task, 'rev-parse', 'HEAD')
    (task / 'code.py').write_text('gold = True\n')
    git(task, 'add', '-A')
    git(task, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'future gold')
    gold = git(task, 'rev-parse', 'HEAD')
    git(task, 'checkout', '--detach', base)
    (task / 'dirty.txt').write_text('pre-existing change')
    logs = tmp_path / 'logs'; logs.mkdir()
    async def run():
        runner = HarborEnvRunner(LocalTaskEnvironment(), default_cwd=str(task))
        async with isolated_history(runner, logs, hide=False):
            async with decoder_workspaces(runner, 3) as paths:
                assert git(task, 'rev-list', '--count', 'HEAD') == '3'  # two ancestors + dirty snapshot
                assert (await runner.exec(f'git cat-file -e {gold}')).return_code != 0
                for path in paths:
                    assert (Path(path) / 'dirty.txt').read_text() == 'pre-existing change'
                (Path(paths[0]) / 'code.py').write_text('private decoder mutation\n')
                assert (task / 'code.py').read_text() == 'value = 1\n'
                assert (Path(paths[1]) / 'code.py').read_text() == 'value = 1\n'
            assert all(not Path(path).exists() for path in paths)
            assert git(task, 'worktree', 'list', '--porcelain').count('worktree ') == 1
        assert git(task, 'rev-parse', 'HEAD') == base
        assert (await runner.exec(f'git cat-file -e {gold}')).return_code == 0
        assert (task / 'dirty.txt').read_text() == 'pre-existing change'
    asyncio.run(run())


@pytest.mark.skipif(os.name == "nt", reason="Chrys task shell integration requires a POSIX host")
def test_restored_decoder_shell_is_available_but_retains_read_only_filter(tmp_path):
    from test_swe_pro_harbor_runtime import LocalTaskEnvironment, supported_host
    supported_host()
    from chrys.service.profiles.agents.loader import load_profile_from_yaml
    from chrys.service.tools.registry import ToolRegistry
    from swe_pro_kit.adapters.harbor.environment import HarborEnvRunner
    from types import SimpleNamespace
    profile = load_profile_from_yaml(SOURCE / 'assets/profiles/SWEProDecoder.yaml')
    async def run():
        registry = ToolRegistry()
        registry.load_builtins(profile.tools.builtins, runtime=SimpleNamespace(cwd=str(tmp_path)),
                               runner=HarborEnvRunner(LocalTaskEnvironment(), default_cwd=str(tmp_path)),
                               shell_filter_config=profile.tools.shell_filter)
        allowed = await registry.get('bash').invoke(arguments={'command': 'pwd', 'reason': 'inspect repository'})
        assert str(tmp_path) in ''.join(part.text or '' for part in allowed)
        blocked = await registry.get('bash').invoke(arguments={'command': 'touch forbidden', 'reason': 'attempt mutation'})
        assert not (tmp_path / 'forbidden').exists()
        assert "command 'touch' not in whitelist" in ''.join(part.text or '' for part in blocked).lower()
    asyncio.run(run())
