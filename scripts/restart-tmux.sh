#!/usr/bin/env bash
# Restart codex-proxy inside the `codex-proxy` tmux session.
# Default: production mode (build + npm start) so it doesn't hot-reload while editing.
# Pass --dev to use `npm run dev` (tsx watch) instead.

set -euo pipefail

SESSION="codex-proxy"
MODE="prod"

for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --prod) MODE="prod" ;;
    -h|--help)
      echo "usage: $0 [--dev|--prod]  (default: --prod)"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' not found" >&2
  exit 1
fi

if [[ "$MODE" == "dev" ]]; then
  CMD='npm run dev'
else
  CMD='npm run build && npm start'
fi

# Stop whatever is running (Ctrl-C twice handles the tsx 5s grace period).
tmux send-keys -t "$SESSION" C-c
sleep 1
tmux send-keys -t "$SESSION" C-c
sleep 1

# Drain any leftover input then fire the new command.
tmux send-keys -t "$SESSION" C-u
tmux send-keys -t "$SESSION" "$CMD" Enter

echo "Restarted '$SESSION' with: $CMD"
echo "Tail logs: tmux attach -t $SESSION   (detach: Ctrl-b d)"
