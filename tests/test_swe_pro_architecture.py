"""Enforce the plugin's dependency direction and host-independent core interface."""
import ast
from pathlib import Path
import subprocess
import sys

PACKAGE = Path(__file__).parents[1] / 'plugins/swe-pro-kit/source/package/src'


def test_core_has_no_framework_runtime_or_adapter_dependencies():
    for path in (PACKAGE / 'swe_pro_kit/core').glob('*.py'):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert node.level <= 1, (path, node.module)
                names = [node.module or '']
            elif isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            else:
                continue
            assert not any(name.startswith(('chrys', 'harbor', 'swe_pro_kit.adapters', 'swe_pro_kit.runtime')) for name in names), (path, names)


def test_subagent_core_executes_without_loading_a_host_or_rendering_native_profiles():
    code = '''
import asyncio, importlib.abc, sys
class NoHosts(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'chrys','harbor'} or fullname.startswith('swe_pro_kit.adapters'):
            raise RuntimeError('core attempted to load host: ' + fullname)
sys.meta_path.insert(0, NoHosts())
from swe_pro_kit.core.configuration import Setting, Bindings
from swe_pro_kit.core.contracts import Orchestration, StageExecution
from swe_pro_kit.core.execution import execute
setting = Setting('sub-agent', 3, 'parallel', True)
bindings = Bindings('CustomDecoder','Aggregator','Mapper','Solver')
async def alternative_host(**request):
    assert request['profile'] == Orchestration(setting, bindings)
    assert '<issue_description>\\nissue\\n</issue_description>' in request['instruction']
    return StageExecution('alternative host result')
result = asyncio.run(execute(setting, bindings, alternative_host, 'issue', '/app'))
assert result.final_output == 'alternative host result'
'''
    result = subprocess.run([sys.executable, '-I', '-B', '-c', 'import sys; sys.path.insert(0, ' + repr(str(PACKAGE)) + ')\n' + code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr


def test_clean_workflow_does_not_load_historical_scheduler_or_host():
    code = '''
import asyncio, importlib.abc, sys
from contextlib import asynccontextmanager
class NoLegacyOrHost(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'chrys','harbor'} or fullname.endswith('.legacy_workflow'):
            raise RuntimeError('clean workflow attempted to load: ' + fullname)
sys.meta_path.insert(0, NoLegacyOrHost())
from swe_pro_kit.core.configuration import Setting, Bindings
from swe_pro_kit.core.execution import execute
@asynccontextmanager
async def paths():
    yield ['/decoder/0', '/decoder/1', '/decoder/2']
observed = []
async def runner(**call):
    observed.append(call['role'])
    return 'complete output'
result = asyncio.run(execute(Setting('workflow',3,'parallel',True), Bindings('D','A','M','S'),
                             runner, 'issue', '/app', decoder_workspaces=paths()))
assert observed == ['decoder-0','decoder-1','decoder-2','aggregator','mapper','solver']
assert result.final_output == 'complete output'
'''
    result = subprocess.run([sys.executable, '-I', '-B', '-c', 'import sys; sys.path.insert(0, ' + repr(str(PACKAGE)) + ')\n' + code], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
