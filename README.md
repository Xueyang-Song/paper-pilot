# Paper Pilot

Paper Pilot is a local-first desktop research assistant for scientists. It combines an Electron app, academic source crawlers, local project storage, artifact management, Python/MarkItDown conversion, and AI-assisted synthesis into one professional desktop workflow.

The app is intentionally a tool, not a landing page. The main workspace is organized around projects, chat, crawl jobs, papers, and artifacts.

## Current Status

This repository is an early v1 implementation. It is buildable and test-covered, but several research-grade reliability areas still need hardening before calling it production-ready.

Implemented today:

- Cross-platform Electron shell with React, TypeScript, Vite, Tailwind, TanStack Query, Jotai, Framer Motion, and Lucide icons.
- Project rail, ChatGPT-style workspace, artifact panel, settings panel, and job approval drawer.
- Local SQLite storage through Node's built-in `node:sqlite`.
- FTS5 text search plus `sqlite-vec` vector search using deterministic local embeddings.
- API-first source registry for OpenAlex, Crossref, Semantic Scholar, PubMed/PMC, arXiv, Europe PMC, CORE, and Unpaywall.
- Experimental Google Scholar fallback through a built-in Playwright Python script.
- Project policy gates for crawls, Python scripts, and browser installs.
- Secure-ish credential storage through Electron `safeStorage` when available.
- Python project virtualenv creation, guarded script execution, Playwright install hook, and MarkItDown conversion.
- Open-access PDF fetching into project artifacts.
- Local Ollama tool-calling agent path, plus Vercel AI Gateway / OpenAI-compatible settings.
- Windows packaging via `electron-builder`.

Important caveats:

- Google Scholar automation is experimental and can be blocked by Google. The crawler handles failure gracefully, but live stability depends on upstream anti-automation behavior.
- Semantic Scholar and CORE are much more reliable with API keys. CORE requires one.
- `node:sqlite` currently emits Node's experimental SQLite warning in tests and dev output.
- macOS and Linux package smoke tests have not been run from this Windows workspace.
- This is local-first only. There is no cloud sync or collaboration layer.

## Requirements

- Node.js `>=22.18.0`
- npm
- Python 3.11+ or 3.12+ available on PATH for Python tools
- Optional: [Ollama](https://ollama.com/) for local agent testing
- Optional: API keys for Vercel AI Gateway, Semantic Scholar, CORE, OpenAlex, Crossref email, etc.

Electron is pinned to `42.0.0`.

## Quick Start

Install dependencies:

```bash
npm install
```

Run the app in development:

```bash
npm run dev
```

The dev server must use `http://127.0.0.1:5173`. If that port is busy, stop the process using it and rerun `npm run dev`.

Build the app:

```bash
npm run build
```

Run the built Electron app:

```bash
npm start
```

Package the desktop app:

```bash
npm run package
```

On Windows, packaged output is written to `release/`, including `release/win-unpacked/` and an NSIS installer.

## Useful Scripts

```bash
npm run dev             # Start Vite and Electron for development
npm run build           # Typecheck, build Electron main/preload, build renderer
npm run build:electron  # Build Electron main/preload only
npm run typecheck       # Run TypeScript checks
npm test                # Run Vitest tests
npm start               # Launch Electron from built output
npm run package         # Build and package with electron-builder
```

## App Workflow

1. Create or select a project from the left rail.
2. Use chat to start a research task, such as:

```text
Crawl open-access papers about protein folding with graph neural networks.
```

3. If project policy requires approval, the job appears in the bottom-right job drawer.
4. Approve or deny the crawl/script/browser job.
5. Crawled metadata, Markdown digests, PDFs, logs, and briefs appear in the artifact panel.
6. Ask follow-up questions or generate a research brief from the project corpus.

## Sources

Paper Pilot has a built-in source registry.

API-first sources:

- OpenAlex
- Crossref
- Semantic Scholar
- PubMed / PMC
- arXiv
- Europe PMC
- CORE
- Unpaywall

Browser fallback:

- Google Scholar, experimental and approval-gated

The crawler stores metadata for discovered papers and fetches open-access full text only when a legal OA PDF URL is available.

## AI Providers

Paper Pilot is Vercel AI Gateway-first, with a generic OpenAI-compatible base URL fallback in settings.

The app also includes a local Ollama tool-calling path. For a small local smoke-test model:

```bash
ollama pull qwen2.5:0.5b
ollama serve
```

If Ollama is running at `http://127.0.0.1:11434`, the local agent service can use it for tool calls such as listing project state, searching the corpus, preparing crawls, and generating briefs.

## Python And MarkItDown

Paper Pilot creates per-project Python virtual environments under the app data directory. Python scripts are approval-gated by project policy unless the user enables a more permissive mode.

Python tools currently support:

- Built-in Playwright install for browser fallback crawlers
- AI/user-provided script execution with logs
- MarkItDown conversion
- Project-scoped environment variables such as `PAPER_PILOT_PROJECT_DIR`

MarkItDown conversions are imported back into Paper Pilot as Markdown artifacts and indexed for search.

## Storage

Paper Pilot is local-first.

Data is stored in Electron's `userData` directory:

- `paper-pilot.db` for projects, messages, policies, papers, artifacts, chunks, embeddings, jobs, reports, and credential metadata
- `projects/<project-id>/artifacts/` for files
- `projects/<project-id>/scripts/` for generated Python scripts
- `projects/<project-id>/.venv/` for per-project Python tooling

Secrets are encrypted with Electron `safeStorage` where supported. If OS-backed encryption is unavailable, the current fallback is base64 storage with a `plain:` prefix; do not treat that fallback as strong encryption.

## Architecture

High-level layout:

```text
src/
  main/
    index.ts                  Electron main process bootstrap
    ipc.ts                    Zod-validated IPC handlers
    db.ts                     SQLite, FTS, sqlite-vec, persistence
    services/
      agent-service.ts        Chat entrypoint and deterministic fallback planner
      local-agent-service.ts  Ollama tool-calling loop
      ai-service.ts           Gateway/local brief generation
      crawl-service.ts        Source crawl orchestration
      browser-crawler-service.ts
      python-service.ts       Python venvs, script execution, MarkItDown
      full-text-service.ts    Open-access PDF fetch/import
      artifact-service.ts     Artifact writes/imports/indexing
      policy.ts               Approval policy checks
    sources/
      connectors.ts           API source connectors
      browser-scripts.ts      Built-in Python Playwright scripts
      registry.ts             Source registry and graceful failure wrapper
  preload/
    index.ts                  Safe renderer API bridge
  renderer/
    App.tsx                   Desktop UI
    styles.css                Tailwind and app styles
  shared/
    schemas.ts                Zod schemas and shared types
tests/
```

Renderer code has no direct Node access. It talks to the main process through the preload API.

## Testing

Run:

```bash
npm test
```

Current tests cover:

- Shared schemas and dedupe keys
- SQLite migrations, messages, paper dedupe, FTS, and vector search
- Source registry behavior and graceful source failures
- Policy approval rules
- Local Ollama-style tool loop with mocked HTTP
- Open-access PDF artifact storage

Manual smoke tests that have been run in this workspace:

- `npm run typecheck`
- `npm run build`
- `npm run package`
- Packaged Windows app launch
- Live API connector smoke for no-key academic sources
- Google Scholar Playwright crawler against a local Scholar-shaped fixture
- MarkItDown conversion of local HTML into an indexed Markdown artifact
- Ollama `qwen2.5:0.5b` tool-call smoke

## Development Notes

- Keep crawlers defensive. Source failures should return warnings, not crash a project job.
- Do not bypass project approval policy from chat, agents, scripts, or browser flows.
- Do not store raw API keys in SQLite.
- Treat Google Scholar as experimental and explicitly user-approved.
- Avoid adding native Node addons unless they are verified against the pinned Electron version.
- Keep README claims aligned with tests and actual behavior.

## Known Gaps

- Browser crawler resilience needs more live-source testing and fixture coverage.
- The agent runtime has local tool calling, but not full frontier-model streaming/tool-loop parity.
- Python execution is permissioned, but not an OS-level sandbox.
- Citation-backed brief quality depends heavily on available full text and configured model quality.
- macOS/Linux packaging needs dedicated smoke testing.
- The app needs a custom icon and production signing/notarization setup.

## License

No license has been selected yet.
