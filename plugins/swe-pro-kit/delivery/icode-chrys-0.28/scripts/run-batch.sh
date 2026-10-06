#!/bin/bash
# run-batch.sh — Run explicit SWE-bench Pro task lists in resumable batches.
#
# "没跑过" = 在 OUT_JOBS 目录里没有 result.json。每批结束自动重算剩余,所以中途断了重跑也会接着没跑的继续。
# CHRYS_DIR 指向 Agent checkout；SOURCE 指向任务清单；RUN_DIR 保存可写批次文件。
#
# 用法:
#   bash /path/to/run-batch.sh            # 跑完所有剩余(前台,会一直跑;建议 nohup)
#   nohup bash /path/to/run-batch.sh > rest.log 2>&1 &   # 后台挂着跑完
#   EXCLUDE=/path/to/excluded-tasks.txt bash ...                 # optional exclusions
#   BATCH=10 CONCURRENT=3 bash ...                  # 自定义批大小/并发
set -euo pipefail

INVOKE_DIR="$PWD"
CHRYS_DIR="${CHRYS_DIR:-$INVOKE_DIR}"
SOURCE="${SOURCE:-}"                          # one task name per line; legacy PASS/FAIL TSV also accepted
RUN_DIR="${RUN_DIR:-$INVOKE_DIR/swe-pro-runs}"
BATCH="${BATCH:-20}"
CONCURRENT="${CONCURRENT:-5}"
OUT_JOBS="${OUT_JOBS:-$RUN_DIR/jobs}"
SETTING="${SETTING:-}"
BINDINGS="${BINDINGS:-}"
DATASET="${DATASET:-scale-ai/swe-bench-pro}"
HARBOR_BIN="${HARBOR_BIN:-$CHRYS_DIR/.venv/bin/harbor}"
CONFIG_ROOT="${CONFIG_ROOT:-$HOME/.chrys}"
EXCLUDE="${EXCLUDE:-}"                          # 可选:逗号/空格分隔的 tasklist,这些实例不跑

if [ -z "$SETTING" ]; then
  echo "Error: SETTING is required (for example single-decoder or three-decoder)." >&2
  exit 2
fi
if [ -n "$BINDINGS" ] && [ ! -f "$BINDINGS" ]; then
  echo "Error: BINDINGS must point to a role-to-profile JSON file." >&2
  exit 2
fi
if [ ! -x "$HARBOR_BIN" ]; then
  echo "Error: HARBOR_BIN must point to Harbor in the prepared Chrys Python environment." >&2
  exit 2
fi
if [ -z "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
  echo "Error: SOURCE must point to an existing task list (one task name per line)." >&2
  exit 2
fi
if [ ! -f "$CHRYS_DIR/pyproject.toml" ]; then
  echo "Error: set CHRYS_DIR to the Chrys checkout containing pyproject.toml." >&2
  exit 2
fi
for value in "$BATCH" "$CONCURRENT"; do
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Error: BATCH and CONCURRENT must be positive integers." >&2
    exit 2
  fi
done
# Resolve caller-relative paths before changing the Agent execution directory.
case "$SOURCE" in /*) ;; *) SOURCE="$INVOKE_DIR/$SOURCE" ;; esac
case "$RUN_DIR" in /*) ;; *) RUN_DIR="$INVOKE_DIR/$RUN_DIR" ;; esac
case "$OUT_JOBS" in /*) ;; *) OUT_JOBS="$INVOKE_DIR/$OUT_JOBS" ;; esac
case "$CONFIG_ROOT" in /*) ;; *) CONFIG_ROOT="$INVOKE_DIR/$CONFIG_ROOT" ;; esac
case "$HARBOR_BIN" in /*) ;; *) HARBOR_BIN="$INVOKE_DIR/$HARBOR_BIN" ;; esac
case "$BINDINGS" in ""|/*) ;; *) BINDINGS="$INVOKE_DIR/$BINDINGS" ;; esac
if [ -f "$SETTING" ]; then
  case "$SETTING" in /*) ;; *) SETTING="$INVOKE_DIR/$SETTING" ;; esac
fi
mkdir -p "$RUN_DIR"
BATCH_DIR="$(mktemp -d "$RUN_DIR/batches.XXXXXX")"
trap 'rm -rf "$BATCH_DIR"' EXIT
CHRYS_DIR="$(cd "$CHRYS_DIR" && pwd)"
cd "$CHRYS_DIR"
export PYTHONPATH="$CHRYS_DIR/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1

# 超时倍数(可选):AGENT_TIMEOUT_MULT 放大 agent 执行超时;TIMEOUT_MULT 放大全部;VERIFIER_TIMEOUT_MULT 放大验证
AGENT_TIMEOUT_MULT="${AGENT_TIMEOUT_MULT:-4}"
TIMEOUT_FLAGS=()
[ -z "${TIMEOUT_MULT:-}" ]          || TIMEOUT_FLAGS+=(--timeout-multiplier "$TIMEOUT_MULT")
[ -z "${AGENT_TIMEOUT_MULT:-}" ]    || TIMEOUT_FLAGS+=(--agent-timeout-multiplier "$AGENT_TIMEOUT_MULT")
[ -z "${VERIFIER_TIMEOUT_MULT:-}" ] || TIMEOUT_FLAGS+=(--verifier-timeout-multiplier "$VERIFIER_TIMEOUT_MULT")

round=0
previous_remaining=""
while true; do
  round=$((round+1))
  BATCH_TL="$BATCH_DIR/batch${round}.txt"

  # 算剩余 = SOURCE - (OUT_JOBS 里已有结果) - EXCLUDE,取前 BATCH 个写入 BATCH_TL
  REMAIN=$(SOURCE="$SOURCE" OUT_JOBS="$OUT_JOBS" EXCLUDE="$EXCLUDE" BATCH="$BATCH" INVOKE_DIR="$INVOKE_DIR" python3 - "$BATCH_TL" <<'PY'
import json, glob, os, sys
out=sys.argv[1]
src=os.environ['SOURCE']; outjobs=os.environ['OUT_JOBS']
batch=int(os.environ['BATCH'])
def tasks(file):
    names=[]
    for line in open(file, encoding='utf-8'):
        line=line.strip()
        if not line or line.startswith('#'): continue
        parts=line.split('\t',1)
        name=parts[1] if len(parts)==2 and parts[0] in ('PASS','FAIL','TASK') else line
        if '\t' in name or not name: raise ValueError('Invalid task list row')
        if name not in names: names.append(name)
    return names
done=set()
for f in glob.glob(os.path.join(outjobs,'*','*','result.json')):
    try: done.add(json.load(open(f))['config']['task']['name'])
    except Exception: pass
excl=set()
for p in os.environ.get('EXCLUDE','').replace(',',' ').split():
    if not os.path.isabs(p): p=os.path.join(os.environ['INVOKE_DIR'],p)
    try:
        excl.update(tasks(p))
    except FileNotFoundError: pass
remain=[n for n in tasks(src) if n not in done and n not in excl]
take=remain[:batch]
with open(out,'w') as f:
    f.write(f"# auto batch: {len(take)} of {len(remain)} remaining\n")
    for n in take: f.write(f"TASK\t{n}\n")
print(len(remain))
PY
)
  TAKE=$(grep -cE '^TASK[[:space:]]' "$BATCH_TL" || true)
  echo ""
  echo "=========== Batch $round ==========="
  echo "Remaining: $REMAIN  Taking this batch: $TAKE"
  if [ "$TAKE" -eq 0 ]; then
    echo "No remaining tasks; all done."
    rm -f "$BATCH_TL"
    break
  fi
  if [ "$previous_remaining" = "$REMAIN" ]; then
    echo "Error: Harbor returned without new task results in OUT_JOBS; stopping instead of repeating the same batch." >&2
    exit 2
  fi
  previous_remaining="$REMAIN"

  # 组 harbor 命令(-i 来自本批清单)
  INCLUDE_FLAGS=()
  IC=0
  while IFS=$'\t' read -r tag name; do
    case "$tag" in TASK) INCLUDE_FLAGS+=(-i "$name"); IC=$((IC + 1)) ;; esac
  done < "$BATCH_TL"
  AGENT_FLAGS=(--agent-kwarg "setting=$SETTING")
  [ -z "$BINDINGS" ] || AGENT_FLAGS+=(--agent-kwarg "bindings=$BINDINGS")
  echo "Include guard: -i count = $IC (expected=$TAKE)"
  if [ "$IC" -ne "$TAKE" ]; then echo "Error: wrong -i count; aborting to avoid running the full dataset."; exit 1; fi

  echo "Starting batch $round ($TAKE tasks, concurrency $CONCURRENT)... $(date '+%H:%M:%S')"
  "$HARBOR_BIN" run -d "$DATASET" "${INCLUDE_FLAGS[@]}" \
    --agent-import-path chrys.orchestration.swe_pro_baseline:ChrysAgent \
    "${AGENT_FLAGS[@]}" --agent-kwarg "config_root=$CONFIG_ROOT" \
    --agent-kwarg workdir=/app -o "$OUT_JOBS" --n-concurrent "$CONCURRENT" \
    "${TIMEOUT_FLAGS[@]}" --yes
  echo "Batch $round finished at $(date '+%H:%M:%S')"
done

echo ""
echo "=== Batch results (raw Harbor trials remain in OUT_JOBS) ==="
SOURCE="$SOURCE" OUT_JOBS="$OUT_JOBS" python3 - <<'PY'
import json, glob, os
src=os.environ['SOURCE']; outjobs=os.environ['OUT_JOBS']
res={}
for f in glob.glob(os.path.join(outjobs,'*','*','result.json')):
    try:
        r=json.load(open(f)); n=r['config']['task']['name']
        vr=r.get('verifier_result'); v=None if vr is None else vr.get('rewards',{}).get('reward')
        if n not in res: res[n]=v
    except Exception: pass
names=set()
for line in open(src):
    line=line.strip()
    if not line or line.startswith('#'): continue
    parts=line.split('\t',1)
    names.add(parts[1] if len(parts)==2 and parts[0] in ('PASS','FAIL','TASK') else line)
completed=names & res.keys()
passed=sum(res[n] is not None and res[n]>=1.0 for n in completed)
unscored=sum(res[n] is None for n in completed)
print(f"  {len(completed)}/{len(names)} tasks have results; passed={passed}; unscored={unscored}")
print('  Compare runs only with the same task set, setting, bindings and model; inspect individual trial errors.')
PY
