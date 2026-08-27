#!/usr/bin/env bash
# Claude Code Stop hook: keep THIS agent reachable on Modula Relay without tmux.
# When the agent tries to end its turn while messages are queued FOR IT, the hook blocks
# the stop and tells the model to resume its await loop. It scopes to this pane's own
# agent — a pending message for a peer must never wake the sender — by finding the relay
# MCP server this Claude session spawned and reading its --name. If the name can't be
# resolved (unexpected), it falls back to the pool total rather than going silent.
#
# Install (per project) in .claude/settings.json:
#   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
#     "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/relay-stop-hook.sh\"" } ] } ] } }
#
# Wake fields appear in the registry only for peers whose name is in MODULA_RELAY_WAKE_ROLES.
set -u
pool=$(python3 - "$PWD" <<'EOF'
import hashlib, pathlib, re, sys
folder = pathlib.Path(sys.argv[1]).resolve()
slug = re.sub(r'^[-_]+', '', re.sub(r'[^A-Za-z0-9_-]', '-', folder.name))[:40] or 'pool'
print(f"{slug}-{hashlib.sha256(str(folder).encode()).hexdigest()[:8]}")
EOF
)
agents="${MODULA_RELAY_DIR:-$HOME/.modula-relay/run}/projects/$pool/agents"
[ -d "$agents" ] || exit 0

# Identify this pane's own agent by finding the relay CLI process spawned by the Claude
# session that invoked this hook, then reading its --name.
self=$(python3 - "$$" <<'EOF'
import os, sys

def cmdline(pid):
    try:
        with open(f'/proc/{pid}/cmdline', 'rb') as f: return f.read().split(b'\0')
    except OSError: return []

def ppid(pid):
    try:
        for line in open(f'/proc/{pid}/status'):
            if line.startswith('PPid:'): return int(line.split()[1])
    except OSError: pass
    return 0

# Walk up from the hook to the nearest Claude ancestor.
claude, pid = None, ppid(int(sys.argv[1]))
while pid and pid > 1:
    if any(b'claude' in part for part in cmdline(pid)): claude = pid; break
    pid = ppid(pid)
if not claude: sys.exit(0)

def descends_from(pid, ancestor, hops=40):
    while pid and pid > 1 and hops:
        pid = ppid(pid); hops -= 1
        if pid == ancestor: return True
    return False

for entry in os.scandir('/proc'):
    if not entry.name.isdigit(): continue
    parts = [p.decode('utf-8', 'replace') for p in cmdline(entry.name) if p]
    if not any('modula-relay' in p or 'relay/dist/cli' in p or p.endswith('cli.js') for p in parts): continue
    if '--name' not in parts: continue
    if descends_from(int(entry.name), claude):
        print(parts[parts.index('--name') + 1]); break
EOF
)

depth=$(python3 - "$agents" "$self" <<'EOF'
import json, pathlib, sys
agents, self = sys.argv[1], sys.argv[2]
def d(entry):
    try: return int(json.loads(entry.read_text()).get('undelivered_depth', 0) or 0)
    except Exception: return 0
if self:
    entry = pathlib.Path(agents) / f'{self}.json'
    print(d(entry) if entry.exists() else 0)
else:
    print(sum(d(e) for e in pathlib.Path(agents).glob('*.json')))
EOF
)
if [ "${depth:-0}" -gt 0 ]; then
  echo "You have queued relay message(s). Run relay_await now, handle each, reply, and resume your loop." >&2
  exit 2
fi
exit 0
