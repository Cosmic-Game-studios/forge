<p align="center">
  <img src="assets/banner.svg" alt="Forge Coding Agent v0.2.0 alpha" width="100%">
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0--alpha-ff8a2a?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2022.6-3c873a?style=flat-square">
  <img alt="tests" src="https://img.shields.io/badge/tests-51%20passing-2ea043?style=flat-square">
  <img alt="runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-1-8957e5?style=flat-square">
  <img alt="language" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square">
</p>

<p align="center">
  <b>A terminal coding agent that does not take its own word for it.</b><br>
  Forge wraps a model in layers that catch mistakes while they are cheap:<br>
  feedback on every edit, a second pair of eyes before "done", and tools that let it <i>see</i> what it built.
</p>

---

```text
╭────────────────────────────────────────────────────────────────────────────╮
│            Forge Coding Agent v0.2.0 alpha                                 │
│     ▄                                                                      │
│    ▟█▙     Model     Claude Opus 5.5 claude-opus-5-5                       │
│   ▟███▙    Provider  Anthropic                                             │
│  ▟█████▙   Effort    high (/effort to change)                              │
│  █ ● ● █   Mode      ask — asks before edits and commands                  │
│  ▜█▄▄▄█▛   Folder    ~/projects/my-app                                     │
│   ▀▘ ▝▀    Extras    4 skills · 0 MCP tools                                │
╰────────────────────────────────────────────────────────────────────────────╯

 ❯ add rate limiting to the upload route

● Edit src/routes/upload.ts
  ⎿ 12 lines changed
● Check  npm test
  ⎿ 48 passed
● Review  independent reviewer, fresh context
  ⎿ no findings

╭─ Done ─────────────────────────────────────────────────────────────────────╮
│ Changed  src/routes/upload.ts +14 −2                                       │
│          test/upload.test.ts +31 new                                       │
│ Verified ✓ checks passed · ✓ review: no findings                           │
│ Took     1m 12s · 9 model requests · $0.0412                               │
│          /undo takes these changes back                                    │
╰────────────────────────────────────────────────────────────────────────────╯
```

## Why Forge

Most agents are a loop around a model: prompt, tool call, repeat. The model writes code, says it is done, and you find out later whether that was true. Forge puts a harness around the same loop so that a mistake is caught at the step where it happens.

| Layer | What it does |
|---|---|
| **Request preparation** | Before the model starts, Forge takes a snapshot of the project, finds the files and symbols your request mentions, and has the cheapest model classify the task. The model starts oriented instead of exploring. |
| **Instant edit feedback** | Every write and edit comes back with what is wrong in it: syntax errors, TypeScript type errors (also in other files the edit broke), the project's own linter, and language-independent notes such as placeholders, leftover debug output, swallowed errors, duplicated blocks and merge-conflict markers. |
| **Watcher** | While the main model keeps working, a small model reads each burst of edits and flags problems. It never blocks; its findings arrive with the next step. |
| **Automatic checks** | After changes Forge runs the project's tests or build on its own. Failures go back to the model before it may finish. |
| **Independent review** | Larger changes are read by a second run with an empty context that sees only your request and the diff. It has read-only tools, tries to break the change, and hands its findings back once. |
| **Graded compaction** | When the context fills up, the cheapest model summarises it: old turns briefly, recent ones in detail, the newest word for word. |
| **Memory and undo** | Project notes survive between sessions. Every request is a checkpoint; `/undo` takes its file changes back. |

## Tools that let the model see

- **`scene3d`** — opens a page in a headless browser and reads the real three.js scene: every object with position, size, distance from the camera and whether the camera sees it, plus pictures from the camera, from above, from the front and from the side. The model can press keys and compare positions before and after. Works on unmodified pages.
- **`screenshot`** — renders a URL or a local file at desktop or phone size and returns the picture together with the errors the page reported.
- **`deps`** — the import graph: what depends on a file, and which tests reach it.
- **`outline`**, **symbol edits** — read a file's structure and replace a whole function by name instead of matching text.
- **`check`** — runs the project's checks, or only the tests affected by what changed.
- **`task`** — hands a self-contained piece of work to a sub-agent.
- **MCP** — connect any [Model Context Protocol](https://modelcontextprotocol.io) server through `~/.forge/mcp.json` or a project's `.mcp.json` (project servers start only after you approve them).
- **Skills** — instructions loaded on demand. Built in: `frontend-design` and `3d-worlds`. Add your own as `SKILL.md` files.

## Quick start

Requires Node.js 22.6 or newer (24 recommended).

```bash
git clone https://github.com/Cosmic-Game-studios/forge.git
cd forge
npm install
npm run build
npm link
```

Then, in any project folder:

```bash
forge
```

On first start type `/keys` and paste your API key. Forge stores it in `~/.forge/config.json` on your machine, never in the project. You can also set `ANTHROPIC_API_KEY`.

### Providers

Forge speaks to **Anthropic**, **OpenRouter** and **OpenAI-compatible** endpoints. It is tuned for Claude models (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5) with adaptive thinking, prompt caching and streamed tool inputs.

```bash
forge -m anthropic:claude-opus-5-5
forge -m openrouter:anthropic/claude-opus-5.5 -e xhigh
forge -p "explain what src/agent.ts does"          # headless, read-only
forge -p "fix the failing test" --mode auto-edit   # headless, may edit
```

## Commands

| | |
|---|---|
| `/model` `/effort` `/subagent` | choose the model, how hard it thinks, and the model for sub-agents |
| `/mode` | `ask`, `auto-edit` or `yolo` (shift+tab cycles) |
| `/undo` | take back the file changes of the last request |
| `/compact` `/new` `/resume` | manage the conversation |
| `/autocheck` `/review` `/watch` `/prepare` | switch each harness layer on or off |
| `/skills` `/mcp` `/notes` | what Forge can load, what is connected, what it remembers |
| `/budget` `/cost` `/status` | spending limit, usage, and everything at a glance |
| `/init` | let Forge study the project and write `FORGE.md` |
| `/keys` `/web` `/thinking` `/help` `/exit` | settings and the rest |

## What has been measured

Forge is measured against a plain loop and against Claude Code, with the same model and hidden tests. The numbers so far, all with Claude Haiku 5.5:

- **Hard tasks** (regex engine, JavaScript interpreter, arbitrary-precision decimals, a performance refactor, a bug hunt): Forge and Claude Code both solved about 100 % of the hidden tests on all five. Forge was cheaper and faster on the smaller ones, slower and more expensive on the two largest.
- **Blind code review** of four of those solutions: Forge 7.0 / 10 on average, Claude Code 6.75 — no real difference.
- **Easy tasks**: the full harness and a bare loop both passed everything; the harness used about 10 % fewer requests and about 20 % more money.

In plain words: at this point Forge is on par, not ahead. The review pass, the watcher, the instant edit feedback and the 3D tools were added after these runs and **their effect on quality has not been measured yet**. The review pass alone makes small tasks roughly three to four times slower and more expensive. The benchmark scripts are in [`bench/`](bench) so you can repeat this yourself.

## Status

This is an **alpha**. It works, it has 51 tests, and it will change.

- Type feedback covers TypeScript; lint feedback covers ESLint and Ruff. Other languages get the language-independent notes only.
- `scene3d` understands three.js. Other engines get screenshots.
- The browser tools need Chrome or Edge installed.
- Developed and tested on Windows; macOS and Linux should work and are less tested.
- No licence has been chosen yet. Until one is added, all rights are reserved.

## Development

```bash
npm test             # 51 tests, no network: a scripted stand-in plays the API
npm run typecheck
npm run dev          # run from source
```

```text
src/
  agent.ts        the loop and every harness layer around it
  prompt.ts       the system prompt
  situate.ts      request preparation
  review.ts       independent review
  compact.ts      graded compaction
  providers/      Anthropic, OpenAI-compatible
  tools/          file edits, shell, search, graph, checks, browser, scene3d
  ui/             the terminal interface
skills/           built-in skills
bench/            benchmarks against a bare loop and against Claude Code
test/             tests and the scripted API
```

---

<p align="center"><sub>Built with Forge's mascot, Ember, keeping watch.</sub></p>
