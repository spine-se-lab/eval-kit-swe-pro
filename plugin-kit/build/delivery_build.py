"""Shared build-time primitives for pre-generating self-contained deliveries.

Build-time only: these helpers live in the repository checkout and are never
copied into a delivery. Deliveries stay self-contained on their own.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from fnmatch import fnmatch
from collections.abc import Iterable, Mapping
from pathlib import Path


DEFAULT_DIGEST_EXCLUDES: tuple[str, ...] = ("__pycache__", "*.pyc", ".DS_Store")
DEFAULT_COPY_IGNORES: tuple[str, ...] = ("__pycache__", "*.pyc", ".DS_Store")
PLUGIN_SCHEMA = "codehelix.plugin/v1"
TARGET_SCHEMA = "codehelix.plugin_target/v1"
PACKAGE_SCHEMA = "codehelix.plugin_package/v1"


def digest_tree(root: Path, excludes: Iterable[str] = DEFAULT_DIGEST_EXCLUDES) -> str:
    """Return a stable sha256 over every file below ``root``.

    Path names and contents are both folded in, separated by NUL bytes, so a
    rename is as visible as an edit. A file is skipped when any of its path
    parts matches ``excludes``.
    """
    if root.is_symlink():
        raise ValueError(f"Source 不允许符号链接：{root}")
    for item in root.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"Source 不允许符号链接：{item.relative_to(root)}")
    excluded = tuple(excludes)
    value = hashlib.sha256()
    # Sort by the POSIX relative path string, exactly as `plugin-kit/model/plugin.js`
    # does when `npx . validate` recomputes this digest. Sorting `Path` objects
    # compares path parts instead and orders `package/…` before `package.json`,
    # which the validator would then reject as a Source drift.
    for file in sorted(
        (
            item
            for item in root.rglob("*")
            if item.is_file() and not any(fnmatch(part, pattern) for part in item.parts for pattern in excluded)
        ),
        key=lambda item: item.relative_to(root).as_posix(),
    ):
        value.update(file.relative_to(root).as_posix().encode())
        value.update(b"\0")
        value.update(file.read_bytes())
        value.update(b"\0")
    return value.hexdigest()


def copytree(
    source: Path,
    destination: Path,
    ignores: Iterable[str] = DEFAULT_COPY_IGNORES,
) -> None:
    """Copy a tree into a delivery, dropping build residue."""
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns(*ignores))


def write_locks(destination: Path, source_lock: Mapping[str, object]) -> None:
    """Write ``source-lock.json`` then ``delivery-lock.json`` into a delivery.

    Order matters: the delivery lock digests every file in the delivery, the
    freshly written source lock included.
    """
    if destination.is_symlink():
        raise ValueError(f"Delivery 不允许符号链接：{destination}")
    for item in destination.rglob("*"):
        if item.is_symlink():
            raise ValueError(f"Delivery 不允许符号链接：{item.relative_to(destination)}")
    (destination / "source-lock.json").write_bytes(
        (json.dumps(source_lock, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )
    files = {
        file.relative_to(destination).as_posix(): hashlib.sha256(file.read_bytes()).hexdigest()
        for file in sorted(item for item in destination.rglob("*") if item.is_file() and item != destination / "delivery-lock.json" and not any(fnmatch(part, pattern) for part in item.relative_to(destination).parts for pattern in DEFAULT_DIGEST_EXCLUDES))
    }
    (destination / "delivery-lock.json").write_bytes(
        (
            json.dumps(
                {"schema": "codehelix.delivery_lock/v1", "files": files},
                indent=2,
            )
            + "\n"
        ).encode("utf-8")
    )


def write_declared_manifest(
    plugin_root: Path,
    target_declaration: str | Path,
    destination: Path,
) -> None:
    """Compile Plugin identity plus one target declaration into a Package manifest."""
    plugin_root = plugin_root.resolve()
    descriptor = json.loads((plugin_root / "codehelix-plugin.json").read_text(encoding="utf-8"))
    if descriptor.get("schema") != PLUGIN_SCHEMA:
        raise ValueError(f"Plugin descriptor schema must be {PLUGIN_SCHEMA}")

    declaration_path = Path(target_declaration)
    if not declaration_path.is_absolute():
        declaration_path = plugin_root / declaration_path
    declaration_path = declaration_path.resolve()
    if plugin_root not in declaration_path.parents:
        raise ValueError("target declaration must stay inside the Plugin root")
    relative = declaration_path.relative_to(plugin_root).as_posix()
    if relative not in descriptor.get("targets", []):
        raise ValueError(f"target declaration is not listed by the Plugin descriptor: {relative}")
    target = json.loads(declaration_path.read_text(encoding="utf-8"))
    if target.get("schema") != TARGET_SCHEMA:
        raise ValueError(f"target declaration schema must be {TARGET_SCHEMA}")
    if "plugin" in target:
        raise ValueError("target declaration must not repeat Plugin identity")
    profile = target.get("profile")
    if not isinstance(profile, str) or not profile:
        raise ValueError("target declaration requires a profile")
    if destination.resolve() != (plugin_root / "delivery" / profile).resolve():
        raise ValueError(f"target profile {profile} must build to delivery/{profile}")

    package_fields = {key: value for key, value in target.items() if key not in {"schema", "profile"}}
    manifest = {
        "schema": PACKAGE_SCHEMA,
        "plugin": descriptor["plugin"],
        **package_fields,
    }
    (destination / "codehelix-plugin.json").write_bytes(
        (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    )


def build_declared_delivery(
    plugin_root: Path,
    target_declaration: str | Path,
    source: Path,
    source_lock: Mapping[str, object],
) -> Path:
    """Copy contributor-owned target assets and compile a Delivery manifest.

    This is deliberately a packaging primitive, not a target adapter. The
    contributor supplies the installer and target-specific assets in ``source``;
    the kit only combines the Plugin identity with the declared target contract
    and writes reproducibility locks.
    """
    plugin_root = plugin_root.resolve()
    declaration_path = Path(target_declaration)
    if not declaration_path.is_absolute():
        declaration_path = plugin_root / declaration_path
    declaration_path = declaration_path.resolve()
    if plugin_root not in declaration_path.parents:
        raise ValueError("target declaration must stay inside the Plugin root")
    target = json.loads(declaration_path.read_text(encoding="utf-8"))
    if target.get("schema") != TARGET_SCHEMA:
        raise ValueError(f"target declaration schema must be {TARGET_SCHEMA}")
    if "plugin" in target:
        raise ValueError("target declaration must not repeat Plugin identity")
    profile = target.get("profile")
    if not isinstance(profile, str) or not profile:
        raise ValueError("target declaration requires a profile")

    if (source / "codehelix-plugin.json").exists():
        raise ValueError("Source must not maintain a complete codehelix-plugin.json; use a target declaration")

    destination = plugin_root / "delivery" / profile
    if destination.exists():
        shutil.rmtree(destination)
    copytree(source, destination)

    write_declared_manifest(plugin_root, target_declaration, destination)
    generated_source_lock = {**source_lock, "source_tree_sha256": digest_tree(source)}
    write_locks(destination, generated_source_lock)
    return destination
