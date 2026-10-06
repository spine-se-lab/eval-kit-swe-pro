# TaskPattern real evaluation evidence (2026-10-02)

This directory is a sanitized, reviewable copy of one completed real-provider
`taskpattern-evaluation` trial. No credential or `.env` content is included.

## Result

- SWE-Pro Kit: `0.3.2`
- Task Pattern Advisor: `0.3.10` / TaskPattern runtime `0.8.5`
- Host: Chrys/iCode `0.20.1`
- Harbor: `0.7.0`, installed and selected by the SWE-Pro managed runtime
- Model: `deepseek/deepseek-v4-flash` through the configured OpenRouter endpoint
- Public target: `django/djangoproject.com#2795`
- Trial: `swe-pro-sponsor-header__f2LV6RU`
- Time: `2026-10-02T21:07:17Z` to `2026-10-02T21:30:51Z`
- Harbor result: completed, no exception, reward `1.0`

The trial started with a new TaskPattern data root containing zero files.

| Chrys stage | TaskPattern Search | Cache/generation result | Apply |
| --- | --- | --- | --- |
| Decoder / analysis | `partial`, live GitHub search | 0 hits; 2 generated; 1 provider failure recorded | `completed`; 10 `general_summary/*` sections |
| Mapper / planning | `completed`, live GitHub search | 2 hits; the one failed Decoder Artifact was regenerated successfully | `completed`; 10 general sections |
| Solver / implementation | `completed`, live GitHub search | 3 hits; 0 generated | `completed`; 10 general sections |

Every stage contains exactly one Search start/finish and one Apply
start/finish. The runtime derived `issue_mode=existing_target` and
`target_leakage_check=true`; SWE-Pro did not accept or pass either as a user
switch. Mapper remained read-only. Solver changed one word in `header.html`,
ran repository checks, and produced `solution.patch`.

The verifier ran one test successfully (`OK`) and wrote reward `1`. The
aggregate invocation artifact records one completed Search and Apply for each
of Decoder, Mapper, and Solver.

## Files

- `baseline-run.json`: fixed setting, versions, public context, profiles,
  stage outputs, and token usage.
- `taskpattern-invocations.json`: aggregate, compact TaskPattern invocation
  evidence for all three roles.
- `roles/*-taskpattern-invocations.json`: per-role statuses, cache counters,
  Artifact hashes, and Apply general-knowledge section names.
- `solution.patch`: the exact generated patch.
- `trial-result.json` and `job-result.json`: Harbor trial/job outcomes.
- `verifier/`: verifier stdout and reward.

## Windows isolation note

After Harbor had written the successful result and verifier reward, Chrys
`0.20.1` emitted an AnyIO asynchronous-generator cleanup warning while the
Windows process was exiting. SWE-Pro deliberately defers closing the cached
stdio MCP transport on this fixed Windows evaluation path because synchronous
shutdown otherwise hangs between stages. The warning does not change the
recorded trial result, patch, test result, or reward. Other platforms/settings
retain normal graceful MCP shutdown.
