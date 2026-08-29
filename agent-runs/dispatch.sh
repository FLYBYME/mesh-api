#!/usr/bin/env bash
# dispatch.sh -- launches an agy build dispatch by number.
#
# Usage: agent-runs/dispatch.sh <N>
#   e.g. agent-runs/dispatch.sh 76
#
# Finds agent-runs/prompts/<N>-*.prompt.txt, launches agy against it in the
# background (--dangerously-skip-permissions, required for an unattended
# background run -- see agent-runs/README.md), and writes its output to the
# matching agent-runs/results/<N>-*.result.log.
#
# Enforces the project's own hard limit of 2 concurrent agy processes
# (agent-runs/README.md) instead of leaving that as a manual check.

set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <dispatch-number>" >&2
    exit 1
fi

NUM="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROMPT_FILE="$(find "$SCRIPT_DIR/prompts" -maxdepth 1 -name "${NUM}-*.prompt.txt" | head -1)"
if [ -z "$PROMPT_FILE" ]; then
    echo "No prompt file found matching agent-runs/prompts/${NUM}-*.prompt.txt" >&2
    exit 1
fi

BASENAME="$(basename "$PROMPT_FILE" .prompt.txt)"
RESULT_FILE="$SCRIPT_DIR/results/${BASENAME}.result.log"

RUNNING=0
if pgrep -f '^agy ' > /dev/null 2>&1; then
    RUNNING="$(pgrep -cf '^agy ')"
fi
if [ "$RUNNING" -ge 2 ]; then
    echo "Refusing to dispatch: $RUNNING agy process(es) already running (hard limit: 2 concurrent)." >&2
    echo "Check with: pgrep -f '^agy '" >&2
    exit 1
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "Dispatching $BASENAME..."
nohup agy -p "$(cat "$PROMPT_FILE")" \
    --dangerously-skip-permissions --print-timeout 120m0s \
    > "$RESULT_FILE" 2>&1 &
disown

sleep 2
if pgrep -f '^agy ' > /dev/null; then
    echo "Dispatched. Running PID(s): $(pgrep -f '^agy ' | tr '\n' ' ')"
    echo "Log: $RESULT_FILE"
else
    echo "FAILED to start -- check $RESULT_FILE" >&2
    exit 1
fi
