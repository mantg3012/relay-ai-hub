'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const KIT_HOME = process.env.AI_KIT_HOME || path.join(os.homedir(), '.ai-kit');
const APP_DIR = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(KIT_HOME, 'prompts');           // your customised prompts
const BUILTIN_PROMPTS = path.join(APP_DIR, 'prompts');         // shipped defaults
/** Per-file lookup: a prompt you edited wins, otherwise the shipped default is used. */
function promptPath(name) {
  const custom = path.join(PROMPTS_DIR, name);
  return fs.existsSync(custom) ? custom : path.join(BUILTIN_PROMPTS, name);
}

const DEFAULT_CONFIG = {
  maxRounds: 3,
  outputLanguage: 'English',
  mode: 'single',               // single | fallback | best-of-2
  implementer: 'gemini',        // gemini | opencode
  secondary: 'opencode',        // used by fallback and best-of-2
  reviewSpec: true,             // pause for spec approval
  claude: { model: '', reviewModel: '', resumeReview: true },
  gemini: { model: '', approval: 'auto_edit', output: 'stream-json' },
  opencode: { model: '', approval: 'safe' },   // safe | yolo
  gates: { setup: '', lint: '', typecheck: '', test: '', timeoutSec: 900 },
  protectedGlobs: ['tests/*', 'test/*', '__tests__/*', '*/tests/*', '*/test/*', '*/__tests__/*',
    '*.test.*', '*.spec.*', '*_test.go', '*_test.py', 'test_*.py'],
  linkDirs: ['node_modules', '.venv', 'venv'],
  maxDiffBytes: 150000,
  ui: { port: 7788 },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Legacy v1 .ai-kit.env support (KEY="value", PROTECTED_GLOBS=( "a" "b" ))
function parseLegacyEnv(file) {
  const out = {};
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const get = (k) => { const m = txt.match(new RegExp(`^\\s*${k}=(?:"([^"]*)"|'([^']*)'|(\\S*))`, 'm')); return m ? (m[1] ?? m[2] ?? m[3]) : undefined; };
  const gates = {};
  for (const [k, g] of [['LINT_CMD', 'lint'], ['TYPECHECK_CMD', 'typecheck'], ['TEST_CMD', 'test'], ['SETUP_CMD', 'setup']]) {
    const v = get(k); if (v !== undefined) gates[g] = v;
  }
  if (Object.keys(gates).length) out.gates = gates;
  const mr = get('MAX_ROUNDS'); if (mr) out.maxRounds = Number(mr);
  const gm = get('GEMINI_MODEL'); if (gm) out.gemini = { ...(out.gemini || {}), model: gm };
  const ga = get('GEMINI_APPROVAL'); if (ga) out.gemini = { ...(out.gemini || {}), approval: ga };
  const cm = get('CLAUDE_MODEL'); if (cm) out.claude = { model: cm };
  const lang = get('OUTPUT_LANGUAGE'); if (lang) out.outputLanguage = lang;
  const pg = txt.match(/^\s*PROTECTED_GLOBS=\(([^)]*)\)/m);
  if (pg) out.protectedGlobs = [...pg[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] || m[2]);
  return out;
}

function globalConfigPath() { return path.join(KIT_HOME, 'config.json'); }
function loadConfig(repoRoot) {
  let cfg = deepMerge(DEFAULT_CONFIG, readJson(globalConfigPath(), {}));
  if (repoRoot) {
    cfg = deepMerge(cfg, parseLegacyEnv(path.join(repoRoot, '.ai-kit.env')));
    cfg = deepMerge(cfg, readJson(path.join(repoRoot, '.ai-kit.json'), {}));
    cfg.gates = autodetectGates(repoRoot, cfg.gates);
  }
  return cfg;
}

function autodetectGates(root, gates) {
  if (gates.lint || gates.typecheck || gates.test) return gates;
  const g = { ...gates };
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const scripts = (readJson(path.join(root, 'package.json'), {}).scripts) || {};
    if (scripts.lint) g.lint = `${pm} run lint`;
    if (scripts.typecheck) g.typecheck = `${pm} run typecheck`;
    if (scripts.test) g.test = `${pm} test`;
  } else if (has('go.mod')) { g.lint = 'go vet ./...'; g.test = 'go test ./...'; }
  else if (has('Cargo.toml')) { g.lint = 'cargo clippy -- -D warnings'; g.test = 'cargo test'; }
  else if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) { g.test = 'python -m pytest -q'; }
  return g;
}

// glob: '*' matches any run of characters (including '/'), '?' one char. Matches full path or basename.
function globToRegex(g) {
  return new RegExp('^' + g.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
}
function matchAny(file, globs) {
  const base = file.split('/').pop();
  return globs.some((g) => { const r = globToRegex(g); return r.test(file) || r.test(base); });
}

function commandExists(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * Spawn a process, feed stdin, stream stdout lines to onLine, collect stderr.
 * Returns { code, stdout, stderr, killed }. `signal` is an object { cancelled } polled for cancellation.
 */
function runProcess(cmd, args, { cwd, env, input, onLine, onStderr, timeoutMs, control } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd, env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', buf = '', killed = false, done = false;
    const kill = () => {
      if (done) return; killed = true;
      try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGTERM') : child.kill(); } catch { /* gone */ }
      setTimeout(() => { try { process.platform !== 'win32' ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    };
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    const poll = control ? setInterval(() => { if (control.cancelled()) kill(); }, 500) : null;
    child.stdout.on('data', (d) => {
      const s = d.toString(); stdout += s; buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (onLine) onLine(line); }
    });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onStderr) onStderr(s); });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => {
      done = true;
      if (buf && onLine) onLine(buf);
      if (timer) clearTimeout(timer); if (poll) clearInterval(poll);
      resolve({ code: code ?? 1, stdout, stderr, killed });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

function shellCmd(command) {
  return process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['bash', ['-lc', command]];
}

function newTaskId() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `T${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}
function repoKey(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 10); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function readText(file, fallback = '') { try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; } }

module.exports = {
  KIT_HOME, APP_DIR, PROMPTS_DIR, BUILTIN_PROMPTS, promptPath, DEFAULT_CONFIG, deepMerge, readJson, writeJsonAtomic,
  loadConfig, globalConfigPath, autodetectGates, matchAny, commandExists, runProcess, shellCmd,
  newTaskId, repoKey, sleep, pidAlive, readText, fsp,
};
