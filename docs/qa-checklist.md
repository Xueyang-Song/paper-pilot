# Paper Pilot QA Checklist

Use this checklist for fundamentals/stabilization passes before adding another major feature.

## Deterministic Checks

- [ ] Run `npm run verify`.
- [ ] Confirm the build has no TypeScript errors.
- [ ] Confirm unit tests pass.
- [ ] Note any Vite bundle-size warnings separately from functional failures.

## Live Crawler Smoke

- [ ] Run `npm run test:crawlers:api`.
- [ ] Run `npm run test:crawlers:browser`.
- [ ] Run `npm run test:crawlers`.
- [ ] Confirm no-key API crawlers return papers or graceful warnings without crashing.
- [ ] Confirm the browser crawler installs/uses Playwright Chromium on demand against the fixture.
- [ ] Confirm crawl metadata/digest artifacts include per-source diagnostics with source, duration, paper count, and warning/error state.

## Manual Electron Flow

- [ ] Start the app with `npm run dev`.
- [ ] Create a new project and select it from the project rail.
- [ ] Crawl no-key sources with a small query and low paper limit.
- [ ] Approve a browser-fallback crawl when prompted.
- [ ] Approve the Playwright Chromium install path when prompted.
- [ ] Confirm crawl jobs complete or fail gracefully with visible job details.
- [ ] Confirm crawled papers appear in the artifact panel.
- [ ] Confirm scores appear on paper artifacts after crawl.
- [ ] Use the score/rescore action for papers created before scoring existed.
- [ ] Search globally across projects.
- [ ] Search within the current project.
- [ ] Search within the current file.
- [ ] Click a search result and confirm the file modal opens the correct artifact.
- [ ] For PDF results, confirm the modal scrolls to the matching page.
- [ ] Confirm PDF search terms are highlighted on the page.
- [ ] Use previous/next hit buttons and confirm the active highlight changes.
- [ ] In Settings, switch between Ollama, Vercel AI Gateway, and OpenAI-compatible providers and run the provider health check.
- [ ] Confirm hosted providers without a stored key show a warning without making a generation request.
- [ ] Generate a research brief with Ollama selected as the AI provider.
- [ ] Temporarily break the selected provider and confirm brief generation falls back to local structured synthesis with provider/model/error metadata.
- [ ] Restart the app.
- [ ] Confirm projects, artifacts, papers, paper scores, and indexed search still work.
- [ ] Confirm waiting approval jobs remain pending and can still be approved or denied.
- [ ] Confirm queued/running jobs from before restart are marked interrupted instead of appearing active.

## Packaging Smoke

- [ ] Run `npm run package` on Windows.
- [ ] Launch the packaged app from `release/win-unpacked`.
- [ ] Confirm the app opens without renderer/preload bridge errors.
- [ ] Confirm project list and settings load in the packaged app.
