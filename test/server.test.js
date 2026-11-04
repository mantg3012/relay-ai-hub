// Server/API test with fake CLIs: node test/server.test.js
const { execSync, spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
const APP = path.resolve(__dirname, '..');
process.env.AI_KIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
process.env.PATH = `${path.join(__dirname, 'fakebin')}:${process.env.PATH}`;
process.env.FAKE_GEMINI = 'bad'; // Gemini builds a wrong add(); OpenCode builds the right one
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`  ${ok ? '✔' : '✖'} ${name}`); ok ? pass++ : fail++; };
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
execSync(`cd ${repo} && git init -q -b main && git config user.email t@t && git config user.name t && mkdir -p tests src && echo '[ 1 = 1 ]' > tests/existing.sh && echo 'echo 0' > src/add.sh && echo '{"gates":{"test":"for t in tests/*.sh; do bash $t || exit 1; done"}}' > .ai-kit.json && git add -A && git commit -qm init`);
const PORT = 7790;
function req(method, p, { body, headers = {}, host = `127.0.0.1:${PORT}`, cookie } = {}) {
  return new Promise((res) => {
    const h = { Host: host, ...headers }; if (cookie) h.Cookie = cookie; if (body) h['Content-Type'] = h['Content-Type'] || 'application/json';
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (resp) => {
      let d = ''; resp.on('data', (c) => (d += c)); resp.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} res({ status: resp.statusCode, headers: resp.headers, text: d, json: j }); });
    });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body)); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const srv = spawn('node', [path.join(APP, 'src/cli.js'), 'ui', '--port', String(PORT), '--no-open'], { cwd: repo, env: process.env, stdio: 'ignore' });
  for (let i = 0; i < 50 && !fs.existsSync(path.join(process.env.AI_KIT_HOME, 'ui.json')); i++) await sleep(100);
  const { link } = JSON.parse(fs.readFileSync(path.join(process.env.AI_KIT_HOME, 'ui.json'), 'utf8'));
  const token = new URL(link).searchParams.get('t');
  console.log('▸ security');
  check('no cookie → 401', (await req('GET', '/')).status === 401);
  check('foreign Host header → 403 (DNS rebinding)', (await req('GET', '/', { host: 'evil.example:7790' })).status === 403);
  check('wrong token → 401', (await req('GET', '/auth?t=nope')).status === 401);
  const auth = await req('GET', `/auth?t=${token}`);
  const cookie = (auth.headers['set-cookie'] || [''])[0].split(';')[0];
  check('token link sets HttpOnly SameSite=Strict cookie', auth.status === 302 && /HttpOnly/.test(auth.headers['set-cookie'][0]) && /SameSite=Strict/.test(auth.headers['set-cookie'][0]));
  check('dashboard loads with cookie', (await req('GET', '/', { cookie })).status === 200);
  check('form-encoded POST rejected (CSRF)', (await req('POST', '/api/repos', { cookie, body: 'path=/tmp', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status === 415);
  check('cross-origin POST rejected', (await req('POST', '/api/repos', { cookie, body: { path: repo }, headers: { Origin: 'https://evil.example' } })).status === 403);
  const repos = (await req('GET', '/api/repos', { cookie })).json;
  check('repo auto-registered by `ai-task ui`', repos.length === 1 && repos[0].path === fs.realpathSync(repo));
  const rk = repos[0].key;

  console.log('▸ spec chat → spec → approve → best-of-2 → merge');
  let r = await req('POST', '/api/tasks', { cookie, body: { repoKey: rk, request: 'write add', discuss: true, mode: 'best-of-2', implementer: 'gemini', secondary: 'opencode', reviewSpec: true } });
  check('task created in discuss mode', r.status === 201);
  const id = r.json.id; const base = `/api/tasks/${rk}/${id}`;
  check('path traversal in file name blocked', (await req('GET', `${base}/file?name=..%2F..%2Fstate.json`, { cookie })).status === 404);
  await req('POST', `${base}/chat`, { cookie, body: { message: 'start from the request' } });
  let t; for (let i = 0; i < 50; i++) { await sleep(150); t = (await req('GET', base, { cookie })).json; if (t.chat.length >= 2) break; }
  check('Claude replied in the chat', t.chat.length === 2 && /Question 1/.test(t.chat[1].text));
  await req('POST', `${base}/chat`, { cookie, body: { message: 'yes, negatives too' } });
  for (let i = 0; i < 50; i++) { await sleep(150); t = (await req('GET', base, { cookie })).json; if (t.chat.length >= 4) break; }
  check('second turn resumed the same Claude session', t.chat.length === 4 && fs.readFileSync(path.join(repo, `.ai/tasks/${id}/claude-chat.log`), 'utf8').includes('--resume cl-'));
  await req('POST', `${base}/generate-spec`, { cookie, body: {} });
  for (let i = 0; i < 50; i++) { await sleep(150); t = (await req('GET', base, { cookie })).json; if (t.status === 'awaiting_approval') break; }
  check('spec written from chat, waiting for approval', t.status === 'awaiting_approval' && /allowed-files/.test(t.spec));
  r = await req('POST', `${base}/spec`, { cookie, body: { content: t.spec + '\n- AC-2: handles negatives\n' } });
  check('spec edit saved', r.status === 200);
  await req('POST', `${base}/approve`, { cookie, body: {} });
  for (let i = 0; i < 100; i++) { await sleep(200); t = (await req('GET', base, { cookie })).json; if (['approved', 'failed', 'needs_human'].includes(t.status)) break; }
  check('best-of-2 approved with OpenCode as winner', t.status === 'approved' && t.winner === 'b');
  check('edited spec reached the implementer', fs.readFileSync(path.join(repo, `.ai/tasks/${id}/r1-a-impl-prompt.md`), 'utf8').includes('AC-2: handles negatives'));
  check('usage tracked for all three agents', ['claude', 'gemini', 'opencode'].every((a) => t.usage[a] && t.usage[a].input > 0));
  // SSE replay
  const sse = await new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: `${base}/events?since=0`, headers: { Host: `127.0.0.1:${PORT}`, Cookie: cookie } }, (resp) => {
      let d = ''; resp.on('data', (c) => { d += c; if (d.includes('"type":"approved"')) { rq.destroy(); res(d); } });
    }); rq.end(); setTimeout(() => { rq.destroy(); res(''); }, 3000);
  });
  check('SSE stream replays events up to approval', sse.includes('"type":"selected"') && sse.includes('"type":"approved"'));
  const sse2 = await new Promise((res) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: `${base}/events`, headers: { Host: `127.0.0.1:${PORT}`, Cookie: cookie, 'Last-Event-ID': '999999' } }, (resp) => {
      let d = ''; resp.on('data', (c) => (d += c)); setTimeout(() => { rq.destroy(); res(d); }, 800);
    }); rq.end();
  });
  check('SSE honours Last-Event-ID on reconnect', !sse2.includes('"type"'));
  r = await req('POST', `${base}/merge`, { cookie, body: {} });
  check('merge via API', r.status === 200 && r.json.into === 'main' && fs.readFileSync(path.join(repo, 'src/add.sh'), 'utf8').includes('$1 + $2'));
  const list = (await req('GET', '/api/tasks', { cookie })).json;
  check('task list shows merged', list[0].status === 'merged');
  r = await req('POST', '/api/settings', { cookie, body: { config: { maxRounds: 5 }, prompts: { 'reviewer.md': '# custom' , '../evil.md': 'x' } } });
  const st = (await req('GET', '/api/settings', { cookie })).json;
  check('settings saved; unknown prompt names ignored', st.config.maxRounds === 5 && st.prompts['reviewer.md'] === '# custom' && !fs.existsSync(path.join(process.env.AI_KIT_HOME, 'evil.md')));
  srv.kill();
  console.log(`\nResult: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
