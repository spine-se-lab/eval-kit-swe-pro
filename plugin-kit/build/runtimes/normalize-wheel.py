"""Rewrite a wheel into a byte-stable, cross-platform representation."""

from __future__ import annotations

import base64
import csv
import hashlib
import io
import os
import sys
import zipfile
from pathlib import Path


EPOCH = (1980, 1, 1, 0, 0, 0)
TEXT_METADATA_SUFFIXES = (
    ".dist-info/METADATA",
    ".dist-info/WHEEL",
    ".dist-info/entry_points.txt",
    ".dist-info/top_level.txt",
)


def _record(contents: dict[str, bytes], record_name: str) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    for name in sorted(contents):
        digest = (
            base64.urlsafe_b64encode(hashlib.sha256(contents[name]).digest())
            .rstrip(b"=")
            .decode()
        )
        writer.writerow((name, f"sha256={digest}", len(contents[name])))
    writer.writerow((record_name, "", ""))
    return output.getvalue().encode("utf-8")


def normalize(wheel: Path) -> None:
    with zipfile.ZipFile(wheel, "r") as archive:
        record_names = [
            info.filename
            for info in archive.infolist()
            if not info.is_dir() and info.filename.endswith(".dist-info/RECORD")
        ]
        contents = {
            info.filename: archive.read(info.filename)
            for info in archive.infolist()
            if not info.is_dir() and not info.filename.endswith(".dist-info/RECORD")
        }

    for name, value in contents.items():
        if name.endswith(TEXT_METADATA_SUFFIXES):
            contents[name] = value.replace(b"\r\n", b"\n")

    if len(record_names) != 1:
        raise ValueError("wheel must contain exactly one .dist-info/RECORD")
    record_name = record_names[0]
    contents[record_name] = _record(contents, record_name)

    temporary = wheel.with_suffix(wheel.suffix + ".tmp")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(contents):
            info = zipfile.ZipInfo(name, EPOCH)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, contents[name])
    os.replace(temporary, wheel)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize-wheel.py WHEEL")
    normalize(Path(sys.argv[1]))
