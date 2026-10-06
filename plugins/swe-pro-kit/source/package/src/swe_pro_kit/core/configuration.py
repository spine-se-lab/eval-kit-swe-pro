"""Run topology and replaceable agent bindings for SWE-bench Pro."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Setting:
    executor: str
    decoder_count: int
    decoder_execution: str
    aggregate: bool

    def __post_init__(self) -> None:
        if not isinstance(self.executor, str) or self.executor not in {"workflow", "icode-workflow", "sub-agent", "legacy-workflow"}:
            raise ValueError("executor must be 'workflow', 'icode-workflow', 'sub-agent', or 'legacy-workflow'")
        if type(self.decoder_count) is not int or self.decoder_count < 1:
            raise ValueError("decoder_count must be a positive integer")
        if not isinstance(self.decoder_execution, str) or self.decoder_execution not in {"parallel", "serial"}:
            raise ValueError("decoder_execution must be 'parallel' or 'serial'")
        if type(self.aggregate) is not bool:
            raise ValueError("aggregate must be a boolean")
        if self.decoder_count > 1 and not self.aggregate:
            raise ValueError("multiple Decoders require an Aggregator before the Mapper")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Bindings:
    decoder: str
    aggregator: str
    mapper: str
    solver: str

    def __post_init__(self) -> None:
        for role, profile in asdict(self).items():
            if not isinstance(profile, str) or not profile.strip() or profile != profile.strip():
                raise ValueError(f"{role} binding must be a nonempty profile name")

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


PRESET_NAMES = (
    "three-decoder-icode-workflow",
    "single-decoder", "three-decoder", "three-decoder-serial", "sub-agent", "sub-agent-serial", "legacy-workflow",
    "taskpattern-evaluation",
)


def _read_mapping(value: str | Path | Mapping[str, Any], *, kind: str) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    if not isinstance(value, (str, Path)) or not str(value).strip():
        raise ValueError(f"{kind} must be an explicit JSON file or object")
    try:
        data = json.loads(Path(value).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read {kind} JSON file {value}: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{kind} JSON must contain an object")
    return data


def _check_keys(data: Mapping[str, Any], expected: set[str], *, kind: str) -> None:
    missing, unexpected = expected - data.keys(), data.keys() - expected
    if missing or unexpected:
        details = []
        if missing:
            details.append(f"missing {', '.join(sorted(missing))}")
        if unexpected:
            details.append(f"unknown {', '.join(sorted(unexpected))}")
        raise ValueError(f"invalid {kind}: {'; '.join(details)}")


def load_setting(
    value: str | Path | Mapping[str, Any] | Setting,
    *,
    settings_dir: str | Path | None = None,
) -> Setting:
    """Load an explicit preset or JSON topology; there is no implicit setting."""
    if isinstance(value, Setting):
        return value
    if isinstance(value, str) and value in PRESET_NAMES:
        if settings_dir is None:
            raise ValueError("settings_dir is required to resolve a setting preset")
        value = Path(settings_dir) / f"{value}.json"
    data = _read_mapping(value, kind="setting")
    _check_keys(data, {"executor", "decoder_count", "decoder_execution", "aggregate"}, kind="setting")
    return Setting(**data)


def load_bindings(value: str | Path | Mapping[str, Any] | Bindings) -> Bindings:
    if isinstance(value, Bindings):
        return value
    data = _read_mapping(value, kind="bindings")
    _check_keys(data, {"decoder", "aggregator", "mapper", "solver"}, kind="bindings")
    return Bindings(**data)


def expected_stage_roles(setting: Setting) -> tuple[str, ...]:
    roles = [f"decoder-{index}" for index in range(setting.decoder_count)]
    if setting.aggregate:
        roles.append("aggregator")
    return tuple(roles + ["mapper", "solver"])
