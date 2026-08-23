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
- [ ] Confirm Vercel without a stored key shows a warning, while a no-auth local OpenAI-compatible endpoint can run.
- [ ] Create two named chats in one project and confirm their histories and context remain isolated.
- [ ] Rename, export, and delete a chat; confirm deleting it does not delete its generated answer artifacts.
- [ ] In Grounded mode, ask a corpus question and confirm every research block has clickable evidence markers.
- [ ] Click citations for paper metadata and document chunks; confirm the evidence panel shows the exact excerpt and locator.
- [ ] Pin one paper or artifact, send a request, and confirm retrieval is constrained to that source and the pins clear afterward.
- [ ] Ask a Grounded question in an empty project and confirm Paper Pilot reports insufficient evidence without calling a model.
- [ ] Switch to Exploratory mode and confirm both the composer and completed answer show the model-knowledge warning.
- [ ] Stop an in-progress local and hosted response; confirm the partial message is marked stopped and no answer artifact is created.
- [ ] Expand the run trace and confirm it shows retrieval/tool/provider/citation phases but no credentials or hidden reasoning.
- [ ] Confirm each successful answer creates exactly one item under Generated answers and that reindexing does not make it searchable or groundable.
- [ ] Create enough chat history to exceed context capacity and confirm omitted-history counts are visible.
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

## Phase 3 Evidence Review Acceptance

- [ ] Upgrade a version-2 database and confirm projects, papers, artifacts, conversations, and messages are unchanged.
- [ ] Activate review mode on an existing project and confirm every paper appears in the pre-existing pending queue with the historical-count warning.
- [ ] Preview overlapping RIS and CSV files; resolve ambiguous records; confirm identified, invalid, duplicate, merged, and new counts match provenance.
- [ ] Confirm a same-title-only match is never merged automatically.
- [ ] Make title/abstract decisions with the keyboard and confirm only inclusions reach full-text screening.
- [ ] Confirm a full-text exclusion cannot be saved without a criterion or custom reason and does not change reading status.
- [ ] Attach or fetch a PDF and confirm trusted chunks are linked to the correct paper.
- [ ] Run a 25-paper Ollama review batch; stop it; confirm completed items remain and Retry processes only cancelled/failed items.
- [ ] Repeat with a hosted provider after the paid-model warning and confirm no credentials or raw payloads appear in events/audit data.
- [ ] Return malformed AI JSON twice and confirm one repair attempt followed by a failed item with no saved suggestion.
- [ ] Confirm a paper without indexed full text receives no purported full-text or extraction answer.
- [ ] Revise the protocol and confirm decisions remain, AI suggestions become stale, and selected decisions can be marked for re-review.
- [ ] Confirm AI-derived extraction values cannot be confirmed without valid same-paper evidence; manual values show the no-evidence label.
- [ ] Delete a cited paper/artifact and confirm evidence snapshots, locators, decisions, and audit events remain readable.
- [ ] Duplicate and export/import a reviewed project; compare protocol versions, provenance, decisions, extraction state, evidence, runs, and audit history.
- [ ] Export the review package and trace every flow count and matrix row to stored provenance and human decisions.
- [ ] Confirm the SVG is labeled “Review flow” and does not claim PRISMA compliance.
- [ ] Run `npm run verify` on Ubuntu and `npm run verify:platform` on Windows.
