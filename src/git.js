'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trimEnd();
}
function tryGit(cwd, args) { try { return git(cwd, args); } catch { return null; } }

function repoRoot(dir) {
  const r = tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!r) throw new Error(`Not a git repository: ${dir}`);
  return r;
}

function ensureExcluded(root) {
  const ex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']));
  fs.mkdirSync(path.dirname(ex), { recursive: true });
  const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
  if (!cur.split('\n').includes('.ai/')) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}.ai/\n`);
}

function head(root) { return git(root, ['rev-parse', 'HEAD']); }
function currentBranch(root) { return git(root, ['rev-parse', '--abbrev-ref', 'HEAD']); }
function isClean(root) { return git(root, ['status', '--porcelain']) === ''; }

function addWorktree(root, wtPath, branch, base) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', branch, wtPath, base]);
}
function removeWorktree(root, wtPath, branch) {
  tryGit(root, ['worktree', 'remove', '--force', wtPath]);
  tryGit(root, ['worktree', 'prune']);
  if (branch) tryGit(root, ['branch', '-D', branch]);
}

/** Symlink heavy, git-ignored dirs (node_modules, .venv) from the main tree so gates can run. */
function linkIgnoredDirs(root, wtPath, dirs) {
  const linked = [];
  for (const d of dirs) {
    const src = path.join(root, d), dst = path.join(wtPath, d);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    if (tryGit(root, ['check-ignore', '-q', d]) === null) continue; // only when ignored
    try { fs.symlinkSync(src, dst, 'junction'); linked.push(d); } catch { /* ignore */ }
  }
  return linked;
}

function changedFiles(wt, base) {
  tryGit(wt, ['add', '-A', '-N']);
  const out = tryGit(wt, ['diff', '--no-renames', '--name-status', base]) || '';
  return out.split('\n').filter(Boolean).map((l) => { const [st, ...rest] = l.split('\t'); return { status: st[0], file: rest.join('\t') }; });
}
function diff(wt, base) { tryGit(wt, ['add', '-A', '-N']); return tryGit(wt, ['diff', base]) || ''; }
function diffStat(wt, base) { return tryGit(wt, ['diff', '--stat', base]) || ''; }

function commitAll(wt, message, body) {
  git(wt, ['add', '-A']);
  git(wt, ['-c', 'user.name=' + (tryGit(wt, ['config', 'user.name']) || 'ai-task'),
    '-c', 'user.email=' + (tryGit(wt, ['config', 'user.email']) || 'ai-task@localhost'),
    'commit', '-q', '-m', message, '-m', body]);
  return head(wt);
}

module.exports = { git, tryGit, repoRoot, ensureExcluded, head, currentBranch, isClean, addWorktree, removeWorktree, linkIgnoredDirs, changedFiles, diff, diffStat, commitAll };
