#!/bin/sh
# Run the role fleet and the Telegram bot as macOS LaunchAgents: they start at login, come back
# after a crash, and no longer die with the terminal / Claude Code session that started them.
# The fleet runs under `caffeinate -i` so the Mac doesn't idle-sleep while agents work (an idle
# Mac stalled every session overnight on 2026-11-12). A closed lid still sleeps.
#
#   sh scripts/launchd.sh install     # write the plists and (re)start both
#   sh scripts/launchd.sh uninstall   # stop and remove
#   sh scripts/launchd.sh status
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
LOGS="${FLEET_HOME:-$HOME/.xentra-fleet}/logs"
AGENTS="$HOME/Library/LaunchAgents"
UID_=$(id -u)
# Gates run yarn/npx/git, sessions run claude/codex: launchd starts with a bare PATH.
AGENT_PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

plist() { # label, program args (xml), log name
  cat <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <!-- SIGTERM first: the supervisor waits for running sessions (FLEET_SHUTDOWN_GRACE_MS). -->
  <key>ExitTimeOut</key><integer>120</integer>
  <key>StandardOutPath</key><string>$LOGS/$3.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$3.log</string>
</dict>
</plist>
XML
}

case "${1:-status}" in
  install)
    mkdir -p "$AGENTS" "$LOGS"
    # Anything started by hand would hold the supervisor lock / the bot's long poll.
    for l in kz.xentra.fleet kz.xentra.bot; do launchctl bootout "gui/$UID_/$l" 2>/dev/null || true; done
    pkill -TERM -f "dist/cli.js fleet run" 2>/dev/null || true
    pkill -TERM -f "dist/cli.js bot" 2>/dev/null || true
    for i in $(seq 1 120); do pgrep -f "dist/cli.js (fleet run|bot)" >/dev/null || break; sleep 1; done
    plist kz.xentra.fleet "<string>/usr/bin/caffeinate</string><string>-i</string><string>$NODE</string><string>dist/cli.js</string><string>fleet</string><string>run</string>" fleet > "$AGENTS/kz.xentra.fleet.plist"
    plist kz.xentra.bot "<string>$NODE</string><string>dist/cli.js</string><string>bot</string>" bot > "$AGENTS/kz.xentra.bot.plist"
    for l in kz.xentra.fleet kz.xentra.bot; do
      launchctl bootstrap "gui/$UID_" "$AGENTS/$l.plist"
    done
    "$0" status
    ;;
  uninstall)
    for l in kz.xentra.fleet kz.xentra.bot; do
      launchctl bootout "gui/$UID_/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    ;;
  status)
    for l in kz.xentra.fleet kz.xentra.bot; do
      printf '%s: ' "$l"
      launchctl print "gui/$UID_/$l" 2>/dev/null | awk '/^\tstate =|^\tpid =/{printf "%s ", $0}' || printf 'not loaded'
      echo
    done
    ;;
  *) echo "usage: $0 install|uninstall|status" >&2; exit 2 ;;
esac
