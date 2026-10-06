"""Validate the exact Chrys 0.28 seams supported by this distribution."""
import hashlib
import inspect
import json
from pathlib import Path
from ...runtime.distribution import distribution_root


def verify_host() -> str:
    """Match actual patched files and the Chrys 0.28 task-runner seam."""
    import chrys
    target = Path(chrys.__file__).resolve().parents[2]
    adapter = "icode-chrys-0.28"
    manifest = distribution_root() / "adapters/chrys" / adapter / "manifest.json"
    mismatches = []
    for relative, hashes in json.loads(manifest.read_text())["files"].items():
        path = target / relative
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != hashes["patched_sha256"]:
            mismatches.append(relative)
    if mismatches:
        raise RuntimeError("unsupported or drifted Chrys adapter files: " + ", ".join(mismatches))
    from chrys.orchestration.engine.assembly import assemble_agent_engine
    parameters = inspect.signature(assemble_agent_engine).parameters
    if "runner" not in parameters or "mcp_stdio_cwd" not in parameters:
        raise RuntimeError("Chrys engine assembly has no task runner/MCP cwd binding")
    return adapter
