"""Locate assets in the immutable CodeHelix distribution."""
from pathlib import Path

def distribution_root() -> Path:
    return Path(__file__).resolve().parents[4]
