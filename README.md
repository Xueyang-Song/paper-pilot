<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=180&section=header&text=Paper%20Pilot&fontSize=72&fontColor=fff&animation=twinkling&fontAlignY=32&desc=Local-First%20AI%20Research%20Assistant%20for%20Scientists&descAlignY=55&descSize=20" width="100%"/>

[![Stars](https://img.shields.io/github/stars/Xueyang-Song/paper-pilot?style=for-the-badge&logo=github&color=FFD700)](https://github.com/Xueyang-Song/paper-pilot/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Electron](https://img.shields.io/badge/Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://electronjs.org/)
[![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![License](https://img.shields.io/github/license/Xueyang-Song/paper-pilot?style=for-the-badge&color=green)](LICENSE)
[![CI](https://github.com/Xueyang-Song/paper-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Xueyang-Song/paper-pilot/actions/workflows/ci.yml)
[![Release](https://github.com/Xueyang-Song/paper-pilot/actions/workflows/release.yml/badge.svg)](https://github.com/Xueyang-Song/paper-pilot/actions/workflows/release.yml)

**Navigate the sea of academic papers — with AI as your co-pilot.**

[Features](#-features) • [Quick Start](#-quick-start) • [Sources](#-paper-sources) • [Architecture](#-architecture) • [Contributing](#-contributing)

</div>

---

## What is Paper Pilot?

Paper Pilot is a **local-first desktop research assistant** built for scientists who are tired of switching between 10 browser tabs to find, read, and synthesize academic papers.

Projects, papers, notes, conversations, citations, and indexes stay on your machine. Ollama keeps generation local; when you select a hosted provider, only the context needed for that request is sent to the configured endpoint.

```
You ──▶  Ask a research question
          │
          ▼
     Paper Pilot crawls 8+ academic sources simultaneously
          │
          ▼
     Papers downloaded → converted → indexed (FTS5 + vector search)
          │
          ▼
     AI synthesizes insights from your local corpus
          │
          ▼
You ──▶  Get answers grounded in real papers, not hallucinations
```

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🔍 Multi-Source Paper Crawling

Simultaneously queries **8+ academic databases**:

- OpenAlex, Crossref, Semantic Scholar
- PubMed/PMC, arXiv, Europe PMC
- CORE, Unpaywall
- Google Scholar (experimental)

</td>
<td width="50%">

### 🤖 AI-Assisted Synthesis

- **Local Ollama** for fully offline operation
- **OpenAI-compatible** API support
- Vercel AI Gateway support with non-generating provider health checks
- Named, streaming research chats across local and hosted providers
- Grounded and Exploratory modes with request-scoped source pins
- Inspectable citations, safe run traces, Stop/Retry, and context-window visibility
- Automatically saved, non-indexed answer artifacts

</td>
</tr>
<tr>
<td width="50%">

### 🗄️ Smart Local Storage

- **SQLite** with `node:sqlite` (zero dependencies)
- **FTS5** full-text search across all papers
- **`sqlite-vec`** vector similarity search
- Project-scoped storage — keep research contexts separate

</td>
<td width="50%">

### 📄 PDF → Knowledge Pipeline

- Open-access PDF auto-fetching via Unpaywall
- **MarkItDown** conversion for AI-ready text
- Python virtualenv isolation for scripting tools
- Secure credential storage via Electron `safeStorage`

</td>
</tr>
<tr>
<td colspan="2">

### 🔬 Auditable Evidence Review

- Versioned protocols with separate title/abstract and full-text screening
- Previewed RIS, BibTeX, and mapped CSV imports with conservative deduplication
- Typed, evidence-linked extraction matrix and append-only decision history
- Provider-neutral, on-demand AI suggestions that require human confirmation
- Deterministic review-flow summary and traceable export package

See the [evidence review guide](docs/evidence-review.md).

</td>
</tr>
</table>

---

## 🚀 Quick Start

**Requirements:**

- Node.js `>= 22.18.0`
- Python 3.11+
- (Optional) [Ollama](https://ollama.com/) for local AI

```bash
# Clone and install
git clone https://github.com/Xueyang-Song/paper-pilot.git
cd paper-pilot
npm install

# Run in development
npm run dev

# Build for production
npm run build

# Package as desktop app
npm run package
```

> **Note:** Dev server must use `http://127.0.0.1:5173`. If that port is busy, free it before running.

---

## 📚 Paper Sources

| Source               | Type              | API Key Required     |
| -------------------- | ----------------- | -------------------- |
| **OpenAlex**         | Multidisciplinary | Optional (email)     |
| **Crossref**         | Multidisciplinary | Optional (email)     |
| **Semantic Scholar** | CS + Science      | Recommended          |
| **PubMed / PMC**     | Biomedical        | No                   |
| **arXiv**            | Physics/CS/Math   | No                   |
| **Europe PMC**       | Life Sciences     | No                   |
| **CORE**             | Open Access       | **Required**         |
| **Unpaywall**        | Open Access PDFs  | Optional (email)     |
| **Google Scholar**   | All fields        | No (experimental ⚠️) |

---

## 🏗 Architecture

```
paper-pilot/
├── src/
│   ├── electron/          # Main process (Node.js)
│   │   ├── crawlers/      # Academic source adapters
│   │   ├── db/            # SQLite + FTS5 + sqlite-vec
│   │   ├── agent/         # AI tool-calling agent
│   │   └── python/        # MarkItDown + Playwright bridge
│   └── renderer/          # React 19 + Vite UI
│       ├── workspace/     # ChatGPT-style chat interface
│       ├── projects/      # Project management rail
│       ├── artifacts/     # Paper & artifact panel
│       └── settings/      # API keys, policies
├── tests/                 # Vitest test suite
└── package.json
```

**Tech Stack:**

![Electron](https://img.shields.io/badge/Electron_42-47848F?style=flat-square&logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript_5-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite_8-646CFF?style=flat-square&logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)
![TanStack Query](https://img.shields.io/badge/TanStack_Query-FF4154?style=flat-square&logo=reactquery&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind_4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)
![Framer Motion](https://img.shields.io/badge/Framer_Motion-0055FF?style=flat-square&logo=framer&logoColor=white)
![Zod](https://img.shields.io/badge/Zod-3E67B1?style=flat-square&logo=zod&logoColor=white)
![Python](https://img.shields.io/badge/Python_3.11+-3776AB?style=flat-square&logo=python&logoColor=white)

---

## ⚠️ Current Status

This is an **early v1** — buildable, test-covered, but still hardening for production-level reliability.

| Area                                              | Status          |
| ------------------------------------------------- | --------------- |
| Core crawlers (OpenAlex, Crossref, arXiv, PubMed) | ✅ Stable       |
| SQLite + FTS5 + vector search                     | ✅ Stable       |
| AI agent (Ollama / OpenAI-compatible)             | ✅ Stable       |
| Evidence-grounded multi-chat research workspace   | ✅ Stable       |
| Auditable evidence review workspace               | ✅ Stable       |
| Google Scholar crawler                            | ⚠️ Experimental |
| macOS / Linux packaging                           | ⚠️ Untested     |
| Cloud sync / collaboration                        | ❌ Not planned  |

---

## 🤝 Contributing

Contributions welcome. Please open an issue before large PRs to discuss approach.

```bash
npm run verify                 # Format, lint, typecheck, coverage, and build
npm run format:check           # Check repository formatting
npm run lint                   # Run ESLint with zero warnings
npm run test                   # Run test suite (Vitest)
npm run test:coverage          # Run tests with enforced coverage thresholds
npm run typecheck              # TypeScript strict checks
npm run test:crawlers:api      # Live no-key HTTP source smoke
npm run test:crawlers:browser  # Playwright browser crawler smoke
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the protected PR workflow and automatic release labels.

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=6,11,20&height=80&section=footer" width="100%"/>

_Built by a researcher, for researchers._

[![GitHub](https://img.shields.io/badge/Xueyang--Song-181717?style=flat-square&logo=github)](https://github.com/Xueyang-Song)

</div>
