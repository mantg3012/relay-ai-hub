#!/usr/bin/env node
// PreToolUse hook. In Architect mode (AI_KIT_ARCHITECT=1, via `ai-arch`), Claude may only write under .ai/.
if (process.env.AI_KIT_ARCHITECT !== '1') process.exit(0);
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let p = '';
  try { const j = JSON.parse(raw || '{}'); p = (j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || ''; } catch { process.exit(0); }
  if (!p) process.exit(0);
  const norm = p.replace(/\\/g, '/');
  if (norm.startsWith('.ai/') || norm.includes('/.ai/')) process.exit(0);
  process.stderr.write(`Architect mode: Claude may not edit "${p}". Write the spec under .ai/specs/ and hand it over with: ai-task run --spec <file> "<title>" (or start it from the dashboard).\n`);
  process.exit(2);
});
