'use strict';
/**
 * Adapters normalise three different CLIs into one contract:
 *   build(opts)        -> { cmd, args, input, env }
 *   parse(line, acc)   -> normalised events [{ kind, text, file? }] ; mutates acc { sessionId, text, finalText, usage }
 *   isQuotaError(res)  -> boolean (used by fallback mode)
 * Every parser is defensive: CLIs change their event schemas between versions,
 * and non-JSON lines (banners, migrations) are passed through as plain info.
 */
const fs = require('fs');
const path = require('path');

const QUOTA_RE = /\b429\b|RESOURCE_EXHAUSTED|quota|rate[ -]?limit|usage limit|too many requests|insufficient_quota/i;
const EDIT_TOOLS = /^(write_file|replace|edit|write|multiedit|multi_edit|patch|apply_patch|create_file|str_replace)/i;

function newAcc() { return { sessionId: null, text: '', finalText: null, usage: { input: 0, output: 0, cacheRead: 0, cost: 0 }, edits: 0 }; }
function tryJson(line) { const t = line.trim(); if (!t.startsWith('{')) return null; try { return JSON.parse(t); } catch { return null; } }
function short(v, n = 160) { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; }
function fileOf(input) { if (!input || typeof input !== 'object') return null; return input.file_path || input.filePath || input.path || input.absolute_path || input.notebook_path || null; }

/** Walk an object and sum token-like fields. Works for Gemini's json `stats` and stream `result.stats`. */
function sumTokens(obj) {
  const u = { input: 0, output: 0, cacheRead: 0 };
  (function walk(o, keyPath) {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number') {
        const kk = k.toLowerCase();
        if (/^(input_tokens|input|prompt|prompt_tokens|prompttokencount)$/.test(kk)) u.input += v;
        else if (/^(output_tokens|output|candidates|completion_tokens|candidatestokencount)$/.test(kk)) u.output += v;
        else if (/^(cached|cache_read|cachedcontenttokencount|cache_read_input_tokens)$/.test(kk)) u.cacheRead += v;
      } else if (typeof v === 'object' && !/^(tools|files|byname)$/i.test(k)) walk(v, `${keyPath}.${k}`);
    }
  })(obj, '');
  return u;
}

// ───────────────────────────── Claude Code ─────────────────────────────
const READONLY_TOOLS = 'Read,Grep,Glob,LS,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*),Bash(git ls-files:*)';
const claude = {
  name: 'claude', bin: 'claude', label: 'Claude Code',
  build({ instruction, input, cfg, sessionId, model }) {
    const args = ['-p', instruction || 'Read the instructions provided on stdin and follow them exactly. Print ONLY the final deliverable, with no preamble.',
      '--output-format', 'stream-json', '--verbose', '--allowedTools', READONLY_TOOLS];
    const m = model || cfg.claude.model; if (m) args.push('--model', m);
    if (sessionId) args.push('--resume', sessionId);
    return { cmd: 'claude', args, input, env: { AI_KIT_ROLE: 'claude' } };
  },
  parse(line, acc) {
    const ev = tryJson(line); if (!ev) return line.trim() ? [{ kind: 'info', text: line.trim() }] : [];
    if (ev.session_id) acc.sessionId = ev.session_id;
    const out = [];
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text) { acc.text = c.text; out.push({ kind: 'text', text: c.text }); }
        else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${short(fileOf(c.input) || c.input?.pattern || c.input?.command || c.input)}`, file: fileOf(c.input) });
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') acc.finalText = ev.result;
      if (ev.usage) {
        acc.usage.input = (ev.usage.input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0);
        acc.usage.output = ev.usage.output_tokens || 0;
        acc.usage.cacheRead = ev.usage.cache_read_input_tokens || 0;
      }
      if (typeof ev.total_cost_usd === 'number') acc.usage.cost = ev.total_cost_usd;
      if (ev.is_error) out.push({ kind: 'error', text: short(ev.result || ev.subtype, 400) });
    } else if (ev.type === 'system' && ev.subtype === 'init') out.push({ kind: 'info', text: `session ${ev.session_id || ''} ${ev.model || ''}`.trim() });
    return out;
  },
  isQuotaError(res) { return res.code !== 0 && QUOTA_RE.test(res.stderr + res.stdout.slice(-4000)); },
};

// ───────────────────────────── Gemini CLI ─────────────────────────────
const gemini = {
  name: 'gemini', bin: 'gemini', label: 'Gemini CLI',
  build({ input, cfg, sessionId }) {
    const g = cfg.gemini;
    const args = ['-p', 'Read the instructions provided on stdin and carry them out by editing files in this repository.',
      '--output-format', g.output === 'json' ? 'json' : 'stream-json'];
    if (g.approval === 'yolo') args.push('--yolo'); else args.push('--approval-mode', g.approval || 'auto_edit');
    if (g.model) args.push('-m', g.model);
    if (sessionId) args.push('-r', sessionId);
    return { cmd: 'gemini', args, input, env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
  },
  parse(line, acc) {
    const ev = tryJson(line); if (!ev) return line.trim() ? [{ kind: 'info', text: line.trim() }] : [];
    const out = [];
    if (ev.session_id || ev.sessionId) acc.sessionId = ev.session_id || ev.sessionId;
    if (typeof ev.response === 'string') { acc.finalText = ev.response; out.push({ kind: 'text', text: short(ev.response, 2000) }); }
    switch (ev.type) {
      case 'init': out.push({ kind: 'info', text: `session ${acc.sessionId || ''} ${ev.model || ''}`.trim() }); break;
      case 'message':
        if (ev.role !== 'user' && ev.content) { acc.text += ev.content; if (!ev.delta) out.push({ kind: 'text', text: ev.content }); else out.push({ kind: 'delta', text: ev.content }); }
        break;
      case 'tool_use': {
        const name = ev.tool_name || ev.name || 'tool'; const f = fileOf(ev.parameters || ev.args || ev.input);
        if (EDIT_TOOLS.test(name)) acc.edits++;
        out.push({ kind: EDIT_TOOLS.test(name) ? 'edit' : 'tool', text: `${name} ${short(f || ev.parameters || '')}`, file: f });
        break;
      }
      case 'tool_result': if (ev.status && ev.status !== 'success') out.push({ kind: 'error', text: `tool failed: ${short(ev.output || ev.error, 300)}` }); break;
      case 'error': out.push({ kind: 'error', text: short(ev.message || ev.error || ev, 400) }); break;
      default: break;
    }
    if (ev.stats) { const u = sumTokens(ev.stats); acc.usage.input = u.input; acc.usage.output = u.output; acc.usage.cacheRead = u.cacheRead; }
    if (ev.type === 'result' && !acc.finalText) acc.finalText = acc.text;
    return out;
  },
  isQuotaError(res) { return res.code !== 0 && QUOTA_RE.test(res.stderr + res.stdout.slice(-4000)); },
};

// ───────────────────────────── OpenCode (opencode.ai) ─────────────────────────────
const opencode = {
  name: 'opencode', bin: 'opencode', label: 'OpenCode',
  build({ promptFile, cfg, sessionId, taskDir }) {
    const o = cfg.opencode;
    const args = ['run', '--format', 'json'];
    const env = {};
    if (o.model) args.push('-m', o.model);
    if (sessionId) args.push('--session', sessionId);
    if (o.approval === 'yolo') args.push('--dangerously-skip-permissions');
    else {
      // "safe" = may edit files, may not run shell or fetch the web (equivalent of Gemini auto_edit)
      const safeCfg = path.join(taskDir, 'opencode.safe.json');
      fs.writeFileSync(safeCfg, JSON.stringify({ $schema: 'https://opencode.ai/config.json', permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' } }, null, 2));
      env.OPENCODE_CONFIG = safeCfg;
    }
    args.push('-f', promptFile, 'Follow the instructions in the attached file exactly, editing files in this repository.');
    return { cmd: 'opencode', args, input: null, env };
  },
  parse(line, acc) {
    const ev = tryJson(line); if (!ev) return line.trim() ? [{ kind: 'info', text: line.trim() }] : [];
    const out = []; const part = ev.part || {};
    if (ev.sessionID || part.sessionID) acc.sessionId = ev.sessionID || part.sessionID;
    switch (ev.type) {
      case 'text': if (part.text) { acc.text += part.text; out.push({ kind: 'text', text: part.text }); } break;
      case 'tool_use': case 'tool': {
        const name = part.tool || ev.tool || 'tool'; const f = fileOf(part.state?.input || part.input);
        if (EDIT_TOOLS.test(name)) acc.edits++;
        out.push({ kind: EDIT_TOOLS.test(name) ? 'edit' : 'tool', text: `${name} ${short(f || part.state?.input || '')}`, file: f });
        if (part.state?.status === 'error') out.push({ kind: 'error', text: short(part.state.error, 300) });
        break;
      }
      case 'step_finish': {
        const t = part.tokens || {};
        acc.usage.input += t.input || 0; acc.usage.output += (t.output || 0) + (t.reasoning || 0);
        acc.usage.cacheRead += (t.cache && t.cache.read) || 0;
        if (typeof part.cost === 'number') acc.usage.cost += part.cost;
        break;
      }
      case 'error': out.push({ kind: 'error', text: short(ev.error?.data?.message || ev.error?.message || ev.error || ev, 400) }); break;
      default: break;
    }
    acc.finalText = acc.text;
    return out;
  },
  isQuotaError(res) { return res.code !== 0 && QUOTA_RE.test(res.stderr + res.stdout.slice(-4000)); },
};

const ADAPTERS = { claude, gemini, opencode };
const IMPLEMENTERS = ['gemini', 'opencode'];
module.exports = { ADAPTERS, IMPLEMENTERS, newAcc, sumTokens };
