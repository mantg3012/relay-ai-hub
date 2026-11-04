#!/usr/bin/env bash
# End-to-end tests with fake CLIs. Usage: bash test/e2e.sh
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$(cd "$HERE/.." && pwd)"
export AI_KIT_HOME="$(mktemp -d)"; export PATH="$HERE/fakebin:$PATH"
AT="node $APP/src/cli.js"
PASS=0; FAIL=0
ok()  { echo "  ✔ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✖ $1"; FAIL=$((FAIL+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

newrepo() {
  R="$(mktemp -d)"; cd "$R"; git init -q -b main; git config user.email t@t; git config user.name t
  mkdir -p tests src; echo '[ 1 = 1 ]' > tests/existing.sh; echo 'echo 0' > src/add.sh
  echo '{"gates":{"test":"for t in tests/*.sh; do bash $t || exit 1; done"}}' > .ai-kit.json
  git add -A; git commit -qm init
}
last() { ls -d "$PWD"/.ai/tasks/T* | tail -1; }
st() { node -e "console.log(require('$1/state.json').$2)"; }

echo "▸ 1. single · Gemini tampers with an existing test in round 1"
newrepo
FAKE_GEMINI=cheat $AT run --yes "write add" > "$AI_KIT_HOME/out.log" 2>&1; D=$(last)
check "approved in round 2" '[ "$(st $D status)" = approved ] && [ "$(st $D round)" = 2 ]'
check "scope check caught tampering" 'grep -q "modified or deleted an existing test: tests/existing.sh" $D/r1-a-gates.log'
check "main tree untouched (worktree isolation)" '[ "$(cat src/add.sh)" = "echo 0" ] && git diff --quiet'
check "gemini session resumed in round 2" 'grep -q -- " -r gm-" $D/r2-a-gemini.log'
check "usage recorded for claude + gemini" 'node -e "const u=require(\"$D/state.json\").usage; process.exit(u.claude.input>0&&u.gemini.input>0?0:1)"'
check "review resumes the audit session" 'grep -q -- "--resume cl-" $D/r1-claude-review.log'
$AT merge "$(basename $D)" > /dev/null 2>&1
check "merge squashes into main and cleans worktree" '[ "$(cat src/add.sh)" = "echo \$(( \$1 + \$2 ))" ] && [ ! -d .ai/worktrees/$(basename $D) ] && [ "$(st $D status)" = merged ]'

echo "▸ 2. fallback · Gemini hits quota, OpenCode takes over"
newrepo
FAKE_GEMINI=quota $AT run --yes --mode fallback "write add" > "$AI_KIT_HOME/out.log" 2>&1; D=$(last)
check "approved" '[ "$(st $D status)" = approved ]'
check "fallback event emitted" 'grep -q "\"type\":\"fallback\"" $D/events.jsonl'
check "candidate now OpenCode" 'node -e "process.exit(require(\"$D/state.json\").candidates[0].agent===\"opencode\"?0:1)"'
check "opencode ran in safe mode" '[ -f $D/opencode.safe.json ] && grep -q "\"bash\": \"deny\"" $D/opencode.safe.json'

echo "▸ 3. best-of-2 · Gemini wrong, OpenCode right"
newrepo
FAKE_GEMINI=bad $AT run --yes --mode best-of-2 "write add" > "$AI_KIT_HOME/out.log" 2>&1; D=$(last)
check "approved with winner B (OpenCode)" '[ "$(st $D status)" = approved ] && [ "$(st $D winner)" = b ]'
check "both implementers ran in round 1" '[ -f $D/r1-a-gemini.log ] && [ -f $D/r1-b-opencode.log ]'
check "loser worktree removed" '[ ! -d .ai/worktrees/$(basename $D)-a ] && ! git rev-parse -q --verify ai/$(basename $D)-a >/dev/null'

echo "▸ 4. needs_human → resume with feedback"
newrepo
FAKE_GEMINI=bad $AT run --yes --rounds 1 "write add" > "$AI_KIT_HOME/out.log" 2>&1; D=$(last)
check "needs human after 1 round" '[ "$(st $D status)" = needs_human ]'
FAKE_GEMINI=good $AT resume "$(basename $D)" -m "Use arithmetic expansion" --rounds 2 > "$AI_KIT_HOME/out.log" 2>&1
check "approved after resume" '[ "$(st $D status)" = approved ]'
check "human feedback injected" 'grep -q "FEEDBACK FROM THE HUMAN OWNER" $D/r2-a-impl-prompt.md'

echo "▸ 5. cancel a running task"
newrepo
FAKE_SLEEP=20000 $AT run --yes "slow task" > "$AI_KIT_HOME/out.log" 2>&1 & PID=$!
sleep 2.5; D=$(last); $AT cancel "$(basename $D)" >/dev/null 2>&1
wait $PID
check "cancelled quickly" '[ "$(st $D status)" = cancelled ]'
check "no fake gemini left running" '! pgrep -f "fakebin/gemini" >/dev/null'

echo "▸ 6. architect guard hook"
check "blocks code edits in architect mode" '! echo "{\"tool_input\":{\"file_path\":\"/x/src/a.js\"}}" | AI_KIT_ARCHITECT=1 node $APP/hooks/architect_guard.js 2>/dev/null; [ ${PIPESTATUS[1]} -eq 2 ]'
check "allows .ai/ in architect mode" 'echo "{\"tool_input\":{\"file_path\":\"/x/.ai/specs/a.md\"}}" | AI_KIT_ARCHITECT=1 node $APP/hooks/architect_guard.js'
check "no-op outside architect mode" 'echo "{\"tool_input\":{\"file_path\":\"/x/src/a.js\"}}" | node $APP/hooks/architect_guard.js'

echo
echo "Result: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
