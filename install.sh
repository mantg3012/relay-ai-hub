#!/usr/bin/env bash
# Install Relay (ai-task v2) for the current user — macOS, Linux, WSL. No sudo needed.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
KIT_HOME="${AI_KIT_HOME:-$HOME/.ai-kit}"
APP="$KIT_HOME/app"
BIN="${AI_KIT_BIN:-$HOME/.local/bin}"

command -v node >/dev/null 2>&1 || { echo "✖ Node.js 18+ is required (it is also required by Gemini CLI)."; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]'); [ "$major" -ge 18 ] || { echo "✖ Node.js 18+ required, found $(node -v)"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "✖ git is required."; exit 1; }

mkdir -p "$KIT_HOME" "$BIN"
trap 'rm -rf "$APP.new"; echo "✖ Install failed; nothing was changed."' ERR
rm -rf "$APP.new"; mkdir -p "$APP.new"
cp -R "$SRC"/{bin,src,web,prompts,hooks,commands,migrate,package.json,README.md,LICENSE} "$APP.new/"
rm -rf "$APP"; mv "$APP.new" "$APP"; trap - ERR
chmod +x "$APP"/bin/* "$APP"/hooks/*
# replace v1 bash shims with links to v2
rm -f "$BIN/ai-task" "$BIN/ai-arch"
ln -s "$APP/bin/ai-task" "$BIN/ai-task"; ln -s "$APP/bin/ai-arch" "$BIN/ai-arch"
echo "✔ Installed Relay $(node -p "require('$APP/package.json').version") to $APP"
"$BIN/ai-task" setup
case ":$PATH:" in *":$BIN:"*) ;; *) echo "⚠ Add $BIN to your PATH:  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc  (or ~/.bashrc), then open a new terminal";; esac
echo; echo "Next: cd into a git repository and run  ai-task doctor  then  ai-task ui"
