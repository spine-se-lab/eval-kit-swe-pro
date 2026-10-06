# Windows regression boundary

The broad command covering the ten root `test_swe_pro_*.py` modules completed
with `103 passed, 13 skipped, 29 failed, 6 errors` in 76.73 seconds on native
Windows.

Representative failures establish that the remaining failures are older test
harness portability assumptions rather than the TaskPattern evaluation path:

- batch tests execute `bash` and fail because the local WSL relay cannot find
  `/bin/bash`;
- launch tests execute `npx` as a native binary and fail with `WinError 2`
  instead of selecting `npx.cmd`;
- Harbor runtime and legacy worktree tests pass a Windows temporary host path
  to `HarborEnvRunner`, whose contract intentionally accepts an absolute
  container path such as `/app`;
- the six setup errors are parameterized legacy-parity cases in the same
  host-path-oriented test family.

These tests are not silently marked successful or removed. They remain a
separate Windows portability backlog. The in-scope TaskPattern contract test
passes independently, and the real Windows Harbor/Chrys trial in this evidence
directory completed with no exception and verifier reward `1.0`.
