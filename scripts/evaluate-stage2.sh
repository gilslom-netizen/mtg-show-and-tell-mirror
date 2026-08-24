#!/usr/bin/env bash
#
# The stage 2 evaluation, start to finish, on a machine that can afford it.
#
# The question: is the determinizing search (DESIGN-AI.md 9.1) actually stronger than
# the hand-written heuristic of stage 1? On the laptop this was written on, 24 games
# came back 54% with a 95% interval of 29%-78% -- which decides nothing, exactly as
# DESIGN-AI.md 5.3 warns for a deck with this much variance. Settling it needs the
# 2,000 games that section asks for, and that is about seven hours there.
#
#   ./scripts/evaluate-stage2.sh
#
# Safe to interrupt. Every finished pair is appended to a checkpoint file as it lands,
# and re-running the script picks up from there rather than starting again -- so a
# dropped SSH session or a spot instance going away costs minutes, not hours.
#
# ---------------------------------------------------------------------------
# What the machine needs
# ---------------------------------------------------------------------------
#
#   Node       20 or newer          (`node -v`)
#   Cores      16+ is the sweet spot for a run of this size
#   Memory     ~500MB per worker thread, so 16GB for 16 workers
#   Disk       negligible -- the checkpoint for a full run is a few MB
#
# One thing worth knowing before picking an instance type: **this workload is bound by
# memory bandwidth, not by core count.** The engine allocates heavily -- a redacted
# view is 7.4KB and there are a couple of hundred per game -- and more threads do not
# buy more bandwidth. On a 12-thread laptop the curve flattens at about x2 by four
# threads. A machine with real memory bandwidth per core (a bare-metal or
# compute-optimised instance rather than a cheap burstable one) will do much better
# than its core count alone suggests, and a burstable one will do much worse.
#
# ---------------------------------------------------------------------------
# From nothing to running
# ---------------------------------------------------------------------------
#
#   git clone https://github.com/gilslom-netizen/mtg-show-and-tell-mirror.git
#   cd mtg-show-and-tell-mirror
#   npm ci
#   ./scripts/evaluate-stage2.sh
#
# Leave it running under tmux or nohup if the connection might drop:
#
#   tmux new -s eval './scripts/evaluate-stage2.sh 2>&1 | tee eval.log'
#
# When it finishes, the answers are in results/*.json. Those files are the whole
# output -- send them back and nothing else is needed.

set -euo pipefail
cd "$(dirname "$0")/.."

WORKERS="${WORKERS:-$(nproc)}"
GAMES="${GAMES:-2000}"
SEED="${SEED:-20260824}"
# Per-decision thinking time. High enough not to bind: the determinization count is
# the knob that decides how hard the search works, and this only stops a pathological
# position from running away with the clock.
BUDGET="${BUDGET:-30000}"

mkdir -p results checkpoints

run() {
  local name="$1" a="$2" b="$3" games="$4"
  echo
  echo "=============================================================="
  echo "  $name"
  echo "  $a  vs  $b   --   $games games on $WORKERS threads"
  echo "=============================================================="
  npm run ai:arena --silent -- \
    --a "$a" --b "$b" \
    --games "$games" \
    --seed "$SEED" \
    --workers "$WORKERS" \
    --budget "$BUDGET" \
    --checkpoint "checkpoints/$name.jsonl" \
    --out "results/$name.json"
}

echo "Node $(node -v), $(nproc) cores, using $WORKERS workers"
echo "Started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---------------------------------------------------------------------------
# 1. The question stage 2 exists to answer. Everything else is optional.
# ---------------------------------------------------------------------------
run "pimc8-vs-heuristic" "pimc:8" "heuristic" "$GAMES"

# ---------------------------------------------------------------------------
# 2. Does more search help?
#
# If pimc:16 does not beat pimc:4, then whatever pimc:8 scored above was not bought
# with search, and the honest reading of stage 2 changes completely -- so this is
# worth its own run rather than being assumed either way.
# ---------------------------------------------------------------------------
run "pimc16-vs-pimc4" "pimc:16" "pimc:4" "$GAMES"

# ---------------------------------------------------------------------------
# 3. A control. The heuristic's 97.7% against random is already established on the
#    laptop, so a different answer here means the machine, the build or the seed
#    differs -- not that anything got stronger. Cheap, and it makes the two runs
#    above believable.
# ---------------------------------------------------------------------------
run "heuristic-vs-random" "heuristic" "random" 2000

echo
echo "Finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Results:"
for f in results/*.json; do
  echo "  $f"
done
