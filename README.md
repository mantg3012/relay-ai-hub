# Relay AI Hub

Claude Code **audit, viết spec và review**. **Gemini CLI** và/hoặc **OpenCode** **implement**, mỗi task trong một
git worktree riêng. Lint/typecheck/test và scope check (chặn sửa file ngoài phạm vi, chặn sửa test có sẵn) quyết định
cùng review của Claude. Bạn duyệt spec và merge. Dùng qua **giao diện web localhost (tiếng Anh)** hoặc terminal.

## Yêu cầu

- Node.js 18+, Git và Bash. Relay dùng thư viện chuẩn của Node.js.
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (`claude`), đã đăng nhập
- Ít nhất một implementer: Gemini CLI (`npm i -g @google/gemini-cli`) và/hoặc OpenCode của opencode.ai (`npm i -g opencode-ai`)
- macOS, Linux hoặc Windows qua WSL

## Cài đặt

```bash
git clone https://github.com/mantg3012/relay-ai-hub.git
cd relay-ai-hub
./install.sh
export PATH="$HOME/.local/bin:$PATH"
ai-task doctor
```

Bộ cài đặt ứng dụng ở `~/.ai-kit/app`, tạo lệnh `ai-task` và `ai-arch` trong `~/.local/bin`,
đồng thời đăng ký hook Architect và lệnh `/delegate` cho Claude Code. Thêm dòng `export` vào
`~/.zshrc` hoặc `~/.bashrc` nếu muốn lưu PATH cho các phiên terminal sau.

Nếu bạn đang dùng v1, `install.sh` tự nâng cấp: thay hook cũ, chuyển `defaults.env` sang `config.json`,
và chỉ giữ những prompt v1 bạn đã tự sửa (các prompt chưa sửa sẽ dùng bản v2).

## Dùng hằng ngày

```bash
cd ~/code/my-repo
ai-task ui            # mở dashboard; repo hiện tại được thêm tự động
```

Trên dashboard: **New task** → mô tả yêu cầu → chọn cách tạo spec (Claude tự viết / Discuss first / dán spec có sẵn)
→ chọn chiến lược (Single / Fallback / Best of 2) → **Start task**. Theo dõi trực tiếp ở tab Activity, duyệt spec,
xem diff, review, token. Khi Approved: **Squash-merge into current branch**.

Terminal (cùng engine với dashboard):

```bash
ai-task run "thêm retry exponential backoff cho src/api/client.ts" --mode fallback
ai-task run --mode best-of-2 --impl gemini --secondary opencode "…"
ai-task list
ai-task show "$TASK_ID"
ai-task approve "$TASK_ID"
ai-task merge "$TASK_ID"
```

Gán `TASK_ID` bằng ID từ `ai-task list`. `fallback` và `best-of-2` cần cả hai implementer.
Nếu chỉ dùng OpenCode, chọn OpenCode trong Settings hoặc chạy `ai-task run --impl opencode "…"`.

Thảo luận spec với Claude trong terminal: `ai-arch` rồi `/delegate <yêu cầu>` (Claude bị chặn sửa code ngoài `.ai/`).

## Cấu hình

- Toàn máy: trang **Settings** hoặc `~/.ai-kit/config.json`. Prompt tuỳ chỉnh: `~/.ai-kit/prompts/`.
- Từng repo: `.ai-kit.json` ở gốc repo, ví dụ:

```json
{
  "gates": { "setup": "npm ci", "lint": "npm run lint", "typecheck": "npx tsc --noEmit", "test": "npm test -- --watchAll=false" },
  "mode": "fallback",
  "protectedGlobs": ["tests/*", "*.test.*", "*.spec.*"]
}
```

`node_modules`, `.venv`, `venv` (nếu bị git ignore) được symlink vào worktree để gate chạy được; nếu không đủ, đặt `gates.setup`.

## Bảo mật

Dashboard chỉ nghe trên `127.0.0.1`, cần link có token mới (in ra mỗi lần chạy `ai-task ui`), chặn request khác origin
và DNS rebinding. Mặc định implementer chỉ được sửa file (`auto_edit` / `safe`). Chế độ cho phép chạy lệnh chỉ nên dùng
trong container hoặc VM.

## Dữ liệu

Mọi thứ của một task nằm trong `<repo>/.ai/tasks/<ID>/` (spec, prompt từng vòng, log agent, log gate, diff, review,
`events.jsonl`). Relay thêm `.ai/` vào `.git/info/exclude` của repo chạy task.

## Test

```bash
npm test
node test/server.test.js
```

## Gỡ cài đặt

`./uninstall.sh`
