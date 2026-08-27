#!/usr/bin/env bash
# Minimal external watcher: when a peer has queued (undelivered) messages, nudge the tmux
# window named after it so its model re-enters the await loop. Wake fields appear in the
# registry only for peers listed in MODULA_RELAY_WAKE_ROLES.
#
# Usage: relay-watch.sh <tmux-session> <pool-agents-dir>
#   relay-watch.sh agents ~/.modula-relay/run/projects/<pool>/agents
set -u
SESSION="${1:?tmux session name}"
POOL_DIR="${2:?pool agents directory}"
NUDGE="You have queued relay message(s). Run relay_await now, handle each, reply, and resume your loop."
declare -A last_nudge
echo "relay-watch: watching $POOL_DIR"
while true; do
  for f in "$POOL_DIR"/*.json; do
    [ -e "$f" ] || continue
    name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name", ""))' "$f" 2>/dev/null)
    depth=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("undelivered_depth", 0))' "$f" 2>/dev/null)
    now=$(date +%s); last=${last_nudge[$name]:-0}
    if [ "${depth:-0}" -gt 0 ] && [ $((now - last)) -gt 45 ]; then
      if tmux has-session -t "$SESSION" 2>/dev/null && tmux list-windows -t "$SESSION" -F '#W' | grep -qx "$name"; then
        # Enter must be its own keypress: sent in the same burst, harnesses treat it as
        # a pasted newline and the nudge sits unsubmitted in the composer.
        tmux send-keys -t "$SESSION:$name" "$NUDGE"
        sleep 1
        tmux send-keys -t "$SESSION:$name" Enter
        echo "$(date +%H:%M:%S) nudged $name (undelivered=$depth)"
        last_nudge[$name]=$now
      fi
    fi
  done
  sleep 2
done
