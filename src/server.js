'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const U = require('./util');
const G = require('./git');
const { Task, listTasks } = require('./engine');
const { ADAPTERS } = require('./adapters');

const WEB = path.join(U.APP_DIR, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const PROMPT_NAMES = ['architect.md', 'implementer.md', 'reviewer.md', 'selector.md', 'spec-chat.md'];
const reposFile = () => path.join(U.KIT_HOME, 'repos.json');

function loadRepos() { return U.readJson(reposFile(), []).filter((r) => fs.existsSync(r.path)); }
function saveRepos(list) { fs.mkdirSync(U.KIT_HOME, { recursive: true }); U.writeJsonAtomic(reposFile(), list); }
function registerRepo(p) {
  const root = G.repoRoot(path.resolve(p));
  const list = loadRepos();
  if (!list.find((r) => r.path === root)) { list.push({ path: root, key: U.repoKey(root), name: path.basename(root), addedAt: new Date().toISOString() }); saveRepos(list); }
  return list.find((r) => r.path === root);
}
function repoByKey(k) { const r = loadRepos().find((x) => x.key === k); if (!r) throw httpError(404, 'Unknown repository'); return r; }
function httpError(code, msg) { const e = new Error(msg); e.status = code; return e; }

async function doctor() {
  const out = {};
  for (const [name, ad] of Object.entries(ADAPTERS)) {
    const present = U.commandExists(ad.bin);
    let version = null, warning = null;
    if (present) {
      // run in a neutral temp dir with no stdin: a diagnostic must never let an agent act on a repository
      const r = await U.runProcess(ad.bin, ['--version'], { timeoutMs: 8000, cwd: os.tmpdir() });
      version = (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80) || null;
      if (name === 'opencode') {
        const h = await U.runProcess('opencode', ['run', '--help'], { timeoutMs: 8000, cwd: os.tmpdir() });
        if (!/--format/.test(h.stdout + h.stderr)) warning = 'This "opencode" does not support `run --format json`. Install the opencode.ai CLI (npm i -g opencode-ai).';
      }
    }
    out[name] = { label: ad.label, present, version, warning };
  }
  out.git = { label: 'git', present: U.commandExists('git') };
  return out;
}

function startServer({ port, host = '127.0.0.1', onListen } = {}) {
  const cfg = U.loadConfig(null);
  port = Number(port || cfg.ui.port || 7788);
  const token = crypto.randomBytes(24).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const live = new Map(); // in-process tasks: key -> Task

  const key = (rk, id) => `${rk}/${id}`;
  function getTask(rk, id) {
    if (!/^T[\w-]+$/.test(id)) throw httpError(400, 'Bad task id');
    const k = key(rk, id);
    if (live.has(k)) return live.get(k);
    return new Task(repoByKey(rk).path, id);
  }
  function runInBackground(rk, task, fn) {
    const k = key(rk, task.id); live.set(k, task);
    Promise.resolve().then(fn).catch((e) => { try { task.emitEvent('error', { text: e.message }); } catch { /* ignore */ } })
      .finally(() => { if (!task.isEngineAlive() || task.state.engine?.pid !== process.pid) live.delete(k); });
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body, headers = {}) => {
      const isStr = typeof body === 'string' || Buffer.isBuffer(body);
      res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers });
      res.end(isStr ? body : JSON.stringify(body));
    };
    try {
      // 1) DNS-rebinding protection
      if (!allowedHosts.has(req.headers.host || '')) return send(403, 'Forbidden host');
      const url = new URL(req.url, `http://${req.headers.host}`);
      // 2) token login → HttpOnly cookie
      if (url.pathname === '/auth') {
        if (url.searchParams.get('t') !== token) return send(401, 'Invalid or expired link. Run `ai-task ui` again and open the link it prints.');
        return send(302, '', { 'Set-Cookie': `relay_token=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
      }
      const cookie = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')));
      if (cookie.relay_token !== token && req.headers['x-relay-token'] !== token) {
        return send(401, 'Not signed in. Open the link printed by `ai-task ui` (it contains a one-time token).');
      }
      // 3) CSRF: state-changing requests must be same-origin JSON
      if (req.method !== 'GET') {
        if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return send(403, 'Forbidden origin');
        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(415, 'JSON only');
      }

      // static
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (!/^[\w.-]+$/.test(f) || !fs.existsSync(path.join(WEB, f))) return send(404, 'Not found');
        return send(200, fs.readFileSync(path.join(WEB, f)), { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
      }

      const body = req.method === 'GET' ? {} : await readBody(req);
      const parts = url.pathname.split('/').filter(Boolean); // api, ...
      const [, a, b, c, d] = parts;

      if (a === 'meta' && req.method === 'GET') {
        return send(200, { version: require('../package.json').version, agents: await doctor(), config: U.loadConfig(null), kitHome: U.KIT_HOME });
      }
      if (a === 'repos') {
        if (req.method === 'GET') return send(200, loadRepos().map((r) => ({ ...r, config: U.loadConfig(r.path) })));
        if (req.method === 'POST' && b === 'remove') { saveRepos(loadRepos().filter((r) => r.key !== body.key)); return send(200, { ok: true }); }
        if (req.method === 'POST') return send(200, registerRepo(body.path));
      }
      if (a === 'settings') {
        if (req.method === 'GET') {
          const prompts = {}; for (const n of PROMPT_NAMES) prompts[n] = U.readText(U.promptPath(n));
          return send(200, { config: U.loadConfig(null), prompts, promptsDir: U.PROMPTS_DIR });
        }
        if (req.method === 'POST') {
          if (body.config) { fs.mkdirSync(U.KIT_HOME, { recursive: true }); U.writeJsonAtomic(U.globalConfigPath(), U.deepMerge(U.readJson(U.globalConfigPath(), {}), body.config)); }
          if (body.prompts) {
            for (const [n, v] of Object.entries(body.prompts)) {
              if (!PROMPT_NAMES.includes(n) || typeof v !== 'string') continue;
              fs.mkdirSync(path.join(U.KIT_HOME, 'prompts'), { recursive: true });
              fs.writeFileSync(path.join(U.KIT_HOME, 'prompts', n), v);
            }
          }
          return send(200, { ok: true });
        }
      }
      if (a === 'tasks') {
        if (!b && req.method === 'GET') {
          const all = [];
          for (const r of loadRepos()) for (const t of listTasks(r.path)) all.push({ ...summary(t), repoKey: r.key, repoName: r.name });
          all.sort((x, y) => (y.createdAt > x.createdAt ? 1 : -1));
          return send(200, all);
        }
        if (!b && req.method === 'POST') {
          const r = repoByKey(body.repoKey);
          const specText = body.specText && String(body.specText).trim() ? String(body.specText) : null;
          if ((!body.request || !String(body.request).trim()) && !specText) throw httpError(400, 'Describe what you want built.');
          const request = String(body.request || '').trim() || specText.split('\n')[0].replace(/^#+\s*(Spec:)?\s*/i, '');
          const t = Task.create(r.path, { request, specText, mode: body.mode, implementer: body.implementer, secondary: body.secondary,
            maxRounds: body.maxRounds, reviewSpec: body.reviewSpec, discuss: !!body.discuss && !specText });
          if (!body.discuss) runInBackground(r.key, t, () => t.run()); else live.set(key(r.key, t.id), t);
          return send(201, { id: t.id, repoKey: r.key });
        }
        const task = getTask(b, c);
        if (req.method === 'GET' && !d) return send(200, detail(task));
        if (req.method === 'GET' && d === 'events') return streamEvents(req, res, task, Math.max(Number(url.searchParams.get('since') || 0), Number(req.headers['last-event-id'] || 0)));
        if (req.method === 'GET' && d === 'file') {
          const name = url.searchParams.get('name') || '';
          if (!/^[\w.-]+$/.test(name) || !fs.existsSync(task.file(name))) throw httpError(404, 'No such file');
          return send(200, fs.readFileSync(task.file(name), 'utf8'));
        }
        if (req.method === 'POST') {
          switch (d) {
            case 'spec': if (!['approval', 'chat'].includes(task.state.stage)) throw httpError(409, 'The spec can only be edited before approval.');
              task.write('spec.md', String(body.content || '')); task.emitEvent('note', { text: 'Spec edited by you.' }); return send(200, { ok: true });
            case 'approve':
              task.approveSpec(body.content);
              if (!task.isEngineAlive()) runInBackground(b, task, () => task.run());
              return send(200, { ok: true });
            case 'cancel':
              task.requestCancel();
              if (!task.isEngineAlive() && !['approved', 'merged', 'discarded'].includes(task.state.status)) task.setState({ status: 'cancelled' });
              return send(200, { ok: true });
            case 'resume':
              task.prepareResume({ feedback: body.feedback, rounds: body.rounds });
              runInBackground(b, task, () => task.run()); return send(200, { ok: true });
            case 'chat':
              if (!String(body.message || '').trim()) throw httpError(400, 'Write a message first.');
              runInBackground(b, task, () => task.chat(String(body.message))); return send(202, { ok: true });
            case 'generate-spec':
              runInBackground(b, task, () => task.generateSpecFromChat()); return send(202, { ok: true });
            case 'merge': return send(200, task.merge());
            case 'discard': task.discard(); return send(200, { ok: true });
            default: break;
          }
        }
      }
      return send(404, { error: 'Not found' });
    } catch (e) {
      return send(e.status || 500, { error: e.message });
    }
  });

  server.listen(port, host, () => {
    const link = `http://127.0.0.1:${port}/auth?t=${token}`;
    fs.mkdirSync(U.KIT_HOME, { recursive: true });
    fs.writeFileSync(path.join(U.KIT_HOME, 'ui.json'), JSON.stringify({ port, pid: process.pid, link }), { mode: 0o600 });
    if (onListen) onListen(link);
  });
  return server;
}

function summary(t) {
  return { id: t.id, title: t.title, status: t.status, stage: t.stage, mode: t.mode, implementer: t.implementer, secondary: t.secondary,
    round: t.round, roundLimit: t.roundLimit, usage: t.usage, createdAt: t.createdAt, updatedAt: t.updatedAt, winner: t.winner,
    candidates: (t.candidates || []).map((c) => ({ key: c.key, agent: c.agent, dropped: c.dropped })) };
}
function detail(task) {
  const v = task.view();
  const files = fs.readdirSync(task.dir).filter((f) => fs.statSync(task.file(f)).isFile());
  return { ...v, request: task.read('request.md'), spec: task.read('spec.md'), chat: task.chatHistory(), files };
}

function streamEvents(req, res, task, since) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const file = task.file('events.jsonl');
  let offset = 0, carry = '';
  const pump = () => {
    let size = 0; try { size = fs.statSync(file).size; } catch { return; }
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd); offset = size;
    const text = carry + buf.toString('utf8'); const lines = text.split('\n'); carry = lines.pop();
    for (const l of lines) {
      if (!l) continue;
      let ev; try { ev = JSON.parse(l); } catch { continue; }
      if (ev.seq <= since) continue;
      res.write(`id: ${ev.seq}\ndata: ${l}\n\n`);
    }
  };
  pump();
  const iv = setInterval(pump, 400);
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(iv); clearInterval(hb); });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4 * 1024 * 1024) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
  });
}

module.exports = { startServer, registerRepo, loadRepos, doctor };
