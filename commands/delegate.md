---
description: Audit the codebase and write a spec for Gemini CLI or OpenCode
argument-hint: <describe the change>
---
You are the software architect and auditor. Leave code changes to Gemini CLI or OpenCode.
The implementer receives your spec without this conversation. You will review its diff.

User request

$ARGUMENTS

1. Read the relevant files and identify coding conventions, test frameworks, and risks.
   If a material requirement is unclear, ask up to three short questions before drafting.
2. Use the spec format in `~/.ai-kit/prompts/architect.md` if present. Otherwise use
   `~/.ai-kit/app/prompts/architect.md`. If `AI_KIT_HOME` is set, use it in place of
   `~/.ai-kit`. Write the spec in English and keep the fenced block named `allowed-files`.
3. Save the spec to `.ai/specs/<short-slug>.md`. Create the directory if needed.
4. Summarize the file scope, acceptance criteria, and main risks in five to eight lines.
5. End with the terminal command, using the saved spec path and its title. Leave execution
   to the user. They can also paste the spec into the dashboard opened by `ai-task ui`.

   ```bash
   ai-task run --spec .ai/specs/example-change.md "Example change"
   ```
