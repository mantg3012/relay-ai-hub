'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const U = require('./util');
const G = require('./git');
const { Task, listTasks } = require('./engine');
const { ADAPTERS } = require('./adapters');

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const AGENT_COLOR = { claude: C.magenta, gemini: C.blue, opencode: C.green };
const say = (c, s) => console.log(`${c}${s}${C.reset}`);
const die = (s) => { say(C.red, `✖ ${s}`); process.exit(1); };

const HELP = `ai-task — Claude audits, writes the spec and reviews; Gemini CLI / OpenCode implement.

USAGE
  ai-task ui [--port N] [--no-open]       Open the web dashboard (recommended)
  ai-task run "request" [options]         Start a task from the terminal
  ai-task run -f request.md               Read the request from a file
  ai-task run --spec spec.md "title"      Skip the audit, use an existing spec
  ai-task resume <ID> [-m "feedback"] [--rounds N]
  ai-task approve <ID>                    Approve a spec waiting for review
  ai-task list | show <ID> | merge <ID> | cancel <ID> | discard <ID>
  ai-task doctor

RUN OPTIONS
  --mode single|fallback|best-of-2        Implementer strategy (default from config)
  --impl gemini|opencode                  Primary implementer
  --secondary gemini|opencode             Used by fallback and best-of-2
  --rounds N                              Max implement → review rounds
  --yes                                   Do not pause for spec approval
`;

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-f' || a === '--file') o.file = next();
    else if (a === '--spec') o.spec = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--impl') o.impl = next();
    else if (a === '--secondary') o.secondary = next();
    else if (a === '--rounds') o.rounds = Number(next());
    else if (a === '-m') o.m = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--no-open') o.noOpen = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else o._.push(a);
  }
  return o;
}

function root() { try { return G.repoRoot(process.cwd()); } catch { die('Run this inside a git repository.'); } }

function printer(task) {
  let lastDeltaAgent = null;
  task.on('event', (ev) => {
    const ac = AGENT_COLOR[ev.agent] || C.cyan;
    switch (ev.type) {
      case 'status': say(C.cyan, `▸ ${ev.status.replace(/_/g, ' ')}${ev.round ? ` (round ${ev.round})` : ''}`); break;
      case 'agent':
        if (ev.kind === 'text') { const t = ev.text.trim().split('\n')[0].slice(0, 140); if (t) console.log(`  ${ac}${ev.agent}${C.reset} ${C.dim}${t}${C.reset}`); }
        else if (ev.kind === 'edit') console.log(`  ${ac}${ev.agent}${C.reset} ✎ ${ev.file || ev.text}`);
        else if (ev.kind === 'tool') console.log(`  ${ac}${ev.agent}${C.reset} ${C.dim}· ${ev.text.slice(0, 120)}${C.reset}`);
        else if (ev.kind === 'error') console.log(`  ${ac}${ev.agent}${C.reset} ${C.red}${ev.text}${C.reset}`);
        break;
      case 'gate': say(ev.ok ? C.green : C.red, `  gate ${ev.key}: ${ev.name} ${ev.ok ? 'PASS' : 'FAIL'}${ev.violations && ev.violations.length ? ' — ' + ev.violations.join('; ') : ''}`); break;
      case 'fallback': say(C.yellow, `⚠ ${ev.text}`); break;
      case 'selected': say(C.cyan, `▸ Best-of-2: candidate ${ev.winner} (${ADAPTERS[ev.agent].label}) selected`); break;
      case 'verdict': say(ev.verdict === 'APPROVE' ? C.green : C.yellow, `▸ Review round ${ev.round}: ${ev.verdict} (${ev.blockers} blocker, ${ev.majors} major)`); break;
      case 'usage': if (ev.input || ev.output) console.log(`  ${C.dim}${ev.agent} ${ev.step}: ${fmt(ev.input)} in / ${fmt(ev.output)} out${ev.cost ? ` · $${ev.cost.toFixed(4)}` : ''}${C.reset}`); break;
      case 'warning': say(C.yellow, `⚠ ${ev.text}`); break;
      case 'error': say(C.red, `✖ ${ev.text}`); break;
      case 'approved': say(C.green, `✔ Approved in round ${ev.round} — committed on branch ${ev.branch}`); break;
      default: break;
    }
    lastDeltaAgent = ev.agent || lastDeltaAgent;
  });
}
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));

async function approvalPrompt(task) {
  if (!process.stdin.isTTY) return; // the UI (or `ai-task approve`) can approve
  const spec = task.read('spec.md').split('\n');
  console.log('\n' + spec.slice(0, 60).join('\n') + `\n… full spec: ${task.file('spec.md')}\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const a = await new Promise((r) => rl.question('[Enter] approve · [e] edit · [q] stop (you can also approve in the UI): ', r));
    if (a === '') { task.approveSpec(); break; }
    if (a.toLowerCase() === 'e') { await new Promise((r) => spawn(process.env.EDITOR || 'nano', [task.file('spec.md')], { stdio: 'inherit' }).on('close', r)); }
    if (a.toLowerCase() === 'q') { rl.close(); say(C.cyan, `Paused. Continue later: ai-task approve ${task.id}  (or in the UI)`); process.exit(0); }
  }
  rl.close();
}

function finish(task) {
  const s = task.view();
  console.log('');
  const tot = Object.entries(s.usage || {}).map(([a, u]) => `${a}: ${fmt(u.input)} in / ${fmt(u.output)} out${u.cost ? ` ($${u.cost.toFixed(3)})` : ''}`).join(' · ');
  if (tot) say(C.dim, `Usage — ${tot}`);
  if (s.status === 'approved') {
    const w = s.candidates.find((c) => c.key === s.winner);
    console.log(`  Review the change : git diff ${s.originBranch}...${w.branch}`);
    console.log(`  Merge (squash)    : ai-task merge ${s.id}`);
  } else if (s.status === 'needs_human') {
    say(C.yellow, `Not approved after ${s.round} rounds.`);
    console.log(`  Read the review   : ai-task show ${s.id}`);
    console.log(`  Give feedback     : ai-task resume ${s.id} -m "your guidance"`);
  } else if (s.status === 'awaiting_approval') console.log(`  Approve the spec  : ai-task approve ${s.id}`);
}

async function main() {
  const [cmd = 'help', ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  switch (cmd) {
    case 'ui': {
      const { startServer, registerRepo } = require('./server');
      try { registerRepo(process.cwd()); } catch { /* not in a repo: fine */ }
      startServer({ port: o.port, onListen: (link) => {
        say(C.green, `✔ Relay is running on 127.0.0.1 (only this machine can reach it)`);
        console.log(`  Open: ${link}\n  Stop: Ctrl+C`);
        if (!o.noOpen) { const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'; try { spawn(opener, [link], { stdio: 'ignore', detached: true }).unref(); } catch { /* manual */ } }
      } });
      return;
    }
    case 'run': {
      const r = root();
      let request = o._.join(' ');
      if (o.file) request = fs.readFileSync(path.resolve(o.file), 'utf8');
      const specText = o.spec ? fs.readFileSync(path.resolve(o.spec), 'utf8') : null;
      if (!request && !specText) die('Describe the task. Example: ai-task run "add retry with backoff to the API client"');
      for (const b of ['claude']) if (!U.commandExists(b)) die(`'${b}' is not installed. Run: ai-task doctor`);
      const task = Task.create(r, { request: request || specText.split('\n')[0].replace(/^#\s*/, ''), specText, mode: o.mode, implementer: o.impl, secondary: o.secondary, maxRounds: o.rounds, reviewSpec: o.yes ? false : undefined });
      const s = task.state;
      for (const a of (s.mode === 'single' ? [s.implementer] : [s.implementer, s.secondary])) if (!U.commandExists(ADAPTERS[a].bin)) die(`'${ADAPTERS[a].bin}' is not installed (needed for ${s.mode}). Run: ai-task doctor`);
      say(C.green, `✔ Task ${s.id} · mode ${s.mode} · ${ADAPTERS[s.implementer].label}${s.mode !== 'single' ? ` + ${ADAPTERS[s.secondary].label}` : ''}`);
      const g = task.cfg.gates; say(C.dim, `  gates: setup=[${g.setup || '—'}] lint=[${g.lint || '—'}] typecheck=[${g.typecheck || '—'}] test=[${g.test || '—'}]`);
      printer(task);
      task.on('event', (ev) => { if (ev.type === 'status' && ev.status === 'awaiting_approval') approvalPrompt(task); });
      await task.run(); finish(task); process.exit(['approved'].includes(task.state.status) ? 0 : 1);
      break;
    }
    case 'resume': case 'approve': {
      const r = root(); const id = o._[0] || die('Task ID required. See: ai-task list');
      const task = new Task(r, id);
      if (cmd === 'approve') task.approveSpec(); else task.prepareResume({ feedback: o.m, rounds: o.rounds });
      if (task.isEngineAlive()) { say(C.green, '✔ Signal sent to the running task.'); return; }
      printer(task); await task.run(); finish(task); process.exit(task.state.status === 'approved' ? 0 : 1);
      break;
    }
    case 'list': case 'ls': {
      const tasks = listTasks(root());
      if (!tasks.length) return console.log('(no tasks yet)');
      for (const t of tasks) console.log(`${t.id}  ${t.status.padEnd(18)} r${t.round}/${t.roundLimit}  ${t.mode.padEnd(10)} ${t.title.slice(0, 60)}`);
      return;
    }
    case 'show': {
      const t = new Task(root(), o._[0] || die('Task ID required'));
      console.log('══════ SPEC ══════\n' + t.read('spec.md', '(none yet)'));
      if (t.state.round) console.log(`\n══════ REVIEW round ${t.state.round} ══════\n` + t.read(`r${t.state.round}-review.md`));
      console.log(`\nStatus: ${t.view().status}`);
      return;
    }
    case 'merge': { const t = new Task(root(), o._[0] || die('Task ID required')); const m = t.merge(); say(C.green, `✔ Squash-merged into ${m.into} (${m.commit.slice(0, 8)})`); return; }
    case 'cancel': { const t = new Task(root(), o._[0] || die('Task ID required')); t.requestCancel(); if (!t.isEngineAlive()) t.setState({ status: 'cancelled' }); say(C.green, '✔ Cancel requested.'); return; }
    case 'discard': case 'abort': { const t = new Task(root(), o._[0] || die('Task ID required')); if (t.isEngineAlive()) { t.requestCancel(); await U.sleep(3500); } t.discard(); say(C.green, '✔ Working copies and branches removed.'); return; }
    case 'setup': require('./setup').setup(); return;
    case 'unsetup': require('./setup').unsetup(); return;
    case 'doctor': {
      const { doctor } = require('./server');
      const d = await doctor();
      for (const [, v] of Object.entries(d)) say(v.present ? C.green : C.yellow, `${v.present ? '✔' : '⚠'} ${v.label}${v.version ? ` — ${v.version}` : v.present ? '' : ' — not installed'}${v.warning ? `\n   ${v.warning}` : ''}`);
      try { const r = G.repoRoot(process.cwd()); const cfg = U.loadConfig(r); say(C.green, `✔ repo ${r}`); console.log(`   gates: setup=[${cfg.gates.setup || '—'}] lint=[${cfg.gates.lint || '—'}] typecheck=[${cfg.gates.typecheck || '—'}] test=[${cfg.gates.test || '—'}]\n   mode=${cfg.mode} implementer=${cfg.implementer} secondary=${cfg.secondary} rounds=${cfg.maxRounds}`); } catch { /* not in repo */ }
      return;
    }
    default: console.log(HELP);
  }
}

main().catch((e) => die(e.message));
