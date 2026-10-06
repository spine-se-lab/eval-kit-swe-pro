"""Dependency-free search fallback, executed with the task's python3 interpreter."""

import fnmatch
import json
import os
import re
import sys


def main():
    request = json.loads(sys.argv[1])
    root = request["path"]
    maximum = max(1, min(request["max_results"], 100))
    regex = re.compile(request["pattern"]) if request["mode"] == "grep" else None
    count = 0
    entries = [(os.path.dirname(root), [], [os.path.basename(root)])] if os.path.isfile(root) else os.walk(root)
    for directory, subdirs, files in entries:
        subdirs[:] = sorted(name for name in subdirs if name != ".git")
        for name in sorted(files):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root)
            pattern = request.get("glob") if regex else request["pattern"]
            if pattern and not (fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(name, pattern)):
                continue
            if regex is None:
                print(path)
                count += 1
            else:
                try:
                    with open(path, encoding="utf-8", errors="replace") as file:
                        for number, line in enumerate(file, 1):
                            if regex.search(line):
                                print(f"{path}:{number}:{line.rstrip()[:2048]}")
                                count += 1
                                if count >= maximum:
                                    return
                except (PermissionError, IsADirectoryError, FileNotFoundError):
                    continue
            if count >= maximum:
                return


if __name__ == "__main__":
    main()
