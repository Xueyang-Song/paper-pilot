# Auditable evidence reviews

Paper Pilot can turn the papers in one project into a structured, local-first evidence review. Review mode is intentionally separate from reading status, favorites, notes, scores, and research chat. AI output is advisory: it never becomes a screening decision or confirmed extraction value without an explicit reviewer action.

## Workflow

1. Open a project, switch from **Chat** to **Review**, and activate review mode.
2. Define the research question, objectives, and ordered title/abstract and full-text criteria. The Blank, General empirical study, and PICO templates are starting points only.
3. Add candidates through an existing project corpus, a crawl, or a RIS, BibTeX, or CSV import. Import preview reports invalid records and conservative identity matches before it changes the project.
4. Screen titles and abstracts with Include, Exclude, or Uncertain. Only included papers move to full-text screening.
5. Fetch open-access text or attach a PDF. Every full-text exclusion requires a protocol criterion or custom reason. Only included full texts move to extraction.
6. Define up to 30 typed extraction fields, enter values, and link evidence where applicable.
7. Inspect the deterministic Review flow summary and export the auditable package.

Protocol revisions preserve prior human decisions and audit history. They mark earlier AI suggestions stale; use **Mark for re-review** when a decision should be reconsidered against the new protocol.

## Import and identity rules

Reference imports are limited to 50 MiB and 50,000 records. A title is required. CSV imports expose editable column mapping; RIS and BibTeX are mapped automatically.

Paper identity is deliberately conservative, in this order:

1. normalized DOI;
2. an authoritative source identifier;
3. exact normalized title, year, and first-author fingerprint.

A title match by itself is never auto-merged. Ambiguous records must be kept separate, merged into a selected paper, or skipped. Every source occurrence remains in discovery provenance even when it resolves to an existing paper.

## AI assistance and privacy

Review assistance uses the provider and model selected in Settings and processes at most 25 papers sequentially. Hosted-provider warnings follow the project policy. The service has no chat, crawler, brief, script, or destructive tools.

- Abstract screening sends only that paper's metadata, abstract, active protocol, and stage criteria.
- Full-text screening and extraction send only trusted indexed chunks linked to that paper.
- Extraction fields are sent in groups of at most six.
- Application-owned evidence IDs are checked for ownership and value type.
- Malformed output receives one repair attempt. A second failure is stored as failed with no suggestion.
- Cancellation uses an abort signal. Completed papers remain available; Retry processes only failed or cancelled items.

Events and audit records contain provider/model identifiers, progress, validated suggestions, errors, and timestamps. They exclude API keys, raw provider payloads, and hidden reasoning.

AI-derived extraction values require linked evidence before confirmation. Manual values can be confirmed without evidence and remain labeled **Manual—no linked evidence**.

## Review package

Export writes a directory with:

- `evidence-matrix.csv`
- `evidence-locators.csv`
- `screening-decisions.csv`
- `included-references.ris`
- `included-references.bib`
- `methods-and-status.md`
- `review-flow.svg`
- `review-audit.json`

The flow table and diagram are deterministic summaries of stored discovery provenance and current human decisions. They are labeled **Review flow** and do not claim PRISMA 2020 compliance. The package contains no AI-authored conclusions and is not automatically indexed as chat grounding material.

## Compatibility and recovery

Database schema version 3 is applied through ordered, transactional migrations. Existing projects are activated into a **Pre-existing project papers** batch without changing or losing paper data; the UI discloses that historical duplicate counts are unavailable.

Project export format version 3 carries review state and audit history. Versions 1 and 2 remain importable and become projects without an active review. Deleting linked papers or artifacts preserves review snapshots, excerpts, locators, decisions, and audit history even when navigation to the original identifier is no longer possible.
