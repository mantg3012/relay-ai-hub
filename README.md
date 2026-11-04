# Relay AI Hub

Relay coordinates AI coding tasks from a local web dashboard or the terminal. Claude Code
audits the repository, writes the specification, and reviews the diff. Gemini CLI or
OpenCode implements the change in an isolated Git worktree. Relay runs the configured
checks and verifies the file scope. You can approve the spec before implementation and
squash-merge the approved change into your current branch.

## Requirements

- macOS, Linux, or Windows with WSL
- Node.js 18+, Git, and Bash for Relay
- Claude Code (`claude`), installed and authenticated. [Claude Code quickstart](https://code.claude.com/docs/en/quickstart)
- At least one configured implementer. Gemini CLI (`gemini`) calls for Node.js 20+.
  [Gemini CLI installation](https://geminicli.com/docs/get-started/installation/), [OpenCode installation and configuration](https://opencode.ai/docs/)

## Install

```bash
git clone https://github.com/mantg3012/relay-ai-hub.git
cd relay-ai-hub
./install.sh
export PATH="$HOME/.local/bin:$PATH"
ai-task doctor
```

The installer copies Relay to `~/.ai-kit/app`, links `ai-task` and `ai-arch` in
`~/.local/bin`, and registers the Architect hook and `/delegate` command in Claude Code.
To keep the PATH change in new terminal sessions, add the export line to `~/.zshrc` or
`~/.bashrc`.

When upgrading from Relay v1, the installer replaces the old hook and migrates
`defaults.env` if `config.json` is absent. Customized prompts take precedence over the
bundled prompts.

## Run a task

From the Git repository you want to work on, launch the dashboard. Relay adds the
current repository automatically.

```bash
cd ~/code/my-repo
ai-task ui
```

Select **New task** and describe the change. Choose **Claude writes it**, **Discuss first**,
or **I have a spec**. Select an implementation strategy, then click **Start task**.
Follow progress in **Activity** and inspect the spec, diff, review, and token usage.
After approval, select **Squash-merge into current branch** to apply the change.

**Single** uses one implementer. **Fallback** switches to the second implementer when the
first hits a quota or rate limit. **Best of 2** runs both in parallel and has Claude select
a candidate. The two-implementer strategies require both CLIs.

The CLI uses the same workflow. Pick the implementer you installed, using
`--impl gemini` for Gemini CLI or `--impl opencode` for OpenCode.

```bash
ai-task run --mode single --impl opencode "Add exponential backoff to the API client"
ai-task list
```

Copy a task ID from `ai-task list` and assign it to `TASK_ID`. Then use
`ai-task show "$TASK_ID"` to inspect it, `ai-task approve "$TASK_ID"` when it is waiting
for spec approval, or `ai-task merge "$TASK_ID"` once the implementation is approved.
Run `ai-task help` for more commands and options.

To write a spec interactively, start Claude Code with `ai-arch` and enter
`/delegate <request>`. The Architect hook restricts file edits made through Claude's
editing tools to `.ai/`. You can pass the resulting spec to `ai-task run --spec` or paste
it into the dashboard.

## Configuration

Use **Settings** in the dashboard or edit `~/.ai-kit/config.json` for global defaults.
Specs and reviews use English by default. Change **Spec and review language** or set
`outputLanguage` to use another language. Put custom prompts in `~/.ai-kit/prompts/`.

Add `.ai-kit.json` at the root of a target repository to set its checks and defaults.
For example, a TypeScript project could use the following configuration.

```json
{
  "gates": {
    "setup": "npm ci",
    "lint": "npm run lint",
    "typecheck": "npx tsc --noEmit",
    "test": "npm test"
  },
  "protectedGlobs": ["tests/*", "*.test.*", "*.spec.*"]
}
```

Relay can symlink Git-ignored dependency directories such as `node_modules`, `.venv`,
and `venv` into a worktree. Use `gates.setup` when the worktree needs its own setup.

## Local access and task data

The dashboard listens on `127.0.0.1` and prints a new access link each time it starts.
Keep that link private. The server checks request hosts and rejects cross-origin writes.
Relay uses Gemini's `auto_edit` and OpenCode's `safe` permission modes by default. Use
the option that allows implementers to run commands only inside a container or VM.

Each task saves its spec, prompts, logs, diffs, reviews, and event history under
`<repo>/.ai/tasks/<ID>/`. Relay adds `.ai/` to that repository's `.git/info/exclude`.

## Run the tests

The end-to-end and dashboard API tests use fake agent CLIs.

```bash
npm test
node test/server.test.js
```

## Uninstall

Run `./uninstall.sh` from this repository. The script asks whether to remove your Relay
settings and custom prompts. Task history stays in each repository.

## License

MIT. See [LICENSE](LICENSE).
