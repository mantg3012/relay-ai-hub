#!/usr/bin/env bash
set -euo pipefail
KIT_HOME="${AI_KIT_HOME:-$HOME/.ai-kit}"; BIN="${AI_KIT_BIN:-$HOME/.local/bin}"
[ -x "$BIN/ai-task" ] && "$BIN/ai-task" unsetup || true
rm -f "$BIN/ai-task" "$BIN/ai-arch"; rm -rf "$KIT_HOME/app"
read -r -p "Also delete $KIT_HOME (your settings, custom prompts, repo list)? [y/N] " a
if [ "$a" = y ] || [ "$a" = Y ]; then rm -rf "$KIT_HOME"; fi
echo "✔ Uninstalled. Task history inside your repositories (.ai/) was not touched."
