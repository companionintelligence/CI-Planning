# AI-TODO-Static

A simple static web app that renders markdown files with interactive checkboxes. View and check off todos from your planning documents in one beautiful interface.

## Features

- 📁 Browse markdown files from configured directories
- ☑️ Interactive checkboxes that sync back to the source files
- 📝 View full markdown rendered beautifully
- 🔄 Auto-refresh on file changes
- 🎨 Clean, modern UI
- ⚡ Fast - static HTML + vanilla JS, no build step

## Quick Start

```bash
# Clone
git clone https://github.com/mrhegemon/ai-todo-static.git
cd ai-todo-static

# Install
npm install

# Configure watched directories (edit config.json)
cp config.example.json config.json

# Run
npm start

# Open http://localhost:3847
```

## Configuration

Edit `config.json` to specify which directories to watch:

```json
{
  "directories": [
    "~/Desktop/Planning",
    "~/Desktop/ci_computer",
    "~/Desktop/liambroza_com"
  ],
  "port": 3847,
  "title": "AI TODO Dashboard"
}
```

## How It Works

1. **Server** scans configured directories for `.md` files
2. **Frontend** renders markdown with checkboxes as interactive elements
3. **Clicking a checkbox** sends a PATCH request to toggle `[ ]` ↔ `[x]`
4. **Server** updates the source markdown file in place
5. **File watcher** triggers auto-refresh when files change externally

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List all markdown files |
| `/api/file?path=...` | GET | Get file content |
| `/api/file` | PATCH | Toggle a checkbox (`{path, line, checked, expectedText?}`) |
| `/api/search?q=...` | GET | Search file names and contents |
| `/api/config` | GET | Get current config |
| `/api/events` | GET | SSE stream of file change events |

The PATCH endpoint accepts an optional `expectedText` field. When provided, the
server verifies the line text matches before toggling and will search ±5 lines
to find the task if the file was edited externally between render and click.

## Security model

This server is designed for **single-tenant local use** — your own machine, or
yourself over Tailscale.

- By default the server binds to `127.0.0.1`. To expose it to your LAN or
  Tailnet, run `node server.js --host 0.0.0.0` (or `HOST=0.0.0.0 npm start`).
- All file paths are normalized and checked against the configured roots
  before any read or write. A path like `~/Desktop/PlanningSecret/...` does
  not match a root of `~/Desktop/Planning` (the original prefix-only check
  did — see commit history).
- Markdown is rendered with `marked` defaults; raw HTML is not stripped. **Do
  not point this at directories containing markdown from untrusted sources.**

## Tests

```bash
npm test
```

Pure helpers (`lib/util.js`) have `node:test` coverage for path-allow,
checkbox toggle (including drift recovery), and todo counting.

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS + CSS
- **Markdown**: marked.js
- **File watching**: chokidar

## Screenshots

```
┌─────────────────────────────────────────────────────────┐
│  AI TODO Dashboard                              🔄 ⚙️   │
├──────────────┬──────────────────────────────────────────┤
│ 📁 Files     │  # MASTER_PLAN.md                        │
│              │                                          │
│ Planning/    │  ## Week 1 Tasks                         │
│  ├ MASTER... │  ☑️ Add pricing to ci.computer           │
│  ├ CONTENT.. │  ☐ Publish 3 blog posts                  │
│  └ HIRING..  │  ☐ Create specs page                     │
│              │                                          │
│ ci_computer/ │  ## Week 2 Tasks                         │
│  └ SITE_P... │  ☐ Add FAQ section                       │
│              │  ☐ Mobile optimization                   │
└──────────────┴──────────────────────────────────────────┘
```

## License

MIT

## Author

Liam Broza ([@mrhegemon](https://github.com/mrhegemon))
