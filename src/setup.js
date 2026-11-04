'use strict';
// `ai-task setup` / `ai-task unsetup`: wire Relay into Claude Code (hook + /delegate) and migrate v1.
const fs = require('fs');
const path = require('path');
const os = require('os');
const U = require('./util');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_JS = path.join(U.APP_DIR, 'hooks', 'architect_guard.js');
const HOOK_CMD = `node "${HOOK_JS}"`;
const isOurs = (cmd) => typeof cmd === 'string' && /architect_guard\.(js|sh)/.test(cmd);

function readSettings() { return fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {}; }
function backup() { if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak.${Date.now()}`); }
function stripOurs(s) {
  if (!s.hooks || !Array.isArray(s.hooks.PreToolUse)) return s;
  s.hooks.PreToolUse = s.hooks.PreToolUse.map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h.command)) })).filter((m) => m.hooks.length);
  if (!s.hooks.PreToolUse.length) delete s.hooks.PreToolUse;
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

function setup(log = console.log) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true }); fs.mkdirSync(U.KIT_HOME, { recursive: true });
  // 1) hook (replaces any v1 entry)
  backup();
  const s = stripOurs(readSettings());
  s.hooks = s.hooks || {}; s.hooks.PreToolUse = s.hooks.PreToolUse || [];
  s.hooks.PreToolUse.push({ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: HOOK_CMD }] });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
  log(`✔ Architect guard hook registered in ${SETTINGS} (active only under ai-arch)`);
  // 2) /delegate
  fs.mkdirSync(path.join(CLAUDE_DIR, 'commands'), { recursive: true });
  fs.copyFileSync(path.join(U.APP_DIR, 'commands', 'delegate.md'), path.join(CLAUDE_DIR, 'commands', 'delegate.md'));
  log('✔ /delegate command installed for Claude Code');
  // 3) migrate v1 prompts: unchanged copies are removed so the new defaults apply; edited ones are kept
  const v1 = path.join(U.APP_DIR, 'migrate', 'v1-prompts');
  for (const n of fs.existsSync(v1) ? fs.readdirSync(v1) : []) {
    const mine = path.join(U.PROMPTS_DIR, n);
    if (!fs.existsSync(mine)) continue;
    if (fs.readFileSync(mine, 'utf8') === fs.readFileSync(path.join(v1, n), 'utf8')) { fs.rmSync(mine); log(`✔ Upgraded prompt ${n} to v2`); }
    else log(`⚠ Kept your customised ${n} from v1. Compare it with ${path.join(U.BUILTIN_PROMPTS, n)} (v2 mentions OpenCode and best-of-2).`);
  }
  // 4) migrate v1 defaults.env → config.json
  const legacy = path.join(U.KIT_HOME, 'defaults.env');
  if (fs.existsSync(legacy) && !fs.existsSync(U.globalConfigPath())) {
    const txt = fs.readFileSync(legacy, 'utf8'); const cfg = {};
    const get = (k) => { const m = txt.match(new RegExp(`^\\s*${k}=(?:"([^"]*)"|(\\S*))`, 'm')); return m ? (m[1] ?? m[2]) : ''; };
    if (get('MAX_ROUNDS')) cfg.maxRounds = Number(get('MAX_ROUNDS'));
    if (get('OUTPUT_LANGUAGE')) cfg.outputLanguage = get('OUTPUT_LANGUAGE');
    if (get('GEMINI_APPROVAL')) cfg.gemini = { approval: get('GEMINI_APPROVAL') };
    if (get('GEMINI_MODEL')) cfg.gemini = { ...(cfg.gemini || {}), model: get('GEMINI_MODEL') };
    if (get('CLAUDE_MODEL')) cfg.claude = { model: get('CLAUDE_MODEL') };
    U.writeJsonAtomic(U.globalConfigPath(), cfg); fs.renameSync(legacy, `${legacy}.v1`);
    log('✔ Migrated v1 defaults.env to config.json');
  }
  if (!fs.existsSync(U.globalConfigPath())) U.writeJsonAtomic(U.globalConfigPath(), {});
  // 5) remove v1 leftovers that v2 no longer uses
  for (const f of ['hooks/architect_guard.sh', 'ai-kit.env.example']) fs.rmSync(path.join(U.KIT_HOME, f), { force: true });
  try { fs.rmdirSync(path.join(U.KIT_HOME, 'hooks')); } catch { /* not empty or missing */ }
}

function unsetup(log = console.log) {
  if (fs.existsSync(SETTINGS)) { backup(); fs.writeFileSync(SETTINGS, JSON.stringify(stripOurs(readSettings()), null, 2)); }
  fs.rmSync(path.join(CLAUDE_DIR, 'commands', 'delegate.md'), { force: true });
  log('✔ Hook and /delegate removed. Task data in your repositories (.ai/) and ~/.ai-kit were left in place.');
}
module.exports = { setup, unsetup };
