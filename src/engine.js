'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const U = require('./util');
const G = require('./git');
const { ADAPTERS, newAcc } = require('./adapters');

const RUNNING = new Set(['auditing', 'implementing', 'gating', 'reviewing', 'chatting_busy']);
class Cancelled extends Error { constructor() { super('Cancelled by user'); } }

function prompt(name) { return U.readText(U.promptPath(name)); }
function tail(s, n) { const lines = String(s).split('\n'); return lines.slice(-n).join('\n'); }

class Task extends EventEmitter {
  constructor(root, id) {
    super();
    this.root = root; this.id = id;
    this.dir = path.join(root, '.ai', 'tasks', id);
    this.ctl = path.join(this.dir, 'control');
    this.state = U.readJson(path.join(this.dir, 'state.json'), null);
    if (!this.state) throw new Error(`Task not found: ${id}`);
    this.cfg = U.loadConfig(root);
    this.seq = this._countEvents();
  }

  // ───────────── creation & persistence ─────────────
  static create(root, opts) {
    root = G.repoRoot(root);
    if (!G.tryGit(root, ['rev-parse', 'HEAD'])) throw new Error('The repository has no commits yet. Commit at least once.');
    G.ensureExcluded(root);
    const cfg = U.loadConfig(root);
    const id = U.newTaskId();
    const dir = path.join(root, '.ai', 'tasks', id);
    fs.mkdirSync(path.join(dir, 'control'), { recursive: true });
    const mode = opts.mode || cfg.mode;
    const implementer = opts.implementer || cfg.implementer;
    let secondary = opts.secondary || cfg.secondary;
    if (secondary === implementer) secondary = implementer === 'gemini' ? 'opencode' : 'gemini';
    const request = (opts.request || '').trim();
    const state = {
      id, repo: root, title: (opts.title || request.split('\n')[0] || 'Untitled task').slice(0, 90),
      status: 'created', stage: opts.discuss ? 'chat' : (opts.specText ? 'approval' : 'spec'),
      mode, implementer, secondary, reviewSpec: opts.reviewSpec ?? cfg.reviewSpec,
      base: G.head(root), originBranch: G.currentBranch(root),
      round: 0, roundLimit: Number(opts.maxRounds || cfg.maxRounds),
      candidates: [], winner: null, specSession: null, chatSession: null,
      usage: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      engine: null, error: null, verdict: null, fellBack: false,
    };
    fs.writeFileSync(path.join(dir, 'request.md'), request + '\n');
    if (opts.specText) fs.writeFileSync(path.join(dir, 'spec.md'), opts.specText);
    U.writeJsonAtomic(path.join(dir, 'state.json'), state);
    const t = new Task(root, id);
    t.emitEvent('task_created', { title: state.title, mode, implementer, secondary: mode === 'single' ? null : secondary });
    if (opts.discuss) t.setState({ status: 'chatting' });
    return t;
  }

  _countEvents() { const f = path.join(this.dir, 'events.jsonl'); if (!fs.existsSync(f)) return 0; return U.readText(f).split('\n').filter(Boolean).length; }
  emitEvent(type, data = {}) {
    const ev = { seq: ++this.seq, ts: new Date().toISOString(), type, ...data };
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    this.emit('event', ev);
    return ev;
  }
  setState(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    U.writeJsonAtomic(path.join(this.dir, 'state.json'), this.state);
    if (patch.status) this.emitEvent('status', { status: patch.status, round: this.state.round });
  }
  file(name) { return path.join(this.dir, name); }
  write(name, content) { fs.writeFileSync(this.file(name), content); }
  read(name, fb = '') { return U.readText(this.file(name), fb); }

  // ───────────── control plane (file based, works across CLI / UI processes) ─────────────
  cancelled() { return fs.existsSync(path.join(this.ctl, 'cancel')); }
  checkCancel() { if (this.cancelled()) throw new Cancelled(); }
  requestCancel() { fs.mkdirSync(this.ctl, { recursive: true }); fs.writeFileSync(path.join(this.ctl, 'cancel'), new Date().toISOString()); }
  approveSpec(content) {
    if (typeof content === 'string' && content.trim()) this.write('spec.md', content);
    fs.mkdirSync(this.ctl, { recursive: true }); fs.writeFileSync(path.join(this.ctl, 'approve'), new Date().toISOString());
  }
  async waitForApproval() {
    while (!fs.existsSync(path.join(this.ctl, 'approve'))) { this.checkCancel(); await U.sleep(400); }
  }
  isEngineAlive() { const e = this.state.engine; return !!(e && e.host === os.hostname() && U.pidAlive(e.pid)); }
  claim() {
    if (this.isEngineAlive() && this.state.engine.pid !== process.pid) throw new Error(`Task ${this.id} is already running in process ${this.state.engine.pid}`);
    this.setState({ engine: { pid: process.pid, host: os.hostname() } });
  }

  addUsage(agent, u, step) {
    const cur = this.state.usage[agent] || { input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 };
    const next = { input: cur.input + (u.input || 0), output: cur.output + (u.output || 0), cacheRead: cur.cacheRead + (u.cacheRead || 0), cost: +(cur.cost + (u.cost || 0)).toFixed(6), calls: cur.calls + 1 };
    this.setState({ usage: { ...this.state.usage, [agent]: next } });
    this.emitEvent('usage', { agent, step, ...u });
  }

  // ───────────── generic agent runner ─────────────
  async runAgent(agent, { step, cwd, input, promptFile, instruction, sessionId, model, logName }) {
    const ad = ADAPTERS[agent];
    const acc = newAcc();
    const exec = async (sid) => {
      const b = ad.build({ instruction, input, promptFile, cfg: this.cfg, sessionId: sid, model, taskDir: this.dir });
      const raw = fs.createWriteStream(this.file(logName), { flags: 'a' });
      raw.write(`\n# ${new Date().toISOString()} ${b.cmd} ${b.args.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}\n`);
      this.emitEvent('agent_start', { agent, step, resumed: !!sid });
      const res = await U.runProcess(b.cmd, b.args, {
        cwd, env: b.env, input: b.input,
        control: { cancelled: () => this.cancelled() },
        onLine: (line) => {
          raw.write(line + '\n');
          for (const e of ad.parse(line, acc)) {
            if (e.kind === 'delta') continue;
            this.emitEvent('agent', { agent, step, kind: e.kind, text: e.text, file: e.file || undefined });
          }
        },
        onStderr: (s) => raw.write(s),
      });
      raw.end();
      return res;
    };
    let res = await exec(sessionId);
    if (res.code !== 0 && sessionId && !this.cancelled() && /session|conversation|resume/i.test(res.stderr + res.stdout.slice(-2000)) && acc.edits === 0) {
      this.emitEvent('agent', { agent, step, kind: 'info', text: 'Could not resume the previous session; starting a fresh one.' });
      res = await exec(null);
    }
    if (this.cancelled()) throw new Cancelled();
    this.addUsage(agent, acc.usage, step);
    this.emitEvent('agent_end', { agent, step, code: res.code });
    return { res, acc, text: (acc.finalText ?? acc.text ?? '').trim(), quota: ad.isQuotaError(res) };
  }

  // ───────────── stages ─────────────
  async run() {
    this.claim();
    try { fs.rmSync(path.join(this.ctl, 'cancel'), { force: true }); } catch { /* none */ }
    try {
      const s = this.state;
      if (s.stage === 'chat') { this.setState({ status: 'chatting' }); return; }
      if (s.stage === 'spec') await this.stageSpec();
      if (this.state.stage === 'approval') await this.stageApproval();
      if (this.state.stage === 'implement') await this.stageRounds();
    } catch (e) {
      if (e instanceof Cancelled) { this.setState({ status: 'cancelled' }); this.emitEvent('note', { text: 'Task cancelled.' }); }
      else { this.setState({ status: 'failed', error: e.message }); this.emitEvent('error', { text: e.message }); }
    } finally {
      this.setState({ engine: null });
    }
    return this.state.status;
  }

  async stageSpec() {
    this.setState({ status: 'auditing' });
    const g = this.cfg.gates;
    const p = [prompt('architect.md'),
      `\n\nOUTPUT LANGUAGE: ${this.cfg.outputLanguage} (keep code identifiers, paths and fenced block names in English)`,
      '\n\n## REQUEST\n\n' + this.read('request.md'),
      `\n\n## QUALITY GATES THAT WILL RUN\n- lint: ${g.lint || '(none)'}\n- typecheck: ${g.typecheck || '(none)'}\n- test: ${g.test || '(none)'}\n`].join('');
    this.write('spec-prompt.md', p);
    const r = await this.runAgent('claude', { step: 'audit', cwd: this.root, input: p, logName: 'claude-audit.log' });
    if (!r.text) throw new Error('Claude returned no spec. See claude-audit.log');
    this.write('spec.md', r.text + '\n');
    this.setState({ specSession: r.acc.sessionId, stage: 'approval' });
    if (!extractAllowed(r.text).length) this.emitEvent('warning', { text: 'The spec has no ```allowed-files block; the scope check will only protect existing tests.' });
    this.emitEvent('spec_ready', {});
  }

  async stageApproval() {
    if (this.state.reviewSpec && !fs.existsSync(path.join(this.ctl, 'approve'))) {
      this.setState({ status: 'awaiting_approval' });
      await this.waitForApproval();
    }
    this.emitEvent('spec_approved', {});
    this.setupCandidates();
    this.setState({ stage: 'implement' });
  }

  setupCandidates() {
    if (this.state.candidates.length) return;
    const s = this.state;
    const agents = s.mode === 'best-of-2' ? [s.implementer, s.secondary] : [s.implementer];
    const cands = agents.map((agent, i) => {
      const key = agents.length > 1 ? 'ab'[i] : 'a';
      const branch = agents.length > 1 ? `ai/${s.id}-${key}` : `ai/${s.id}`;
      const worktree = path.join(this.root, '.ai', 'worktrees', agents.length > 1 ? `${s.id}-${key}` : s.id);
      if (!fs.existsSync(worktree)) G.addWorktree(this.root, worktree, branch, s.base);
      const linked = G.linkIgnoredDirs(this.root, worktree, this.cfg.linkDirs);
      this.emitEvent('worktree', { key, agent, branch, path: worktree, linked });
      return { key, agent, branch, worktree, sessionId: null, dropped: false, setupDone: false, lastGate: null };
    });
    this.setState({ candidates: cands });
  }
  updateCand(key, patch) { this.setState({ candidates: this.state.candidates.map((c) => (c.key === key ? { ...c, ...patch } : c)) }); }
  cand(key) { return this.state.candidates.find((c) => c.key === key); }

  async stageRounds() {
    while (this.state.round < this.state.roundLimit) {
      const round = this.state.round + 1;
      this.setState({ round });
      const active = this.state.candidates.filter((c) => !c.dropped);
      this.emitEvent('round_start', { round, candidates: active.map((c) => ({ key: c.key, agent: c.agent })) });

      this.setState({ status: 'implementing' });
      await Promise.all(active.map((c) => this.implement(c.key, round)));

      this.setState({ status: 'gating' });
      const gates = {};
      for (const c of active) gates[c.key] = await this.gates(c.key, round);

      this.setState({ status: 'reviewing' });
      const result = active.length > 1 ? await this.selectReview(active, gates, round) : await this.review(active[0], gates[active[0].key], round);
      const winner = this.cand(result.key);
      if (result.approve && gates[winner.key].pass) {
        const sha = G.commitAll(winner.worktree, `ai(${this.state.id}): ${this.state.title.slice(0, 60)}`,
          `Implemented by ${ADAPTERS[winner.agent].label}, reviewed by Claude Code. Rounds: ${round}. Artifacts: .ai/tasks/${this.state.id}`);
        for (const c of this.state.candidates) if (c.key !== winner.key) G.removeWorktree(this.root, c.worktree, c.branch);
        this.setState({ status: 'approved', winner: winner.key, verdict: 'APPROVE', commit: sha });
        this.emitEvent('approved', { round, key: winner.key, agent: winner.agent, branch: winner.branch, commit: sha });
        return;
      }
      this.emitEvent('round_end', { round, verdict: 'REQUEST_CHANGES', key: winner.key });
    }
    this.setState({ status: 'needs_human', verdict: 'REQUEST_CHANGES' });
    this.emitEvent('needs_human', { round: this.state.round });
  }

  buildImplPrompt(c, round) {
    const parts = [prompt('implementer.md'),
      `\n\nApproval mode for this run: ${c.agent === 'gemini' ? this.cfg.gemini.approval : (this.cfg.opencode.approval === 'yolo' ? 'yolo' : 'auto_edit')}`,
      '\n\n## SPEC\n\n' + this.read('spec.md')];
    const prevReview = this.read(`r${round - 1}-review.md`);
    if (prevReview && fs.existsSync(this.file(`r${round - 1}-${c.key}-gates.log`))) {
      parts.push(`\n\n## REVIEWER FEEDBACK FROM ROUND ${round - 1} (fix every BLOCKER and MAJOR)\n\n${prevReview}`);
      parts.push(`\n\n## GATE LOG FROM ROUND ${round - 1} (tail)\n\n\`\`\`\n${tail(this.read(`r${round - 1}-${c.key}-gates.log`), 60)}\n\`\`\`\n`);
    }
    if (fs.existsSync(this.file('human-feedback.md'))) parts.push('\n\n## FEEDBACK FROM THE HUMAN OWNER (highest priority)\n\n' + this.read('human-feedback.md'));
    return parts.join('');
  }

  async implement(key, round) {
    let c = this.cand(key);
    const promptName = `r${round}-${key}-impl-prompt.md`;
    const p = this.buildImplPrompt(c, round);
    this.write(promptName, p);
    let r = await this.runAgent(c.agent, { step: `implement r${round}`, cwd: c.worktree, input: p, promptFile: this.file(promptName), sessionId: c.sessionId, logName: `r${round}-${key}-${c.agent}.log` });
    if (r.quota && this.state.mode === 'fallback' && !this.state.fellBack) {
      const to = this.state.secondary;
      this.emitEvent('fallback', { from: c.agent, to, round, text: `${ADAPTERS[c.agent].label} hit a quota or rate limit. Switching to ${ADAPTERS[to].label}.` });
      this.updateCand(key, { agent: to, sessionId: null }); this.setState({ fellBack: true });
      c = this.cand(key);
      r = await this.runAgent(c.agent, { step: `implement r${round}`, cwd: c.worktree, input: p, promptFile: this.file(promptName), sessionId: null, logName: `r${round}-${key}-${c.agent}.log` });
    }
    if (r.res.code !== 0) this.emitEvent('warning', { text: `${ADAPTERS[c.agent].label} exited with code ${r.res.code}. Gates will still run.` });
    this.write(`r${round}-${key}-impl.md`, r.text || '');
    this.updateCand(key, { sessionId: r.acc.sessionId || c.sessionId });
    const q = path.join(c.worktree, 'QUESTIONS.md');
    if (fs.existsSync(q)) { fs.renameSync(q, this.file(`r${round}-${key}-questions.md`)); this.emitEvent('note', { text: `${ADAPTERS[c.agent].label} raised questions for the reviewer.` }); }
    if (fs.existsSync(this.file('human-feedback.md'))) fs.renameSync(this.file('human-feedback.md'), this.file(`human-feedback-used-r${round}.md`));
  }

  async gates(key, round) {
    const c = this.cand(key); const g = this.cfg.gates;
    const logFile = this.file(`r${round}-${key}-gates.log`);
    const lines = []; const log = (s) => lines.push(s);
    let pass = true; const results = [];
    const steps = [];
    if (g.setup && !c.setupDone) steps.push(['setup', g.setup]);
    for (const n of ['lint', 'typecheck', 'test']) if (g[n]) steps.push([n, g[n]]);
    for (const [name, cmd] of steps) {
      this.checkCancel();
      this.emitEvent('gate_start', { key, round, name, cmd });
      const [bin, args] = U.shellCmd(cmd);
      const res = await U.runProcess(bin, args, { cwd: c.worktree, env: { CI: 'true' }, timeoutMs: g.timeoutSec * 1000, control: { cancelled: () => this.cancelled() } });
      this.checkCancel();
      const ok = res.code === 0;
      log(`\n===== ${name.toUpperCase()}: ${cmd} =====\n${res.stdout}${res.stderr}\n[${name.toUpperCase()}] ${ok ? 'PASS' : 'FAIL'}${res.killed ? ' (timeout)' : ''}`);
      if (name === 'setup') { if (ok) this.updateCand(key, { setupDone: true }); }
      if (!ok) pass = false;
      results.push({ name, ok });
      this.emitEvent('gate', { key, round, name, ok });
    }
    if (!steps.length) log('(No gate commands configured — relying on the Claude review only)');
    // scope check
    const violations = scopeCheck(G.changedFiles(c.worktree, this.state.base), extractAllowed(this.read('spec.md')), this.cfg.protectedGlobs);
    const patch = G.diff(c.worktree, this.state.base);
    if (!patch.trim()) violations.push('The implementer produced no changes.');
    log('\n===== SCOPE CHECK =====\n' + (violations.length ? violations.map((v) => `VIOLATION: ${v}`).join('\n') : 'OK') + `\n[SCOPE] ${violations.length ? 'FAIL' : 'PASS'}`);
    if (violations.length) pass = false;
    results.push({ name: 'scope', ok: !violations.length });
    this.emitEvent('gate', { key, round, name: 'scope', ok: !violations.length, violations });
    fs.writeFileSync(logFile, lines.join('\n'));
    this.write(`r${round}-${key}.patch`, patch);
    this.write(`r${round}-${key}.stat`, G.diffStat(c.worktree, this.state.base));
    this.updateCand(key, { lastGate: { round, pass, results } });
    this.emitEvent('gates_done', { key, round, pass, results });
    return { pass, results, log: lines.join('\n'), patch };
  }

  candidateBlock(c, gate, round, label, budget) {
    const rel = (p) => path.relative(this.root, p);
    const qs = this.read(`r${round}-${c.key}-questions.md`);
    const impl = this.read(`r${round}-${c.key}-impl.md`);
    return [`\n\n## ${label} — implemented by ${ADAPTERS[c.agent].label}`,
      `Working copy (read files here): ${rel(c.worktree)}/`,
      `Full patch file: ${rel(this.file(`r${round}-${c.key}.patch`))}`,
      `\n### Deterministic gate result: ${gate.pass ? 'PASS' : 'FAIL'}\n\`\`\`\n${tail(gate.log, 120)}\n\`\`\``,
      qs ? `\n### Questions raised by the implementer (answer them)\n\n${qs}` : '',
      impl ? `\n### Implementer summary (self-reported, verify it)\n\n${impl.slice(0, 6000)}` : '',
      `\n### Diff stat\n\`\`\`\n${this.read(`r${round}-${c.key}.stat`)}\n\`\`\``,
      `\n### Diff vs base (may be truncated; read the patch file or the working copy for full content)\n\`\`\`diff\n${gate.patch.slice(0, budget)}\n\`\`\``].join('\n');
  }

  async runReviewer(p, round) {
    this.write(`r${round}-review-prompt.md`, p);
    const resume = this.cfg.claude.resumeReview ? this.state.specSession : null;
    const r = await this.runAgent('claude', { step: `review r${round}`, cwd: this.root, input: p, sessionId: resume, model: this.cfg.claude.reviewModel || undefined, logName: `r${round}-claude-review.log` });
    if (r.acc.sessionId && this.cfg.claude.resumeReview) this.setState({ specSession: r.acc.sessionId });
    const text = r.text || 'Reviewer returned no output.\nVERDICT: REQUEST_CHANGES';
    this.write(`r${round}-review.md`, text + '\n');
    return text;
  }

  async review(c, gate, round) {
    const p = [prompt('reviewer.md'),
      `\n\nOUTPUT LANGUAGE: ${this.cfg.outputLanguage} (keep the final VERDICT line in English exactly as specified)`,
      `\nROUND: ${round} of max ${this.state.roundLimit} · BASE COMMIT: ${this.state.base}`,
      '\n\n## SPEC\n\n' + this.read('spec.md'),
      this.candidateBlock(c, gate, round, 'CANDIDATE', this.cfg.maxDiffBytes)].join('');
    const text = await this.runReviewer(p, round);
    const approve = parseVerdict(text) === 'APPROVE';
    this.emitEvent('verdict', { round, key: c.key, verdict: approve ? 'APPROVE' : 'REQUEST_CHANGES', gate: gate.pass, ...countIssues(text) });
    return { key: c.key, approve };
  }

  async selectReview(active, gates, round) {
    const [a, b] = active;
    const p = [prompt('selector.md'),
      `\n\nOUTPUT LANGUAGE: ${this.cfg.outputLanguage} (keep the WINNER and VERDICT lines in English exactly as specified)`,
      `\nROUND: ${round} of max ${this.state.roundLimit} · BASE COMMIT: ${this.state.base}`,
      '\n\n## SPEC\n\n' + this.read('spec.md'),
      this.candidateBlock(a, gates[a.key], round, 'CANDIDATE A', this.cfg.maxDiffBytes / 2),
      this.candidateBlock(b, gates[b.key], round, 'CANDIDATE B', this.cfg.maxDiffBytes / 2)].join('');
    const text = await this.runReviewer(p, round);
    let w = (text.match(/WINNER:\s*[*_ ]*([AB])\b/i) || [])[1];
    if (!w) w = gates[a.key].pass || !gates[b.key].pass ? 'A' : 'B';
    const winKey = w.toUpperCase() === 'A' ? a.key : b.key;
    const loser = active.find((c) => c.key !== winKey);
    this.updateCand(loser.key, { dropped: true });
    const approve = parseVerdict(text) === 'APPROVE';
    this.emitEvent('selected', { round, winner: winKey, agent: this.cand(winKey).agent, loser: loser.key });
    this.emitEvent('verdict', { round, key: winKey, verdict: approve ? 'APPROVE' : 'REQUEST_CHANGES', gate: gates[winKey].pass, ...countIssues(text) });
    return { key: winKey, approve };
  }

  // ───────────── spec chat ─────────────
  async chat(message) {
    if (this.state.stage !== 'chat') throw new Error('Spec chat is only available before the spec is approved.');
    this.claim();
    const history = this.chatHistory();
    const first = !this.state.chatSession;
    const p = first
      ? [prompt('spec-chat.md'), '\n\n## SPEC FORMAT YOU WILL PRODUCE LATER\n\n', prompt('architect.md'),
        `\n\nCONVERSATION LANGUAGE: reply in the language the user writes in. The final spec must be in ${this.cfg.outputLanguage}.`,
        '\n\n## INITIAL REQUEST\n\n', this.read('request.md'), '\n\n## USER MESSAGE\n\n', message].join('')
      : message;
    this.appendChat('user', message);
    this.setState({ status: 'chatting_busy' });
    try {
      const r = await this.runAgent('claude', { step: 'spec chat', cwd: this.root, input: p, sessionId: this.state.chatSession,
        instruction: first ? undefined : 'Continue the conversation. The user\'s new message is on stdin.', logName: 'claude-chat.log' });
      const reply = r.text || '(no reply)';
      this.appendChat('assistant', reply);
      this.setState({ chatSession: r.acc.sessionId || this.state.chatSession, status: 'chatting' });
      return { reply, history: [...history, { role: 'user', text: message }, { role: 'assistant', text: reply }] };
    } catch (e) {
      this.setState({ status: 'chatting' }); throw e;
    } finally { this.setState({ engine: null }); }
  }
  chatHistory() { return U.readText(this.file('chat.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  appendChat(role, text) {
    fs.appendFileSync(this.file('chat.jsonl'), JSON.stringify({ role, text, ts: new Date().toISOString() }) + '\n');
    this.emitEvent('chat', { role, text });
  }
  async generateSpecFromChat() {
    if (!this.state.chatSession) throw new Error('Start the conversation first.');
    this.claim();
    this.setState({ status: 'auditing' });
    try {
      const r = await this.runAgent('claude', { step: 'write spec', cwd: this.root, sessionId: this.state.chatSession,
        input: 'We are done discussing. Now write the final spec in exactly the format defined earlier (the architect spec format). Print ONLY the spec document.',
        instruction: 'Follow the instruction on stdin.', logName: 'claude-chat.log' });
      if (!r.text) throw new Error('Claude returned no spec.');
      this.write('spec.md', r.text + '\n');
      this.setState({ specSession: r.acc.sessionId, stage: 'approval', status: 'awaiting_approval' });
      this.emitEvent('spec_ready', { fromChat: true });
    } catch (e) {
      this.setState({ status: 'chatting' }); throw e;
    } finally { this.setState({ engine: null }); }
  }

  // ───────────── lifecycle actions ─────────────
  prepareResume({ feedback, rounds } = {}) {
    if (this.isEngineAlive()) throw new Error('Task is still running.');
    if (feedback && feedback.trim()) this.write('human-feedback.md', feedback.trim() + '\n');
    try { fs.rmSync(path.join(this.ctl, 'cancel'), { force: true }); } catch { /* none */ }
    const add = Number(rounds || this.cfg.maxRounds);
    if (this.state.stage === 'implement') {
      const live = this.state.candidates.filter((c) => !c.dropped);
      if (this.state.round >= this.state.roundLimit || ['needs_human', 'failed', 'cancelled', 'interrupted'].includes(this.state.status)) {
        this.setState({ roundLimit: this.state.round + add, status: 'implementing', error: null });
      }
      if (!live.length) throw new Error('No working copy left to continue.');
    }
  }

  merge() {
    const s = this.state;
    if (s.status !== 'approved') throw new Error('Only approved tasks can be merged.');
    const w = this.cand(s.winner);
    if (!G.isClean(this.root)) throw new Error('Your main working tree has uncommitted changes. Commit or stash them, then merge.');
    const into = G.currentBranch(this.root);
    try { G.git(this.root, ['merge', '--squash', w.branch]); } catch (e) {
      G.tryGit(this.root, ['reset', '--merge']);
      throw new Error(`Merge conflict while squashing ${w.branch} into ${into}. Nothing was changed. Resolve manually: git merge --squash ${w.branch}`);
    }
    const sha = G.commitAll(this.root, `${s.title.slice(0, 70)}`, `Squashed from ${w.branch} (${ADAPTERS[w.agent].label} + Claude review, task ${s.id}).`);
    G.removeWorktree(this.root, w.worktree, w.branch);
    this.setState({ status: 'merged', mergedInto: into, mergeCommit: sha });
    this.emitEvent('merged', { into, commit: sha });
    return { into, commit: sha };
  }

  discard() {
    if (this.isEngineAlive()) throw new Error('Cancel the task before discarding it.');
    for (const c of this.state.candidates) G.removeWorktree(this.root, c.worktree, c.branch);
    this.setState({ status: 'discarded' });
    this.emitEvent('note', { text: 'Working copies and branches removed.' });
  }

  view() {
    let status = this.state.status;
    if (RUNNING.has(status) && !this.isEngineAlive()) status = 'interrupted';
    return { ...this.state, status, engineAlive: this.isEngineAlive() };
  }
}

// ───────────── helpers ─────────────
function extractAllowed(spec) {
  const m = String(spec).match(/```allowed-files[^\n]*\n([\s\S]*?)```/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^[-*\s]+/, '').trim()).filter((l) => l && !l.startsWith('#'));
}
function scopeCheck(changes, allowed, protectedGlobs) {
  const v = [];
  for (const { status, file } of changes) {
    if (file.startsWith('.ai/') || file === 'QUESTIONS.md') continue;
    const isTest = U.matchAny(file, protectedGlobs);
    const listedExact = allowed.includes(file);
    if (isTest && status !== 'A' && !listedExact) { v.push(`modified or deleted an existing test: ${file} (${status})`); continue; }
    if (allowed.length && !(isTest && status === 'A') && !U.matchAny(file, allowed)) v.push(`changed a file outside the spec scope: ${file} (${status})`);
  }
  return v;
}
function parseVerdict(text) {
  const t = String(text).trim().split('\n').slice(-8).join('\n');
  if (/VERDICT:[*_ ]*APPROVE/i.test(t)) return 'APPROVE';
  return 'REQUEST_CHANGES';
}
function countIssues(text) {
  const c = (re) => (String(text).match(re) || []).length;
  return { blockers: c(/\[BLOCKER\]/gi), majors: c(/\[MAJOR\]/gi), minors: c(/\[MINOR\]/gi) };
}

function listTasks(root) {
  const dir = path.join(root, '.ai', 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => d.startsWith('T')).sort().reverse().map((id) => {
    try { return new Task(root, id).view(); } catch { return null; }
  }).filter(Boolean);
}

module.exports = { Task, listTasks, extractAllowed, scopeCheck, parseVerdict, Cancelled };
