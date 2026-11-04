'use strict';
/* Relay dashboard — vanilla JS, no build step. Talks to the local ai-task server. */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AGENTS = { claude: 'Claude', gemini: 'Gemini', opencode: 'OpenCode', you: 'You' };
const STATUS = {
  created: ['Queued', 'running'], auditing: ['Claude is auditing', 'running'], chatting: ['Discussing the spec', 'waiting'],
  chatting_busy: ['Claude is replying', 'running'], awaiting_approval: ['Waiting for your approval', 'waiting'],
  implementing: ['Implementing', 'running'], gating: ['Running checks', 'running'], reviewing: ['Claude is reviewing', 'running'],
  approved: ['Approved', 'good'], merged: ['Merged', 'good'], needs_human: ['Needs your input', 'waiting'],
  failed: ['Failed', 'badd'], cancelled: ['Cancelled', ''], interrupted: ['Interrupted', 'waiting'], discarded: ['Discarded', ''],
};
const MODES = { single: 'Single', fallback: 'Fallback', 'best-of-2': 'Best of 2' };
const S = { repos: [], tasks: [], meta: null, repoFilter: localStorage.getItem('relay.repo') || '', task: null, events: [], es: null, tab: 'activity', feedFilter: 'all', chatPending: false };

// ───────────── api ─────────────
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.error) || data || `Request failed (${r.status})`);
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2800);
}
function confirmBox(title, body, ok = 'Confirm') {
  const d = $('#confirm'); $('#confirmTitle').textContent = title; $('#confirmBody').textContent = body; $('#confirmOk').textContent = ok;
  d.showModal(); return new Promise((res) => d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true }));
}
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const fmtCost = (c) => (c ? `$${c.toFixed(c < 0.1 ? 4 : 2)}` : '—');
const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(iso).toLocaleDateString(); };
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const agentTag = (a) => `<span class="agent ${esc(a)}">${esc(AGENTS[a] || a)}</span>`;
const chip = (status) => { const [label, cls] = STATUS[status] || [status, '']; return `<span class="chip ${cls}">${esc(label)}</span>`; };
const implLabel = (t) => (t.mode === 'single' ? agentTag(t.implementer) : `${agentTag(t.implementer)} + ${agentTag(t.secondary)}`);

// ───────────── markdown (escape first, then a small safe subset) ─────────────
function md(src) {
  const lines = esc(src).split('\n'); const out = []; let i = 0;
  const inline = (s) => s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${buf.join('\n')}</code></pre>`); continue; }
    if (/^#{1,4}\s/.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`); i++; continue; }
    if (/^\|/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const row = (r) => r.replace(/^\||\|\s*$/g, '').split('|').map((c) => inline(c.trim()));
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*]|\d+\.)\s/, ''); i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) item += '<br>' + lines[i++].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    if (/^VERDICT:|^WINNER:/.test(l.trim())) { out.push(`<p class="verdict">${inline(l)}</p>`); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return `<div class="md">${out.join('')}</div>`;
}
function diffHtml(patch) {
  if (!patch.trim()) return '<div class="diff"><div>No changes.</div></div>';
  return `<div class="diff">${patch.split('\n').map((l) => {
    const c = l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : '';
    return `<div class="${c}">${esc(l) || ' '}</div>`;
  }).join('')}</div>`;
}

// ───────────── data ─────────────
async function refreshList() {
  try {
    [S.repos, S.tasks] = await Promise.all([api('GET', '/api/repos'), api('GET', '/api/tasks')]);
  } catch (e) { return toast(e.message, true); }
  const sel = $('#repoFilter');
  sel.innerHTML = `<option value="">All repositories</option>${S.repos.map((r) => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('')}`;
  sel.value = S.repos.some((r) => r.key === S.repoFilter) ? S.repoFilter : '';
  renderRail();
}
function renderRail() {
  const list = S.tasks.filter((t) => !S.repoFilter || t.repoKey === S.repoFilter);
  const cur = S.task ? `${S.task.repoKey}/${S.task.id}` : '';
  $('#taskList').innerHTML = list.map((t) => {
    const [, cls] = STATUS[t.status] || ['', ''];
    return `<li><a href="#/t/${esc(t.repoKey)}/${esc(t.id)}" ${cur === `${t.repoKey}/${t.id}` ? 'aria-current="page"' : ''}>
      <span class="dot ${cls}"></span><span class="t-title">${esc(t.title)}</span>
      <span class="t-meta"><span>${esc((STATUS[t.status] || [t.status])[0])}</span><span>${esc(S.repoFilter ? '' : t.repoName)}</span><span>${ago(t.createdAt)}</span></span></a></li>`;
  }).join('');
  $('#railEmpty').hidden = list.length > 0;
}

// ───────────── router ─────────────
function route() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (S.es && !(h[0] === 't' && S.task && h[1] === S.task.repoKey && h[2] === S.task.id)) { S.es.close(); S.es = null; S.task = null; S.events = []; }
  if (h[0] === 'new') return viewNew();
  if (h[0] === 'settings') return viewSettings();
  if (h[0] === 't' && h[1] && h[2]) return openTask(h[1], h[2]);
  S.task = null; renderRail(); return viewHome();
}

// ───────────── home ─────────────
async function viewHome() {
  if (!S.meta) S.meta = await api('GET', '/api/meta').catch(() => null);
  const totals = {};
  for (const t of S.tasks) for (const [a, u] of Object.entries(t.usage || {})) {
    const x = totals[a] || (totals[a] = { input: 0, output: 0, cacheRead: 0, cost: 0, calls: 0 });
    x.input += u.input; x.output += u.output; x.cacheRead += u.cacheRead || 0; x.cost += u.cost || 0; x.calls += u.calls || 0;
  }
  const ag = S.meta ? S.meta.agents : {};
  $('#view').innerHTML = `<section class="hero">
    <h1>Hand the build to Gemini or OpenCode. Keep Claude on audit and review.</h1>
    <p class="hint">Claude reads your code and writes a precise spec. An implementer builds it in its own working copy. Checks and Claude’s review decide whether it ships. You approve the spec and the merge.</p>
    <div class="flow">${agentTag('claude')} audits <span class="sep">›</span> ${agentTag('you')} approve <span class="sep">›</span> ${agentTag('gemini')} / ${agentTag('opencode')} build <span class="sep">›</span> checks <span class="sep">›</span> ${agentTag('claude')} reviews <span class="sep">›</span> ${agentTag('you')} merge</div>
    <div class="row"><a class="btn primary" href="#/new">Start a task</a></div>
    <ul class="agents">${['claude', 'gemini', 'opencode'].map((k) => { const a = ag[k] || {}; return `<li>${agentTag(k)} <span class="hint">${a.present ? esc(a.version || 'installed') : 'not installed'}</span>${a.warning ? `<div class="hint">${esc(a.warning)}</div>` : ''}</li>`; }).join('')}</ul>
  </section>
  <section class="narrow" style="margin-top:2.2rem">
    <h2>Where your tokens went</h2>
    ${Object.keys(totals).length ? usageTable(totals) + '<p class="hint" style="margin-top:.6rem">Totals across all tasks. Compare Claude’s share with the implementers’ to see whether delegating saves Claude usage in your repos.</p>' : '<p class="hint">Usage appears here after your first task.</p>'}
  </section>
  <section class="narrow" style="margin-top:2rem">
    <h2>Repositories</h2>
    ${S.repos.length ? `<ul>${S.repos.map((r) => `<li><b>${esc(r.name)}</b> <span class="hint mono">${esc(r.path)}</span></li>`).join('')}</ul>` : '<p class="hint">Add a git repository to start.</p>'}
    ${addRepoForm()}
  </section>`;
  bindAddRepo();
}
function addRepoForm() {
  return `<form id="addRepo" class="row" style="margin-top:.6rem"><input type="text" name="path" placeholder="/path/to/your/repo" aria-label="Repository path" style="max-width:420px"><button class="btn">Add repository</button></form>`;
}
function bindAddRepo(after) {
  const f = $('#addRepo'); if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/repos', { path: f.path.value.trim() }); toast('Repository added'); await refreshList(); (after || route)(); } catch (err) { toast(err.message, true); }
  });
}
function usageTable(u) {
  const rows = Object.entries(u); const max = Math.max(1, ...rows.map(([, x]) => x.input + x.output));
  const tot = rows.reduce((a, [, x]) => ({ input: a.input + x.input, output: a.output + x.output, cost: a.cost + (x.cost || 0) }), { input: 0, output: 0, cost: 0 });
  return `<table class="usage"><thead><tr><th>Agent</th><th>Input</th><th>Output</th><th>Cache read</th><th>Calls</th><th>Cost</th><th style="width:28%">Share of tokens</th></tr></thead><tbody>
  ${rows.map(([a, x]) => `<tr><td>${agentTag(a)}</td><td>${fmtN(x.input)}</td><td>${fmtN(x.output)}</td><td>${fmtN(x.cacheRead)}</td><td>${x.calls || 0}</td><td>${fmtCost(x.cost)}</td>
    <td><div class="bar"><i style="width:${((x.input + x.output) / max) * 100}%;background:var(--${esc(a)})"></i></div></td></tr>`).join('')}
  <tr><td><b>Total</b></td><td><b>${fmtN(tot.input)}</b></td><td><b>${fmtN(tot.output)}</b></td><td></td><td></td><td><b>${fmtCost(tot.cost)}</b></td><td></td></tr></tbody></table>
  <p class="hint">Cost shows only when a CLI reports it. Subscription plans count against your plan limits instead.</p>`;
}

// ───────────── new task ─────────────
async function viewNew() {
  S.task = null; renderRail();
  if (!S.meta) S.meta = await api('GET', '/api/meta').catch(() => null);
  const cfg = S.meta ? S.meta.config : { mode: 'single', implementer: 'gemini', secondary: 'opencode', maxRounds: 3, reviewSpec: true };
  const repoOpts = S.repos.map((r) => `<option value="${esc(r.key)}" ${r.key === S.repoFilter ? 'selected' : ''}>${esc(r.name)} — ${esc(r.path)}</option>`).join('');
  const implOpt = (v) => ['gemini', 'opencode'].map((a) => `<option value="${a}" ${a === v ? 'selected' : ''}>${AGENTS[a]}</option>`).join('');
  $('#view').innerHTML = `<div class="narrow">
  <h1 style="margin-bottom:1.2rem">New task</h1>
  ${S.repos.length ? '' : `<div class="callout"><p>Add the repository you want to work on first.</p></div>${addRepoForm()}<hr style="border:0;border-top:1px solid var(--line);margin:1.4rem 0">`}
  <form id="newTask">
    <label class="field"><span>Repository</span><select name="repoKey" required>${repoOpts}</select></label>
    <label class="field"><span>What should be built?</span><textarea name="request" rows="5" placeholder="Add retry with exponential backoff (max 3 attempts) to the payment API client. Keep the public interface unchanged."></textarea>
      <span class="hint">Be specific about behaviour and constraints. Claude turns this into a spec with acceptance criteria.</span></label>
    <fieldset><legend>How should the spec be made?</legend>
      <div class="choices">
        <label class="choice"><input type="radio" name="start" value="audit" checked><b>Claude writes it</b><span>Claude audits the code and writes the spec on its own.</span></label>
        <label class="choice"><input type="radio" name="start" value="discuss"><b>Discuss first</b><span>Chat with Claude about the requirement, then ask it to write the spec.</span></label>
        <label class="choice"><input type="radio" name="start" value="spec"><b>I have a spec</b><span>Paste a spec, for example one written with /delegate.</span></label>
      </div>
      <label class="field" id="specField" hidden><span>Spec</span><textarea name="specText" class="code" placeholder="# Spec: …"></textarea></label>
    </fieldset>
    <fieldset><legend>Who builds it?</legend>
      <div class="choices">
        <label class="choice"><input type="radio" name="mode" value="single" ${cfg.mode === 'single' ? 'checked' : ''}><b>Single</b><span>One implementer. Lowest token use.</span></label>
        <label class="choice"><input type="radio" name="mode" value="fallback" ${cfg.mode === 'fallback' ? 'checked' : ''}><b>Fallback</b><span>Switches to the second implementer if the first hits a quota or rate limit.</span></label>
        <label class="choice"><input type="radio" name="mode" value="best-of-2" ${cfg.mode === 'best-of-2' ? 'checked' : ''}><b>Best of 2</b><span>Both build in parallel; Claude picks the better one. Roughly doubles implementer tokens.</span></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Implementer</span><select name="implementer">${implOpt(cfg.implementer)}</select></label>
        <label class="field" id="secField"><span>Second implementer</span><select name="secondary">${implOpt(cfg.secondary)}</select></label>
      </div>
    </fieldset>
    <div class="grid2">
      <label class="field"><span>Maximum rounds</span><input type="number" name="maxRounds" min="1" max="10" value="${Number(cfg.maxRounds) || 3}"></label>
      <label class="field"><span>Spec approval</span><select name="reviewSpec"><option value="1" ${cfg.reviewSpec ? 'selected' : ''}>Let me approve the spec first</option><option value="0" ${cfg.reviewSpec ? '' : 'selected'}>Start building right away</option></select></label>
    </div>
    <div class="row"><button class="btn primary" ${S.repos.length ? '' : 'disabled'}>Start task</button><a href="#/" class="btn ghost">Cancel</a></div>
  </form></div>`;
  bindAddRepo(viewNew);
  const f = $('#newTask');
  const sync = () => {
    $('#specField').hidden = f.start.value !== 'spec';
    $('#secField').hidden = f.mode.value === 'single';
    f.reviewSpec.disabled = f.start.value === 'discuss';
  };
  f.addEventListener('change', sync); sync();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (f.mode.value !== 'single' && f.implementer.value === f.secondary.value) return toast('Pick two different implementers for this strategy.', true);
    const body = { repoKey: f.repoKey.value, request: f.request.value, mode: f.mode.value, implementer: f.implementer.value, secondary: f.secondary.value,
      maxRounds: Number(f.maxRounds.value), reviewSpec: f.reviewSpec.value === '1', discuss: f.start.value === 'discuss',
      specText: f.start.value === 'spec' ? f.specText.value : undefined };
    try { const r = await api('POST', '/api/tasks', body); await refreshList(); location.hash = `#/t/${r.repoKey}/${r.id}${body.discuss ? '/spec' : ''}`; }
    catch (err) { toast(err.message, true); }
  });
}

// ───────────── task detail ─────────────
async function openTask(rk, id) {
  const tabFromHash = location.hash.split('/')[4];
  if (tabFromHash) S.tab = tabFromHash;
  const same = S.task && S.task.repoKey === rk && S.task.id === id;
  try { const t = await api('GET', `/api/tasks/${rk}/${id}`); S.task = { ...t, repoKey: rk }; }
  catch (e) { $('#view').innerHTML = `<div class="callout badd"><p>${esc(e.message)}</p></div>`; return; }
  renderRail();
  if (!same) {
    S.events = []; S.chatPending = false; S.sel = null;
    if (!tabFromHash) S.tab = S.task.stage === 'chat' || S.task.status === 'awaiting_approval' ? 'spec' : S.task.status === 'needs_human' ? 'review' : 'activity';
    if (S.es) S.es.close();
    S.es = new EventSource(`/api/tasks/${rk}/${id}/events?since=0`);
    S.es.onmessage = (m) => { const ev = JSON.parse(m.data); S.events.push(ev); onEvent(ev); };
  }
  renderTask();
}
let refreshTimer = null;
function onEvent(ev) {
  if (S.tab === 'activity') appendFeed(ev);
  if (ev.type === 'chat' && ev.role === 'assistant') S.chatPending = false;
  if (['status', 'spec_ready', 'verdict', 'approved', 'merged', 'gates_done', 'usage', 'chat', 'error', 'selected', 'fallback', 'round_start', 'worktree'].includes(ev.type)) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (!S.task) return;
      try { const t = await api('GET', `/api/tasks/${S.task.repoKey}/${S.task.id}`); S.task = { ...t, repoKey: S.task.repoKey }; renderTask(true); refreshList(); } catch { /* ignore */ }
    }, 250);
  }
}

function legs(t) {
  const ev = S.events; const L = [];
  const st = t.status; const running = STATUS[st] && STATUS[st][1] === 'running';
  if (t.chat && t.chat.length || t.stage === 'chat') L.push({ who: ['claude', 'you'], what: 'Discuss', state: t.stage === 'chat' ? 'active' : 'done' });
  const specDone = !!t.spec.trim();
  L.push({ who: ['claude'], what: 'Audit and spec', state: specDone ? 'done' : st === 'auditing' ? 'active' : t.stage === 'chat' ? 'pending' : st === 'failed' ? 'fail' : 'pending' });
  L.push({ who: ['you'], what: t.reviewSpec ? 'Approve spec' : 'Auto-approved', state: t.stage === 'implement' ? 'done' : st === 'awaiting_approval' ? 'active' : 'pending' });
  const rounds = Math.max(t.round, t.stage === 'implement' ? 1 : 0);
  for (let r = 1; r <= rounds; r++) {
    const rs = ev.filter((e) => e.type === 'round_start' && e.round === r).pop();
    const ran = [...new Set(ev.filter((e) => e.type === 'agent_start' && e.step === `implement r${r}`).map((e) => e.agent))];
    const planned = rs ? rs.candidates.map((c) => c.agent) : (t.candidates || []).filter((c) => !c.dropped).map((c) => c.agent);
    const fell = ev.some((e) => e.type === 'fallback' && e.round === r);
    const who = fell ? ran.filter((a) => a !== ev.find((e) => e.type === 'fallback' && e.round === r).from) : (ran.length ? ran : planned);
    const gates = ev.filter((e) => e.type === 'gates_done' && e.round === r);
    const verdict = ev.filter((e) => e.type === 'verdict' && e.round === r).pop();
    const cur = r === t.round;
    const implState = gates.length || verdict ? 'done' : cur && st === 'implementing' ? 'active' : cur && !running && !gates.length ? 'fail' : 'pending';
    L.push({ who, what: `Build · round ${r}${fell ? ' (fallback)' : ''}`, state: implState });
    const passed = gates.filter((g) => g.pass).length;
    const checksLabel = gates.length > 1 ? `Checks · ${passed} of ${gates.length} passed` : 'Checks';
    const checksState = gates.length && (!cur || st !== 'gating') ? (passed ? 'done' : 'fail') : cur && st === 'gating' ? 'active' : 'pending';
    L.push({ who: [], what: checksLabel, state: checksState, color: 'var(--muted)' });
    L.push({ who: ['claude'], what: verdict ? (verdict.verdict === 'APPROVE' ? 'Approved' : 'Changes requested') : 'Review', state: verdict ? (verdict.verdict === 'APPROVE' ? 'done' : 'fail') : cur && st === 'reviewing' ? 'active' : 'pending' });
  }
  const left = t.roundLimit - rounds;
  if (!['approved', 'merged'].includes(st) && left > 0) L.push({ who: [], what: `${left} more round${left > 1 ? 's' : ''} allowed`, state: 'pending' });
  L.push({ who: ['you'], what: 'Merge', state: st === 'merged' ? 'done' : st === 'approved' ? 'active' : 'pending' });
  return L;
}
function laneHtml(t) {
  return `<div class="lane" role="list" aria-label="Progress">${legs(t).map((l) => {
    const c = l.color || (l.who[0] ? `var(--${l.who[0]})` : 'var(--muted)');
    return `<div class="leg ${l.state}" role="listitem" style="--c:${c}"><div class="track"></div>
      <div class="who">${l.who.map((w) => `<span class="agent ${w}">${AGENTS[w]}</span>`).join(' + ') || '&nbsp;'}</div><div class="what">${esc(l.what)}</div></div>`;
  }).join('')}</div>`;
}

function calloutHtml(t) {
  const w = (t.candidates || []).find((c) => c.key === t.winner);
  switch (t.status) {
    case 'awaiting_approval': return `<div class="callout"><p>Claude wrote the spec. Check the scope and acceptance criteria, then approve to hand it to ${implLabel(t)}.</p><div class="row"><button class="btn" data-act="tab" data-tab="spec">Review spec</button><button class="btn approve" data-act="approve">Approve and build</button></div></div>`;
    case 'chatting': return `<div class="callout"><p>Talk the requirement through with Claude, then ask it to write the spec.</p><div class="row"><button class="btn" data-act="tab" data-tab="spec">Open chat</button></div></div>`;
    case 'needs_human': return `<div class="callout"><div style="flex:1;min-width:280px"><p style="margin-bottom:.5rem">Not approved after ${t.round} round${t.round > 1 ? 's' : ''}. Read the latest review, then tell the implementer what to change.</p>
      <textarea id="feedback" rows="3" placeholder="For example: keep using the existing sleep() helper; don’t touch README.md"></textarea></div>
      <div class="row"><label class="hint">Rounds <input id="moreRounds" type="number" min="1" max="10" value="2" style="width:4.5rem"></label><button class="btn primary" data-act="resume">Continue</button><button class="btn danger" data-act="discard">Discard</button></div></div>`;
    case 'approved': return `<div class="callout good"><p>${w ? agentTag(w.agent) : ''}’s change passed the checks and Claude’s review. It is committed on <code>${esc(w ? w.branch : '')}</code>.</p><div class="row"><button class="btn" data-act="tab" data-tab="changes">View changes</button><button class="btn approve" data-act="merge">Squash-merge into current branch</button><button class="btn danger" data-act="discard">Discard</button></div></div>`;
    case 'merged': return `<div class="callout good"><p>Merged into <code>${esc(t.mergedInto)}</code> as <code>${esc((t.mergeCommit || '').slice(0, 8))}</code>. The working copy was removed.</p></div>`;
    case 'failed': return `<div class="callout badd"><p>${esc(t.error || 'The task failed.')} The full log is in the Activity tab.</p><div class="row"><button class="btn primary" data-act="resume">Retry</button><button class="btn danger" data-act="discard">Discard</button></div></div>`;
    case 'interrupted': case 'cancelled': return `<div class="callout"><p>${t.status === 'cancelled' ? 'You cancelled this task.' : 'The process running this task stopped (for example the server was closed).'} You can pick up where it left off.</p><div class="row"><button class="btn primary" data-act="resume">Resume</button><button class="btn danger" data-act="discard">Discard</button></div></div>`;
    case 'discarded': return '';
    default: return STATUS[t.status] && STATUS[t.status][1] === 'running' ? `<div class="callout good"><p>${esc(STATUS[t.status][0])}…</p><button class="btn danger" data-act="cancel">Cancel task</button></div>` : '';
  }
}

function renderTask(soft) {
  const t = S.task; if (!t) return;
  const scroll = $('.feed') ? $('.feed').scrollTop : null;
  const tabs = [['activity', 'Activity'], ['spec', t.stage === 'chat' ? 'Discussion' : 'Spec'], ['changes', 'Changes'], ['review', 'Review'], ['usage', 'Usage']];
  const keepChat = soft && S.tab === 'spec' && t.stage === 'chat' && $('#chatInput') ? $('#chatInput').value : null;
  $('#view').innerHTML = `
    <div class="task-head"><div><h1>${esc(t.title)}</h1>
      <div class="sub">${chip(t.status)}<span>${esc(MODES[t.mode])} · ${implLabel(t)}</span><span class="mono">${esc(t.id)}</span><span>from <code>${esc(t.originBranch)}</code></span></div></div></div>
    ${laneHtml(t)}
    ${calloutHtml(t)}
    <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="tabBody"></div>`;
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; renderTask(); }));
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
  renderTab();
  if (keepChat !== null && $('#chatInput')) $('#chatInput').value = keepChat;
  if (scroll !== null && $('.feed')) $('.feed').scrollTop = scroll;
}

async function act(a, el) {
  const t = S.task; const base = `/api/tasks/${t.repoKey}/${t.id}`;
  try {
    if (a === 'tab') { S.tab = el.dataset.tab; return renderTask(); }
    if (a === 'approve') { const ed = $('#specEdit'); await api('POST', `${base}/approve`, { content: ed && !ed.hidden ? ed.value : undefined }); toast('Spec approved — building'); }
    if (a === 'cancel') { await api('POST', `${base}/cancel`, {}); toast('Cancelling…'); }
    if (a === 'resume') { await api('POST', `${base}/resume`, { feedback: $('#feedback') ? $('#feedback').value : '', rounds: $('#moreRounds') ? Number($('#moreRounds').value) : undefined }); toast('Continuing'); }
    if (a === 'merge') { if (!(await confirmBox('Squash-merge this change?', 'The change is merged as one commit into the branch currently checked out in your main working tree, and the task’s working copy is removed.', 'Merge'))) return; const r = await api('POST', `${base}/merge`, {}); toast(`Merged into ${r.into}`); }
    if (a === 'discard') { if (!(await confirmBox('Discard this task?', 'This deletes the task’s working copies and branches. The spec, logs and reviews stay in .ai/tasks.', 'Discard'))) return; await api('POST', `${base}/discard`, {}); toast('Discarded'); }
    if (a === 'save-spec') { await api('POST', `${base}/spec`, { content: $('#specEdit').value }); toast('Spec saved'); }
    if (a === 'edit-spec') { $('#specEdit').hidden = false; $('#specView').hidden = true; el.hidden = true; $('[data-act="save-spec"]').hidden = false; return; }
    if (a === 'send-chat') {
      const v = $('#chatInput').value.trim(); if (!v) return;
      S.chatPending = true; await api('POST', `${base}/chat`, { message: v }); $('#chatInput').value = ''; renderTab(); return;
    }
    if (a === 'gen-spec') { if (!(await confirmBox('Write the spec now?', 'Claude will turn this conversation into a spec. You can still edit it before approving.', 'Write spec'))) return; await api('POST', `${base}/generate-spec`, {}); toast('Claude is writing the spec'); }
    const fresh = await api('GET', base); S.task = { ...fresh, repoKey: t.repoKey }; renderTask(); refreshList();
  } catch (e) { toast(e.message, true); }
}

// ───────────── tabs ─────────────
function renderTab() {
  const t = S.task; const body = $('#tabBody'); if (!body) return;
  if (S.tab === 'activity') {
    const f = S.feedFilter;
    body.innerHTML = `<div class="feed-tools" role="group" aria-label="Filter">${[['all', 'Everything'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['opencode', 'OpenCode'], ['checks', 'Checks and decisions']].map(([k, l]) => `<button aria-pressed="${f === k}" data-f="${k}">${l}</button>`).join('')}</div><div class="feed" id="feed"></div>`;
    body.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { S.feedFilter = b.dataset.f; renderTab(); }));
    S.events.forEach((e) => appendFeed(e, true)); const fd = $('#feed'); fd.scrollTop = fd.scrollHeight;
    if (!S.events.length) fd.innerHTML = '<div class="ln sys"><span></span><span></span><span class="msg">Waiting for the first event…</span></div>';
    return;
  }
  if (S.tab === 'spec') {
    if (t.stage === 'chat') return renderChat(body);
    const editable = t.stage === 'approval' && !t.engineAlive || t.status === 'awaiting_approval';
    body.innerHTML = t.spec.trim()
      ? `<div class="panel"><div class="row end" style="margin-bottom:.6rem">${editable ? '<button class="btn" data-act="edit-spec">Edit</button><button class="btn" data-act="save-spec" hidden>Save</button>' : ''}${t.status === 'awaiting_approval' ? '<button class="btn approve" data-act="approve">Approve and build</button>' : ''}</div>
         <div id="specView">${md(t.spec)}</div><textarea id="specEdit" class="code" hidden>${esc(t.spec)}</textarea></div>
         <details style="margin-top:1rem"><summary class="hint">Original request</summary><div class="panel" style="margin-top:.5rem">${md(t.request)}</div></details>`
      : `<p class="hint">${t.status === 'auditing' ? 'Claude is reading the code and writing the spec. It appears here when ready.' : 'No spec yet.'}</p>`;
    body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
    return;
  }
  if (S.tab === 'changes' || S.tab === 'review') return renderRounds(body, S.tab);
  if (S.tab === 'usage') {
    body.innerHTML = Object.keys(t.usage || {}).length ? `<div class="panel">${usageTable(t.usage)}</div>` : '<p class="hint">No usage recorded yet.</p>';
  }
}

function feedLine(ev) {
  const f = S.feedFilter;
  const isCheck = ['gate', 'gates_done', 'verdict', 'selected', 'approved', 'fallback', 'merged', 'needs_human'].includes(ev.type);
  if (f === 'checks' && !isCheck) return null;
  if (['claude', 'gemini', 'opencode'].includes(f) && ev.agent !== f) return null;
  let who = ev.agent || ''; let msg = ''; let cls = `t-${ev.type}`;
  switch (ev.type) {
    case 'agent': {
      msg = ev.kind === 'edit' ? (ev.file || ev.text) : ev.text; cls += ` k-${ev.kind}`;
      if (ev.kind === 'text') { const ls = msg.trim().split('\n'); msg = ls.length > 8 ? `${ls.slice(0, 8).join('\n')}\n… ${ls.length - 8} more lines (see the Spec or Review tab)` : ls.join('\n'); }
      break;
    }
    case 'agent_start': msg = `started ${ev.step}${ev.resumed ? ' (resumed session)' : ''}`; cls += ' sys'; break;
    case 'agent_end': msg = `finished ${ev.step}${ev.code ? ` with exit code ${ev.code}` : ''}`; cls += ' sys'; break;
    case 'status': msg = `→ ${(STATUS[ev.status] || [ev.status])[0]}`; cls += ' sys'; break;
    case 'gate': msg = `check ${ev.name}${ev.key && S.task.mode === 'best-of-2' ? ` (${ev.key.toUpperCase()})` : ''}: ${ev.ok ? 'pass' : 'fail'}${ev.violations && ev.violations.length ? ` — ${ev.violations.join('; ')}` : ''}`; cls += ev.ok ? ' okk' : ' nok'; break;
    case 'verdict': who = 'claude'; msg = `review round ${ev.round}: ${ev.verdict === 'APPROVE' ? 'approved' : 'changes requested'} (${ev.blockers} blocker, ${ev.majors} major)`; break;
    case 'selected': who = 'claude'; msg = `picked candidate ${ev.winner.toUpperCase()} (${AGENTS[ev.agent]})`; break;
    case 'fallback': msg = ev.text; cls += ' k-error'; break;
    case 'gate_start': msg = `running ${ev.name}: ${ev.cmd}`; cls += ' sys'; break;
    case 'warning': msg = ev.text; cls += ' k-error'; break;
    case 'worktree': msg = `working copy ready for ${AGENTS[ev.agent]} on ${ev.branch}${ev.linked && ev.linked.length ? ` (linked ${ev.linked.join(', ')})` : ''}`; cls += ' sys'; break;
    case 'chat': who = ev.role === 'user' ? 'you' : 'claude'; msg = ev.text; break;
    case 'usage': return null;
    case 'gates_done': case 'round_start': case 'round_end': case 'spec_approved': case 'task_created':
      msg = ev.type === 'round_start' ? `round ${ev.round} started` : ev.type === 'spec_approved' ? 'spec approved' : ev.type === 'task_created' ? `task created (${MODES[ev.mode]})` : ev.type === 'round_end' ? `round ${ev.round} ended` : `checks done${ev.key && S.task.mode === 'best-of-2' ? ` for ${ev.key.toUpperCase()}` : ''}: ${ev.pass ? 'pass' : 'fail'}`; cls += ' sys'; break;
    default: msg = ev.text || ev.type.replace(/_/g, ' ');
  }
  if (!msg) return null;
  return `<div class="ln ${cls}"><span class="ts">${clock(ev.ts)}</span><span class="who">${who ? agentTag(who) : ''}</span><span class="msg">${esc(String(msg).slice(0, 4000))}</span></div>`;
}
function appendFeed(ev, bulk) {
  const fd = $('#feed'); if (!fd) return;
  const html = feedLine(ev); if (!html) return;
  if (fd.firstElementChild && fd.firstElementChild.textContent.includes('Waiting for the first event')) fd.innerHTML = '';
  const nearBottom = fd.scrollHeight - fd.scrollTop - fd.clientHeight < 80;
  fd.insertAdjacentHTML('beforeend', html);
  if (!bulk && nearBottom) fd.scrollTop = fd.scrollHeight;
}

function renderChat(body) {
  const t = S.task; const pending = S.chatPending || t.status === 'chatting_busy' || (t.chat.length && t.chat[t.chat.length - 1].role === 'user');
  body.innerHTML = `<div class="chat">${t.chat.length ? '' : `<div class="bubble"><div class="who">${agentTag('claude')}</div>Tell me what you want to change. I’ll read the relevant code first, then ask only the questions that affect the design.<br><span class="hint">Your request: ${esc(t.request)}</span></div>`}
    ${t.chat.map((m) => `<div class="bubble ${m.role}"><div class="who">${agentTag(m.role === 'user' ? 'you' : 'claude')}</div>${m.role === 'assistant' ? md(m.text) : esc(m.text).replace(/\n/g, '<br>')}</div>`).join('')}
    ${pending ? `<div class="typing">${agentTag('claude')} is reading the code and replying…</div>` : ''}</div>
    <div class="panel"><label class="field" style="margin-bottom:.6rem"><span class="sr-only">Message</span><textarea id="chatInput" rows="3" placeholder="${t.chat.length ? 'Answer Claude’s questions or add details…' : 'Describe the change, or just say “go ahead” to start from your request'}"></textarea></label>
    <div class="row end"><button class="btn" data-act="gen-spec" ${t.chat.length && !pending ? '' : 'disabled'}>Write the spec</button><button class="btn primary" data-act="send-chat" ${pending ? 'disabled' : ''}>Send</button></div></div>`;
  body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
  const ci = $('#chatInput');
  ci.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) act('send-chat'); });
}

async function renderRounds(body, kind) {
  const t = S.task; const files = t.files || [];
  const rounds = [...new Set(files.map((f) => (f.match(/^r(\d+)-/) || [])[1]).filter(Boolean))].map(Number).sort((a, b) => a - b);
  if (!rounds.length) { body.innerHTML = `<p class="hint">${kind === 'changes' ? 'Changes appear after the first build round.' : 'Reviews appear after the first round of checks.'}</p>`; return; }
  const sel = S.sel || (S.sel = {}); sel.round = rounds.includes(sel.round) ? sel.round : rounds[rounds.length - 1];
  const keys = [...new Set(files.filter((f) => f.startsWith(`r${sel.round}-`) && f.endsWith('.patch')).map((f) => f.split('-')[1].split('.')[0]))];
  sel.key = keys.includes(sel.key) ? sel.key : (keys.includes(t.winner) ? t.winner : keys[0]);
  const candAgent = (k) => { const c = (t.candidates || []).find((x) => x.key === k); return c ? AGENTS[c.agent] : k; };
  const roundPick = `<label class="hint">Round <select id="pickRound" style="width:auto">${rounds.map((r) => `<option ${r === sel.round ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`;
  const keyPick = keys.length > 1 ? `<label class="hint">Candidate <select id="pickKey" style="width:auto">${keys.map((k) => `<option value="${k}" ${k === sel.key ? 'selected' : ''}>${k.toUpperCase()} · ${esc(candAgent(k))}</option>`).join('')}</select></label>` : '';
  body.innerHTML = `<div class="row" style="margin-bottom:.8rem">${roundPick}${kind === 'changes' ? keyPick : ''}</div><div id="roundBody" class="hint">Loading…</div>`;
  $('#pickRound').addEventListener('change', (e) => { sel.round = Number(e.target.value); renderRounds(body, kind); });
  if ($('#pickKey')) $('#pickKey').addEventListener('change', (e) => { sel.key = e.target.value; renderRounds(body, kind); });
  const get = (n) => api('GET', `/api/tasks/${t.repoKey}/${t.id}/file?name=${encodeURIComponent(n)}`).catch(() => '');
  if (kind === 'changes') {
    const [stat, patch] = await Promise.all([get(`r${sel.round}-${sel.key}.stat`), get(`r${sel.round}-${sel.key}.patch`)]);
    $('#roundBody').outerHTML = `<div><pre class="hint" style="margin:0 0 .6rem">${esc(stat)}</pre>${diffHtml(patch)}</div>`;
  } else {
    const review = await get(`r${sel.round}-review.md`);
    const gateLogs = await Promise.all(keys.map(async (k) => [k, await get(`r${sel.round}-${k}-gates.log`)]));
    $('#roundBody').outerHTML = `<div class="panel">${review ? md(review) : '<p class="hint">Review in progress…</p>'}</div>
      ${gateLogs.map(([k, log]) => `<details style="margin-top:.8rem"><summary>Check log${keys.length > 1 ? ` · ${k.toUpperCase()} (${esc(candAgent(k))})` : ''}</summary><pre class="diff" style="padding:.7rem .9rem;white-space:pre-wrap">${esc(log)}</pre></details>`).join('')}`;
  }
}

// ───────────── settings ─────────────
async function viewSettings() {
  S.task = null; renderRail();
  let s; try { s = await api('GET', '/api/settings'); } catch (e) { return toast(e.message, true); }
  const c = s.config; const meta = await api('GET', '/api/meta').catch(() => null); S.meta = meta;
  const opt = (vals, cur) => vals.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`).join('');
  const promptNames = Object.keys(s.prompts);
  $('#view').innerHTML = `<div class="narrow"><h1 style="margin-bottom:1.2rem">Settings</h1>
  <form id="cfg" class="panel">
    <h2>Defaults for new tasks</h2>
    <div class="grid2">
      <label class="field"><span>Strategy</span><select name="mode">${opt([['single', 'Single'], ['fallback', 'Fallback'], ['best-of-2', 'Best of 2']], c.mode)}</select></label>
      <label class="field"><span>Maximum rounds</span><input type="number" name="maxRounds" min="1" max="10" value="${c.maxRounds}"></label>
      <label class="field"><span>Implementer</span><select name="implementer">${opt([['gemini', 'Gemini'], ['opencode', 'OpenCode']], c.implementer)}</select></label>
      <label class="field"><span>Second implementer</span><select name="secondary">${opt([['opencode', 'OpenCode'], ['gemini', 'Gemini']], c.secondary)}</select></label>
      <label class="field"><span>Spec and review language</span><input type="text" name="outputLanguage" value="${esc(c.outputLanguage)}"></label>
      <label class="field"><span>Spec approval</span><select name="reviewSpec">${opt([['true', 'Ask me first'], ['false', 'Build right away']], c.reviewSpec)}</select></label>
    </div>
    <h2 style="margin-top:.6rem">${agentTag('claude')}</h2>
    <div class="grid2">
      <label class="field"><span>Model for audit and spec</span><input type="text" name="claude.model" value="${esc(c.claude.model)}" placeholder="Claude Code default"></label>
      <label class="field"><span>Model for reviews</span><input type="text" name="claude.reviewModel" value="${esc(c.claude.reviewModel)}" placeholder="Same as above"></label>
      <label class="field"><span>Reuse the audit session for reviews</span><select name="claude.resumeReview">${opt([['true', 'Yes — fewer tokens'], ['false', 'No — fresh session each review']], c.claude.resumeReview)}</select></label>
    </div>
    <h2 style="margin-top:.6rem">${agentTag('gemini')}</h2>
    <div class="grid2">
      <label class="field"><span>Model</span><input type="text" name="gemini.model" value="${esc(c.gemini.model)}" placeholder="Gemini CLI default"></label>
      <label class="field"><span>Permissions</span><select name="gemini.approval">${opt([['auto_edit', 'Edit files only (safer)'], ['yolo', 'Edit files and run commands']], c.gemini.approval)}</select></label>
    </div>
    <h2 style="margin-top:.6rem">${agentTag('opencode')}</h2>
    <div class="grid2">
      <label class="field"><span>Model (provider/model)</span><input type="text" name="opencode.model" value="${esc(c.opencode.model)}" placeholder="OpenCode default"></label>
      <label class="field"><span>Permissions</span><select name="opencode.approval">${opt([['safe', 'Edit files only (safer)'], ['yolo', 'Everything not explicitly denied']], c.opencode.approval)}</select></label>
    </div>
    <p class="hint">“Run commands” lets the implementer execute anything in its working copy. Use it only inside a container or VM. Per-repository checks (lint, typecheck, test) live in <code>.ai-kit.json</code> at the repository root.</p>
    <div class="row"><button class="btn primary">Save defaults</button></div>
  </form>
  <form id="prm" class="panel" style="margin-top:1.2rem">
    <h2>Role prompts</h2>
    <p class="hint">These instructions shape every audit, build and review. Stored in <code>${esc(s.promptsDir)}</code>.</p>
    <label class="field"><span class="sr-only">Prompt</span><select id="promptPick">${promptNames.map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>
    <textarea id="promptText" class="code">${esc(s.prompts[promptNames[0]])}</textarea>
    <div class="row" style="margin-top:.6rem"><button class="btn primary">Save prompt</button></div>
  </form>
  <section class="panel" style="margin-top:1.2rem"><h2>Installed tools</h2>
    <ul>${meta ? Object.entries(meta.agents).map(([k, a]) => `<li>${AGENTS[k] ? agentTag(k) : esc(a.label)} — ${a.present ? esc(a.version || 'installed') : '<b>not installed</b>'}${a.warning ? `<div class="hint">${esc(a.warning)}</div>` : ''}</li>`).join('') : ''}</ul></section></div>`;
  const cfg = $('#cfg');
  cfg.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const el of cfg.elements) {
      if (!el.name) continue;
      let v = el.value; if (v === 'true' || v === 'false') v = v === 'true'; if (el.type === 'number') v = Number(v);
      const [a, b] = el.name.split('.'); if (b) (out[a] = out[a] || {})[b] = v; else out[a] = v;
    }
    try { await api('POST', '/api/settings', { config: out }); S.meta = null; toast('Defaults saved'); } catch (err) { toast(err.message, true); }
  });
  $('#promptPick').addEventListener('change', (e) => { $('#promptText').value = s.prompts[e.target.value]; });
  $('#prm').addEventListener('submit', async (e) => {
    e.preventDefault(); const n = $('#promptPick').value; s.prompts[n] = $('#promptText').value;
    try { await api('POST', '/api/settings', { prompts: { [n]: s.prompts[n] } }); toast(`${n} saved`); } catch (err) { toast(err.message, true); }
  });
}

// ───────────── boot ─────────────
$('#repoFilter').addEventListener('change', (e) => { S.repoFilter = e.target.value; localStorage.setItem('relay.repo', S.repoFilter); renderRail(); });
window.addEventListener('hashchange', route);
(async () => { await refreshList(); route(); setInterval(() => { if (document.visibilityState === 'visible') refreshList(); }, 4000); })();
