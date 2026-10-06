"""Historical isolated Decoder worktrees; extracted without changing Git semantics."""
from __future__ import annotations
import contextlib
import hashlib
import logging
import shlex
import uuid
from contextlib import asynccontextmanager
from .workspace import TaskWorkspace
logger = logging.getLogger(__name__)
_DECODER_WORKSPACE_ROOT = "/tmp/chrys_decoder_workspaces"

async def _create_isolated_decoder_workspaces(
    runner: TaskWorkspace,
    *,
    source_dir: str,
    run_key: str,
    count: int,
    base_dir: str = _DECODER_WORKSPACE_ROOT,
    sanitize_history: bool = True,
) -> tuple[str, list[str]]:
    """Create independent decoder worktrees from a gold-free Git repository.

    Decoder stages run concurrently and must never share a mutable repository
    tree.  Harbor images can contain the gold fix as a descendant of the
    checked-out base commit, so merely deleting refs or reflogs is insufficient:
    ``git fsck`` could still recover the unreachable objects.

    When *sanitize_history* is true, this function bundles only ``HEAD`` and
    its ancestors into a fresh object database, snapshots any pre-existing
    working-tree changes as a synthetic commit, replaces the source repository's
    original ``.git`` directory, and deletes that original object database
    before any decoder starts.  Three detached ``git worktree`` checkouts can
    then retain useful pre-base history without exposing descendant commits.

    ``sanitize_history=False`` deliberately keeps the original object database;
    it exists only for ``CHRYS_SCRUB_GIT=0`` leakage-reproduction runs.
    """
    if count < 1:
        raise ValueError("decoder workspace count must be positive")
    normalized_base = base_dir.rstrip("/")
    if not normalized_base.startswith("/") or normalized_base == "":
        raise ValueError("decoder workspace base directory must be an absolute non-root path")

    source = source_dir.rstrip("/") or "/"
    if not source.startswith("/") or source == "/":
        raise ValueError("decoder workspace source must be an absolute non-root path")
    scope = hashlib.sha256(run_key.encode("utf-8")).hexdigest()[:16]
    root = f"{normalized_base}/{scope}"
    quoted_root = shlex.quote(root)
    quoted_source = shlex.quote(source)
    workspaces = [f"{root}/decoder_{index}" for index in range(count)]

    async def _discard_root() -> None:
        with contextlib.suppress(Exception):
            await runner.exec(f"rm -rf -- {quoted_root}", cwd="/", timeout=120)
        with contextlib.suppress(Exception):
            await runner.exec(
                f"git -C {quoted_source} worktree prune --expire now",
                cwd="/",
                timeout=60,
            )

    try:
        source_check = await runner.exec(
            f"test -d {quoted_source} && "
            f"test -d {quoted_source}/.git && "
            f"test ! -L {quoted_source}/.git && "
            f"test ! -e {quoted_source}/.git/commondir && "
            f"test ! -s {quoted_source}/.git/objects/info/alternates",
            cwd="/",
            timeout=30,
        )
        if source_check.return_code != 0:
            raise FileNotFoundError(f"decoder workspace source is not a standalone Git repository: {source}")

        setup = await runner.exec(
            f"rm -rf -- {quoted_root} && mkdir -p -- {quoted_root}",
            cwd="/",
            timeout=120,
        )
        if setup.return_code != 0:
            raise OSError(
                f"failed to prepare decoder workspace root {root} "
                f"(rc={setup.return_code}): {(setup.stderr or setup.stdout).strip()[-512:]}"
            )

        if sanitize_history:
            head_result = await runner.exec(
                f"git -C {quoted_source} rev-parse --verify 'HEAD^{{commit}}'",
                cwd="/",
                timeout=30,
            )
            if head_result.return_code != 0:
                raise OSError(f"failed to resolve decoder baseline HEAD in {source}")
            baseline_head = head_result.stdout.strip().splitlines()[-1]

            bundle = f"{root}/baseline.bundle"
            staging = f"{root}/sanitized"
            bundle_ref = f"refs/heads/chrys-sanitized-{scope}"
            quoted_bundle = shlex.quote(bundle)
            quoted_staging = shlex.quote(staging)
            quoted_ref = shlex.quote(bundle_ref)

            create_ref = await runner.exec(
                f"git -C {quoted_source} update-ref {quoted_ref} {shlex.quote(baseline_head)}",
                cwd="/",
                timeout=30,
            )
            if create_ref.return_code != 0:
                raise OSError("failed to create the temporary sanitized-history ref")
            try:
                create_bundle = await runner.exec(
                    f"git -C {quoted_source} bundle create {quoted_bundle} {quoted_ref}",
                    cwd="/",
                    timeout=600,
                )
            finally:
                await runner.exec(
                    f"git -C {quoted_source} update-ref -d {quoted_ref}",
                    cwd="/",
                    timeout=30,
                )
            if create_bundle.return_code != 0:
                raise OSError(
                    "failed to create sanitized Git bundle "
                    f"(rc={create_bundle.return_code}): "
                    f"{(create_bundle.stderr or create_bundle.stdout).strip()[-512:]}"
                )

            build_sanitized = await runner.exec(
                f"git init -q {quoted_staging} && "
                f"git -C {quoted_staging} fetch -q {quoted_bundle} {quoted_ref} && "
                f"git -C {quoted_staging} checkout -q --detach FETCH_HEAD",
                cwd="/",
                timeout=600,
            )
            if build_sanitized.return_code != 0:
                raise OSError(
                    "failed to construct sanitized Git repository "
                    f"(rc={build_sanitized.return_code}): "
                    f"{(build_sanitized.stderr or build_sanitized.stdout).strip()[-512:]}"
                )

            clear_staging = await runner.exec(
                f"find {quoted_staging} -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {{}} +",
                cwd="/",
                timeout=120,
            )
            if clear_staging.return_code != 0:
                raise OSError("failed to clear the sanitized staging worktree")

            copy_source = await runner.exec(
                f"find {quoted_source} -mindepth 1 -maxdepth 1 ! -name .git "
                f"-exec cp -a --reflink=auto -t {quoted_staging} -- {{}} +",
                cwd="/",
                timeout=600,
            )
            if copy_source.return_code != 0:
                copy_source = await runner.exec(
                    f"tar -C {quoted_source} --exclude=.git --exclude='*/.git' -cf - . | tar -C {quoted_staging} -xf -",
                    cwd="/",
                    timeout=600,
                )
            if copy_source.return_code != 0:
                raise OSError(
                    "failed to snapshot the live source tree into the sanitized repository "
                    f"(rc={copy_source.return_code}): "
                    f"{(copy_source.stderr or copy_source.stdout).strip()[-512:]}"
                )

            nested_scrub = await runner.exec(
                f"find {quoted_staging} -mindepth 2 -name .git -prune -exec rm -rf -- {{}} +",
                cwd="/",
                timeout=120,
            )
            if nested_scrub.return_code != 0:
                raise OSError("failed to remove nested Git metadata from the sanitized repository")

            stage_changes = await runner.exec(
                f"git -C {quoted_staging} add -A && git -C {quoted_staging} diff --cached --quiet --exit-code",
                cwd="/",
                timeout=600,
            )
            if stage_changes.return_code == 1:
                snapshot_commit = await runner.exec(
                    f"git -c core.hooksPath=/dev/null -c commit.gpgSign=false "
                    f"-c user.name=Chrys -c user.email=harbor@chrys.local "
                    f"-C {quoted_staging} commit -q -m 'Chrys decoder baseline snapshot'",
                    cwd="/",
                    timeout=120,
                )
                if snapshot_commit.return_code != 0:
                    raise OSError("failed to commit the live decoder baseline snapshot")
            elif stage_changes.return_code != 0:
                raise OSError("failed to stage the live decoder baseline snapshot")

            integrity = await runner.exec(
                f"test ! -s {quoted_staging}/.git/objects/info/alternates && "
                f"git -C {quoted_staging} fsck --full --no-reflogs --unreachable",
                cwd="/",
                timeout=600,
            )
            integrity_output = (integrity.stdout + "\n" + integrity.stderr).lower()
            if integrity.return_code != 0 or "unreachable " in integrity_output or "dangling " in integrity_output:
                raise OSError(
                    "sanitized Git repository contains unreachable objects; refusing to expose it to decoders"
                )

            original_git = f"{root}/original.git"
            quoted_original_git = shlex.quote(original_git)
            install_sanitized = await runner.exec(
                f"if ! mv {quoted_source}/.git {quoted_original_git}; then exit 1; fi; "
                f"if ! mv {quoted_staging}/.git {quoted_source}/.git; then "
                f"mv {quoted_original_git} {quoted_source}/.git; exit 2; fi; "
                f"rm -rf -- {quoted_original_git} {quoted_bundle} {quoted_staging}",
                cwd="/",
                timeout=600,
            )
            if install_sanitized.return_code != 0:
                raise OSError(
                    "failed to replace the original Git object database with the sanitized one "
                    f"(rc={install_sanitized.return_code})"
                )

            verify_installed = await runner.exec(
                f"test ! -s {quoted_source}/.git/objects/info/alternates && "
                f"git -C {quoted_source} fsck --full --no-reflogs --unreachable",
                cwd="/",
                timeout=600,
            )
            verify_output = (verify_installed.stdout + "\n" + verify_installed.stderr).lower()
            if verify_installed.return_code != 0 or "unreachable " in verify_output or "dangling " in verify_output:
                raise OSError("installed sanitized Git repository failed its reachability audit")
            logger.info(
                "decoder isolation: replaced full Git history at %s with ancestry rooted at %.12s",
                source,
                baseline_head,
            )

        for index, workspace in enumerate(workspaces):
            add_worktree = await runner.exec(
                f"git -C {quoted_source} worktree add -q --detach {shlex.quote(workspace)} HEAD",
                cwd="/",
                timeout=600,
            )
            if add_worktree.return_code != 0:
                raise OSError(
                    f"failed to create decoder worktree {index} "
                    f"(rc={add_worktree.return_code}): "
                    f"{(add_worktree.stderr or add_worktree.stdout).strip()[-512:]}"
                )

        logger.info("decoder isolation: prepared %d workspaces under %s", len(workspaces), root)
        return root, workspaces
    except BaseException:
        await _discard_root()
        raise

async def _remove_isolated_decoder_workspaces(
    runner: TaskWorkspace,
    root: str,
    *,
    source_dir: str,
    workspaces: list[str],
) -> bool:
    """Remove decoder worktrees, prune their Git registrations, and delete their root."""
    success = True
    for workspace in workspaces:
        result = await runner.exec(
            f"git -C {shlex.quote(source_dir)} worktree remove --force {shlex.quote(workspace)}",
            cwd="/",
            timeout=120,
        )
        if result.return_code != 0:
            success = False
            await runner.exec(f"rm -rf -- {shlex.quote(workspace)}", cwd="/", timeout=120)

    prune = await runner.exec(
        f"git -C {shlex.quote(source_dir)} worktree prune --expire now",
        cwd="/",
        timeout=60,
    )
    if prune.return_code != 0:
        success = False

    result = await runner.exec(f"rm -rf -- {shlex.quote(root)}", cwd="/", timeout=120)
    if result.return_code != 0:
        logger.warning(
            "decoder isolation: failed to remove %s (rc=%d): %s",
            root,
            result.return_code,
            (result.stderr or result.stdout).strip()[-512:],
        )
        return False
    return success

@asynccontextmanager
async def decoder_workspaces(runner: TaskWorkspace, count: int, *, sanitize_history: bool = True):
    root, paths = await _create_isolated_decoder_workspaces(
        runner, source_dir=runner.default_cwd, run_key=uuid.uuid4().hex,
        count=count, sanitize_history=sanitize_history,
    )
    try:
        yield paths
    finally:
        await _remove_isolated_decoder_workspaces(
            runner, root, source_dir=runner.default_cwd, workspaces=paths,
        )
