"""SWE launch contracts, with isolated checkouts, npm caches and CodeHelix homes.

Never repair executable modes or rebuild the Delivery in these fixtures: doing
either would hide a broken checkout or a stale committed artifact.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    os.name == "nt",
    reason="npx local-directory cache semantics are covered on POSIX CI",
)


ROOT = Path(__file__).parents[1]
PLUGIN_IDS = ("swe-pro-kit",)
COPY_IGNORE = shutil.ignore_patterns(
    "node_modules", ".venv", "__pycache__", "*.pyc", ".DS_Store",
)


@pytest.fixture
def launch_environment(tmp_path: Path) -> dict[str, str]:
    return {
        **os.environ,
        "CODEHELIX_HOME": str(tmp_path / "codehelix-home"),
        "npm_config_cache": str(tmp_path / "npm-cache"),
        "npm_config_update_notifier": "false",
        "PYTHON": sys.executable,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def _copy_package(tmp_path: Path, plugin_id: str, location: str) -> tuple[Path, Path]:
    source = ROOT / "plugins" / plugin_id
    if location == "standalone":
        source = source / "delivery" / ("icode-chrys-0.28" if plugin_id == "swe-pro-kit" else "icode-chrys-0.20")
        package = tmp_path / "standalone delivery"
    else:
        repository = tmp_path / "repository with spaces"
        shutil.copytree(ROOT / "plugin-kit", repository / "plugin-kit", ignore=COPY_IGNORE)
        package = repository / "plugins" / plugin_id
    shutil.copytree(source, package, ignore=COPY_IGNORE)
    return source, package


def _npx(
    package: Path,
    args: list[str],
    environment: dict[str, str],
    *,
    request: str | None = None,
) -> subprocess.CompletedProcess[str]:
    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx") or "npx"
    return subprocess.run(
        [npx, "--yes", str(package), *args],
        cwd=package.parent,
        env=environment,
        input=request,
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


@pytest.mark.parametrize("plugin_id", PLUGIN_IDS)
def test_swe_checkout_entries_are_executable_before_npm_can_repair_them(plugin_id: str) -> None:
    plugin = ROOT / "plugins" / plugin_id
    paths = [plugin / "build-delivery"]
    for package in (plugin, plugin / "source", plugin / "delivery" / ("icode-chrys-0.28" if plugin_id == "swe-pro-kit" else "icode-chrys-0.20")):
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
        for relative in manifest["bin"].values():
            paths.append(package / relative)
    for path in paths:
        assert path.read_bytes().startswith(b"#!"), path
        if os.name != "nt":
            assert stat.S_IMODE(path.stat().st_mode) & 0o111 == 0o111, path


@pytest.mark.parametrize("plugin_id", PLUGIN_IDS)
@pytest.mark.parametrize("location", ("root", "standalone"))
def test_swe_help_with_empty_reused_and_existing_checkout_cache(
    tmp_path: Path, launch_environment: dict[str, str], plugin_id: str, location: str,
) -> None:
    source, package = _copy_package(tmp_path, plugin_id, location)
    for scenario in ("empty-cache", "reused-cache", "new-checkout-existing-cache"):
        if scenario == "new-checkout-existing-cache":
            # npm may chmod a local package on its first visit. Restore the
            # original modes at the same path so a cache hit cannot mask that.
            shutil.rmtree(package)
            shutil.copytree(source, package, ignore=COPY_IGNORE)
        completed = _npx(package, ["--help"], launch_environment)
        assert completed.returncode == 0, (scenario, completed.stderr)
        assert "SWE-Pro Kit" in completed.stdout
        assert "install" in completed.stdout
        if location == "root":
            assert "--agent" in completed.stdout
            assert "--target" in completed.stdout
        else:
            assert "protocol" in completed.stdout


@pytest.mark.parametrize(
    ("payload", "expected_code", "expected_status"),
    (("{", 1, "failed"), ("[]", 1, "failed"), ('{"target": []}', 1, "failed"), ("{}", 2, "blocked")),
)
def test_standalone_swe_protocol_reports_invalid_requests_and_missing_target(
    tmp_path: Path, launch_environment: dict[str, str],
    payload: str, expected_code: int, expected_status: str,
) -> None:
    _source, package = _copy_package(tmp_path, "swe-pro-kit", "standalone")
    completed = _npx(package, ["protocol", "check"], launch_environment, request=payload)
    assert completed.returncode == expected_code, completed.stderr
    result = json.loads(completed.stdout)
    assert result["status"] == expected_status
    assert isinstance(result["message"], str) and result["message"]
    assert result["changes"] == []
    assert isinstance(result["evidence"], list)
    assert not (tmp_path / "codehelix-home").exists()


@pytest.mark.parametrize("plugin_id", PLUGIN_IDS)
def test_swe_root_still_rejects_changed_delivery_content(
    tmp_path: Path, launch_environment: dict[str, str], plugin_id: str,
) -> None:
    _source, package = _copy_package(tmp_path, plugin_id, "root")
    original = _npx(package, ["--help"], launch_environment)
    assert original.returncode == 0, original.stderr
    profile_name = "SWEProDecoder.yaml" if plugin_id == "swe-pro-kit" else "Lingxi.yaml"
    profile = package / "delivery" / ("icode-chrys-0.28" if plugin_id == "swe-pro-kit" else "icode-chrys-0.20") / "assets" / "profiles" / profile_name
    with profile.open("a", encoding="utf-8") as stream:
        stream.write("\n# unintended Delivery edit\n")
    completed = _npx(package, ["--help"], launch_environment)
    assert completed.returncode == 1
    assert "delivery-lock" in completed.stderr
    assert profile_name in completed.stderr
    assert not (tmp_path / "codehelix-home").exists()
