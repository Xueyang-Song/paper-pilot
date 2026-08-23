import {
  paperSchema,
  type DiscoveryBatch,
  type ExtractionField,
  type ExtractionPrimitiveValue,
  type ExtractionValue,
  type Paper,
  type ReviewAuditEvent,
  type ReviewEvidence,
  type ReviewFlowSummary,
  type ReviewProtocol,
  type ReviewProtocolRevision,
  type ReviewRun,
  type ScreeningDecision
} from "../../shared/schemas.js";
import type {
  ExtractionFieldHistoryEntry,
  ExtractionValueHistoryEntry,
  PortableExtractionValue,
  PortableReviewEvidence,
  PortableReviewRunItem,
  PortableScreeningDecision,
  ReviewCandidateOrigin
} from "../db.js";

export interface ReviewExportInput {
  protocol: ReviewProtocol;
  revision: ReviewProtocolRevision;
  revisions: readonly ReviewProtocolRevision[];
  batches: readonly DiscoveryBatch[];
  candidateOrigins: readonly ReviewCandidateOrigin[];
  screeningDecisions: readonly PortableScreeningDecision[];
  includedPapers: readonly Paper[];
  includedPaperIds: readonly string[];
  extractionFields: readonly ExtractionField[];
  extractionFieldHistory: readonly ExtractionFieldHistoryEntry[];
  extractionValues: readonly PortableExtractionValue[];
  extractionValueHistory: readonly ExtractionValueHistoryEntry[];
  evidence: readonly PortableReviewEvidence[];
  runs: readonly ReviewRun[];
  runItems: readonly PortableReviewRunItem[];
  auditEvents: readonly ReviewAuditEvent[];
  flowSummary: ReviewFlowSummary;
}

export const REVIEW_EXPORT_FILE_NAMES = [
  "evidence-matrix.csv",
  "evidence-locators.csv",
  "screening-decisions.csv",
  "included-references.ris",
  "included-references.bib",
  "review-summary.md",
  "review-flow.svg",
  "review-audit.json"
] as const;

export type ReviewExportFileName = (typeof REVIEW_EXPORT_FILE_NAMES)[number];
export type ReviewExportPackage = Map<ReviewExportFileName, string>;

/**
 * Render an auditable review export without touching the filesystem.
 * The same logical input always produces byte-for-byte identical files.
 */
export function renderReviewExportPackage(input: ReviewExportInput): ReviewExportPackage {
  const paperById = collectPaperSnapshots(input);
  const papers = sortPapers(
    input.includedPaperIds.flatMap((paperId) => {
      const paper = paperById.get(paperId);
      return paper ? [paper] : [];
    })
  );
  const fields = sortFields(input.extractionFields.filter((field) => field.active));
  const values = currentConfirmedValues(input.extractionValues, fields, new Set(papers.map((paper) => paper.id)));
  const files: ReviewExportPackage = new Map();

  files.set("evidence-matrix.csv", renderEvidenceMatrix(papers, fields, values));
  files.set(
    "evidence-locators.csv",
    renderEvidenceLocators(paperById, input.extractionFields, input.extractionValues, input.evidence)
  );
  files.set("screening-decisions.csv", renderScreeningDecisions(input.screeningDecisions, paperById, input.revisions));
  files.set("included-references.ris", renderRis(papers));
  files.set("included-references.bib", renderBibtex(papers));
  files.set("review-summary.md", renderSummary(input, papers, fields, values, paperById));
  files.set("review-flow.svg", renderFlowSvg(input.flowSummary));
  files.set("review-audit.json", renderAuditJson(input, papers, paperById));

  return files;
}

function renderEvidenceMatrix(
  papers: readonly Paper[],
  fields: readonly ExtractionField[],
  values: ReadonlyMap<string, ExtractionValue>
): string {
  const fieldHeaders = uniqueFieldHeaders(fields);
  const headers = ["paper_id", "title", "authors", "year", "doi", ...fieldHeaders];
  const rows = papers.map((paper) => [
    paper.id,
    paper.title,
    paper.authors.join("; "),
    paper.year,
    paper.doi,
    ...fields.map((field) => {
      const value = values.get(valueKey(paper.id, field.id));
      return value ? renderExtractionValue(value.value) : "";
    })
  ]);
  return renderCsv(headers, rows);
}

function renderEvidenceLocators(
  paperById: ReadonlyMap<string, Paper>,
  fields: readonly ExtractionField[],
  values: readonly ExtractionValue[],
  evidence: readonly ReviewEvidence[]
): string {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const valuesByEvidenceId = new Map<string, ExtractionValue[]>();
  for (const value of [...values].sort(compareExtractionValues)) {
    for (const evidenceId of value.evidenceIds) {
      valuesByEvidenceId.set(evidenceId, [...(valuesByEvidenceId.get(evidenceId) ?? []), value]);
    }
  }
  const rows: CsvCell[][] = [];
  for (const entry of [...evidence].sort(compareEvidence)) {
    const linkedValues = valuesByEvidenceId.get(entry.id) ?? [undefined];
    for (const value of linkedValues) {
      const paperId = entry.paperId ?? value?.paperId;
      const paper = paperId ? paperById.get(paperId) : undefined;
      const field = value ? fieldById.get(value.fieldId) : undefined;
      rows.push([
        entry.id,
        entry.evidenceId,
        entry.sourceType,
        paperId,
        paper?.title,
        paper ? "retained" : paperId ? "snapshot unavailable" : "not linked",
        entry.artifactId,
        entry.chunkId,
        entry.title,
        entry.excerpt,
        entry.page,
        entry.locator,
        entry.doi,
        entry.url,
        entry.retrievalScore,
        entry.runId,
        entry.runItemId,
        value?.id,
        value?.fieldId,
        field?.name,
        value?.status,
        value?.origin
      ]);
    }
  }

  return renderCsv(
    [
      "evidence_record_id",
      "evidence_id",
      "source_type",
      "paper_id",
      "paper_title",
      "paper_record_state",
      "artifact_id",
      "chunk_id",
      "evidence_title",
      "excerpt",
      "page",
      "locator",
      "doi",
      "url",
      "retrieval_score",
      "run_id",
      "run_item_id",
      "value_id",
      "field_id",
      "field_name",
      "value_status",
      "value_origin"
    ],
    rows
  );
}

function renderScreeningDecisions(
  decisions: readonly PortableScreeningDecision[],
  paperById: ReadonlyMap<string, Paper>,
  revisions: readonly ReviewProtocolRevision[]
): string {
  const criterionByRevisionAndId = new Map(
    revisions.flatMap((revision) =>
      revision.criteria.map((criterion) => [`${revision.id}\u0000${criterion.id}`, criterion] as const)
    )
  );
  const rows = [...decisions].sort(compareDecisions).map((decision) => {
    const criterion = decision.reasonCriterionId
      ? criterionByRevisionAndId.get(`${decision.protocolRevisionId}\u0000${decision.reasonCriterionId}`)
      : undefined;
    const paper = paperById.get(decision.paperId);
    return [
      decision.id,
      decision.paperId,
      paper?.title,
      paper ? "retained or snapshotted" : "snapshot unavailable",
      decision.stage,
      decision.decision,
      decision.reasonCriterionId,
      criterion?.label,
      decision.customReason,
      decision.protocolRevisionId,
      decision.previousDecisionId,
      decision.runItemId,
      decision.createdAt
    ];
  });
  return renderCsv(
    [
      "decision_id",
      "paper_id",
      "paper_title",
      "paper_record_state",
      "stage",
      "decision",
      "reason_criterion_id",
      "reason_criterion",
      "custom_reason",
      "protocol_revision_id",
      "previous_decision_id",
      "run_item_id",
      "created_at"
    ],
    rows
  );
}

function renderRis(papers: readonly Paper[]): string {
  const lines: string[] = [];
  for (const paper of papers) {
    lines.push("TY  - JOUR", `TI  - ${risText(paper.title)}`);
    for (const author of paper.authors) lines.push(`AU  - ${risText(author)}`);
    if (paper.abstract) lines.push(`AB  - ${risText(paper.abstract)}`);
    if (paper.year) lines.push(`PY  - ${paper.year}`);
    if (paper.doi) lines.push(`DO  - ${risText(paper.doi)}`);
    if (paper.url) lines.push(`UR  - ${risText(paper.url)}`);
    if (paper.pdfUrl) lines.push(`L1  - ${risText(paper.pdfUrl)}`);
    if (paper.venue) lines.push(`JO  - ${risText(paper.venue)}`);
    if (paper.sourcePaperId) lines.push(`AN  - ${risText(paper.sourcePaperId)}`);
    lines.push(`DP  - ${risText(paper.source)}`);
    if (paper.citationCount !== undefined) lines.push(`TC  - ${paper.citationCount}`);
    lines.push("ER  -", "");
  }
  return ensureFinalNewline(lines.join("\n"));
}

function renderBibtex(papers: readonly Paper[]): string {
  const keyCounts = new Map<string, number>();
  const entries = papers.map((paper) => {
    const baseKey = bibtexBaseKey(paper);
    const count = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, count);
    const key = count === 1 ? baseKey : `${baseKey}${count}`;
    const fields: Array<[string, string | number | undefined]> = [
      ["title", paper.title],
      ["author", paper.authors.length ? paper.authors.join(" and ") : undefined],
      ["year", paper.year],
      ["abstract", paper.abstract],
      ["journal", paper.venue],
      ["doi", paper.doi],
      ["url", paper.url],
      ["pdf", paper.pdfUrl],
      ["source", paper.source],
      ["sourceid", paper.sourcePaperId],
      ["citationcount", paper.citationCount]
    ];
    const renderedFields = fields
      .filter((field): field is [string, string | number] => field[1] !== undefined)
      .map(([name, value]) => `  ${name} = {${escapeBibtex(String(value))}}`)
      .join(",\n");
    return `@article{${key},\n${renderedFields}\n}`;
  });
  return ensureFinalNewline(entries.join("\n\n"));
}

function renderSummary(
  input: ReviewExportInput,
  papers: readonly Paper[],
  fields: readonly ExtractionField[],
  values: ReadonlyMap<string, ExtractionValue>,
  paperById: ReadonlyMap<string, Paper>
): string {
  const { protocol, revision, flowSummary } = input;
  const lines: string[] = [
    "# Evidence Review Summary",
    "",
    "> This is an auditable Paper Pilot review-flow summary. It is not a PRISMA 2020-compliant report, diagram, or certification.",
    "",
    "This file reports the supplied protocol and recorded workflow state. It does not contain AI-generated conclusions.",
    "",
    "## Protocol",
    "",
    `- Review ID: ${markdownInline(protocol.id)}`,
    `- Project ID: ${markdownInline(protocol.projectId)}`,
    `- Template: ${markdownInline(protocol.template)}`,
    `- Current revision: ${revision.version}`,
    `- Protocol revisions retained: ${input.revisions.length}`,
    `- Activated: ${markdownInline(protocol.activatedAt)}`,
    `- Review state as of: ${markdownInline(flowSummary.generatedAt)}`,
    "",
    "### Research question",
    "",
    revision.researchQuestion || "_Not specified._",
    "",
    "### Objectives",
    ""
  ];
  if (revision.objectives.length) lines.push(...revision.objectives.map((objective) => `- ${objective}`));
  else lines.push("_None specified._");

  lines.push("", "### Eligibility criteria", "");
  const criteria = [...revision.criteria].sort(
    (left, right) =>
      screeningStageOrder(left.stage) - screeningStageOrder(right.stage) ||
      left.order - right.order ||
      compareText(left.id, right.id)
  );
  if (criteria.length) {
    lines.push("| Stage | Type | Criterion | Description |", "| --- | --- | --- | --- |");
    for (const criterion of criteria) {
      lines.push(
        `| ${markdownTable(criterion.stage)} | ${markdownTable(criterion.type)} | ${markdownTable(criterion.label)} | ${markdownTable(criterion.description ?? "")} |`
      );
    }
  } else lines.push("_No criteria configured._");

  lines.push(
    "",
    "## Recorded review flow",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Identified records | ${flowSummary.identifiedRecords} |`,
    `| Filtered records | ${flowSummary.filteredRecords} |`,
    `| Invalid records | ${flowSummary.invalidRecords} |`,
    `| Duplicate records | ${flowSummary.duplicateRecords} |`,
    `| Merged records | ${flowSummary.mergedRecords} |`,
    `| New records | ${flowSummary.newRecords} |`,
    `| Unique records screened | ${flowSummary.uniqueRecordsScreened} |`,
    `| Title/abstract exclusions | ${flowSummary.titleAbstractExclusions} |`,
    `| Full texts sought | ${flowSummary.fullTextsSought} |`,
    `| Full texts unavailable | ${flowSummary.fullTextsUnavailable} |`,
    `| Included papers | ${flowSummary.includedPapers} |`,
    ""
  );
  if (!flowSummary.historicalCountsAvailable) {
    lines.push(
      "Historical discovery and duplicate counts were unavailable for papers that predated review activation.",
      ""
    );
  }

  lines.push("### Full-text exclusions by reason", "");
  const exclusionReasons = Object.entries(flowSummary.fullTextExclusionsByReason).sort(([left], [right]) =>
    compareText(left, right)
  );
  if (exclusionReasons.length) {
    lines.push("| Reason | Count |", "| --- | ---: |");
    for (const [reason, count] of exclusionReasons) {
      lines.push(`| ${markdownTable(reason)} | ${count} |`);
    }
  } else lines.push("_No full-text exclusions recorded._");

  lines.push(
    "",
    "## Extraction status",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Configured active fields | ${fields.length} |`,
    `| Included papers supplied | ${papers.length} |`,
    `| Total cells | ${flowSummary.extraction.totalCells} |`,
    `| Confirmed cells | ${flowSummary.extraction.confirmedCells} |`,
    `| Not found cells | ${flowSummary.extraction.notFoundCells} |`,
    `| Needs review cells | ${flowSummary.extraction.needsReviewCells} |`,
    `| Completion | ${formatNumber(flowSummary.extraction.completionPercent)}% |`,
    `| Confirmed values exported | ${values.size} |`,
    `| Included paper records recovered from live data or snapshots | ${papers.length} |`,
    "",
    "## Discovery batches",
    ""
  );
  const batches = [...input.batches].sort(compareBatches);
  if (batches.length) {
    lines.push(
      "| Label | Kind | Status | Identified | Filtered | Invalid | Duplicates | Merged | New | Historical counts |",
      "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
    );
    for (const batch of batches) {
      lines.push(
        `| ${markdownTable(batch.label)} | ${markdownTable(batch.kind)} | ${markdownTable(batch.status)} | ${batch.counts.identified} | ${batch.counts.filtered} | ${batch.counts.invalid} | ${batch.counts.duplicates} | ${batch.counts.merged} | ${batch.counts.newRecords} | ${batch.historicalCountsAvailable ? "available" : "unavailable"} |`
      );
    }
  } else lines.push("_No discovery batches recorded._");

  lines.push(
    "",
    "The audit JSON retains every discovery candidate occurrence and its immutable record/paper snapshots.",
    "",
    `- Candidate origins retained: ${input.candidateOrigins.length}`,
    `- Distinct paper records represented by live data or snapshots: ${paperById.size}`
  );

  lines.push("", "## AI assistance runs", "");
  const runs = [...input.runs].sort(compareRuns);
  if (runs.length) {
    lines.push(
      "AI assistance was advisory; its outputs required human confirmation before inclusion in the evidence matrix.",
      "",
      "| Stage | Provider | Model | Status | Papers | Completed | Failed | Cancelled |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |"
    );
    for (const run of runs) {
      lines.push(
        `| ${markdownTable(run.stage)} | ${markdownTable(run.provider)} | ${markdownTable(run.model)} | ${markdownTable(run.status)} | ${run.paperIds.length} | ${run.completedCount} | ${run.failedCount} | ${run.cancelledCount} |`
      );
    }
  } else lines.push("_No AI assistance runs recorded._");

  lines.push("", `Run items retained in the audit JSON: ${input.runItems.length}.`);

  if (flowSummary.warnings.length) {
    lines.push("", "## Warnings", "", ...[...flowSummary.warnings].sort(compareText).map((warning) => `- ${warning}`));
  }
  return ensureFinalNewline(lines.join("\n"));
}

function renderFlowSvg(summary: ReviewFlowSummary): string {
  const fullTextExclusions = Object.values(summary.fullTextExclusionsByReason).reduce((sum, count) => sum + count, 0);
  const historicalNote = summary.historicalCountsAvailable
    ? "Historical discovery counts are available."
    : "Historical discovery and duplicate counts are incomplete for pre-existing papers.";
  const boxes = [
    { x: 320, y: 90, label: "Records identified", count: summary.identifiedRecords },
    { x: 320, y: 210, label: "Unique records screened", count: summary.uniqueRecordsScreened },
    { x: 320, y: 330, label: "Full texts sought", count: summary.fullTextsSought },
    { x: 320, y: 450, label: "Included papers", count: summary.includedPapers },
    {
      x: 30,
      y: 90,
      label: "Filtered / invalid / duplicate",
      count: summary.filteredRecords + summary.invalidRecords + summary.duplicateRecords
    },
    { x: 650, y: 210, label: "Title/abstract exclusions", count: summary.titleAbstractExclusions },
    { x: 30, y: 330, label: "Full texts unavailable", count: summary.fullTextsUnavailable },
    { x: 650, y: 330, label: "Full-text exclusions", count: fullTextExclusions }
  ];
  const boxMarkup = boxes
    .map(
      (box) => `  <g transform="translate(${box.x} ${box.y})">
    <rect width="280" height="76" rx="10" fill="#ffffff" stroke="#334155" stroke-width="2" />
    <text x="140" y="30" text-anchor="middle" font-size="15" fill="#0f172a">${escapeXml(box.label)}</text>
    <text x="140" y="57" text-anchor="middle" font-size="22" font-weight="700" fill="#0f172a">${box.count}</text>
  </g>`
    )
    .join("\n");

  return ensureFinalNewline(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="610" viewBox="0 0 960 610" role="img" aria-labelledby="review-flow-title review-flow-desc">
  <title id="review-flow-title">Review flow</title>
  <desc id="review-flow-desc">An auditable review-flow diagram, not a PRISMA 2020 diagram. ${escapeXml(historicalNote)} ${summary.identifiedRecords} records identified, ${summary.uniqueRecordsScreened} screened, and ${summary.includedPapers} included.</desc>
  <rect width="960" height="610" fill="#f8fafc" />
  <text x="480" y="35" text-anchor="middle" font-family="system-ui, sans-serif" font-size="24" font-weight="700" fill="#0f172a">Review flow</text>
  <text x="480" y="60" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#475569">Not a PRISMA 2020-compliant diagram or certification</text>
  <g stroke="#64748b" stroke-width="2" fill="none" aria-hidden="true">
    <path d="M460 166 V210" />
    <path d="M460 286 V330" />
    <path d="M460 406 V450" />
    <path d="M320 128 H310" />
    <path d="M600 248 H650" />
    <path d="M320 368 H310" />
    <path d="M600 368 H650" />
  </g>
  <g font-family="system-ui, sans-serif">
${boxMarkup}
  </g>
  <text x="480" y="565" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#334155">Extraction completion: ${formatNumber(summary.extraction.completionPercent)}% (${summary.extraction.confirmedCells} confirmed of ${summary.extraction.totalCells} cells)</text>
  <text x="480" y="590" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#64748b">Review state as of ${escapeXml(summary.generatedAt)}</text>
</svg>`);
}

function renderAuditJson(
  input: ReviewExportInput,
  includedPapers: readonly Paper[],
  paperById: ReadonlyMap<string, Paper>
): string {
  const audit = {
    schemaVersion: 2,
    exportKind: "paper-pilot-review-audit",
    notice: "Audit data and recorded workflow state; this renderer does not generate an AI-authored conclusion.",
    stateAsOf: input.flowSummary.generatedAt,
    protocol: input.protocol,
    currentRevision: sortedRevision(input.revision),
    protocolHistory: [...input.revisions]
      .sort((left, right) => left.version - right.version || compareText(left.id, right.id))
      .map(sortedRevision),
    batches: [...input.batches].sort(compareBatches),
    candidateOrigins: [...input.candidateOrigins].sort(compareCandidateOrigins),
    screeningDecisions: [...input.screeningDecisions].sort(compareDecisions),
    includedPaperIds: [...input.includedPaperIds].sort(compareText),
    includedPapers: sortPapers(includedPapers),
    paperSnapshots: sortPapers([...paperById.values()]),
    extractionFields: sortFields(input.extractionFields),
    extractionFieldHistory: [...input.extractionFieldHistory].sort(compareExtractionFieldHistory),
    extractionValues: [...input.extractionValues].sort(compareExtractionValues),
    extractionValueHistory: [...input.extractionValueHistory].sort(compareExtractionValueHistory),
    evidence: [...input.evidence].sort(compareEvidence),
    runs: [...input.runs].sort(compareRuns),
    runItems: [...input.runItems].sort(compareRunItems),
    auditEvents: [...input.auditEvents].sort(compareAuditEvents),
    flowSummary: input.flowSummary
  };
  return `${stableJsonStringify(audit, 2)}\n`;
}

function sortedRevision(revision: ReviewProtocolRevision): ReviewProtocolRevision {
  return {
    ...revision,
    criteria: [...revision.criteria].sort(
      (left, right) =>
        screeningStageOrder(left.stage) - screeningStageOrder(right.stage) ||
        left.order - right.order ||
        compareText(left.id, right.id)
    )
  };
}

type CsvCell = string | number | boolean | null | undefined;

function renderCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const allRows = [headers, ...rows];
  return ensureFinalNewline(
    allRows
      .map((row) =>
        row
          .map((cell) => {
            if (cell === null || cell === undefined) return "";
            return escapeCsv(typeof cell === "string" ? neutralizeSpreadsheetFormula(cell) : String(cell));
          })
          .join(",")
      )
      .join("\n")
  );
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function neutralizeSpreadsheetFormula(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function collectPaperSnapshots(input: ReviewExportInput): Map<string, Paper> {
  const papers = new Map<string, Paper>();
  const add = (value: unknown): void => {
    const parsed = paperSchema.safeParse(value);
    if (parsed.success && !papers.has(parsed.data.id)) papers.set(parsed.data.id, parsed.data);
  };

  // Prefer current records, then fall back to immutable review snapshots for deleted records.
  input.includedPapers.forEach(add);
  input.screeningDecisions.forEach((decision) => add(decision.paperSnapshot));
  input.candidateOrigins.forEach((origin) => {
    add(origin.paperSnapshot);
    add(origin.recordSnapshot);
  });
  input.extractionValues.forEach((value) => add(value.paperSnapshot));
  input.extractionValueHistory.forEach((value) => add(value.paperSnapshot));
  input.evidence.forEach((evidence) => add(evidence.paperSnapshot));
  input.runItems.forEach((item) => add(item.paperSnapshot));
  return papers;
}

function currentConfirmedValues(
  values: readonly ExtractionValue[],
  fields: readonly ExtractionField[],
  includedPaperIds: ReadonlySet<string>
): Map<string, ExtractionValue> {
  const fieldRevision = new Map(fields.map((field) => [field.id, field.revision]));
  const result = new Map<string, ExtractionValue>();
  for (const value of [...values].sort(compareExtractionValues)) {
    if (
      !includedPaperIds.has(value.paperId) ||
      value.status !== "confirmed" ||
      fieldRevision.get(value.fieldId) !== value.fieldRevision
    ) {
      continue;
    }
    const key = valueKey(value.paperId, value.fieldId);
    const previous = result.get(key);
    if (!previous || compareCurrentValue(previous, value) < 0) result.set(key, value);
  }
  return result;
}

function renderExtractionValue(value: ExtractionPrimitiveValue): CsvCell {
  if (value === null) return "";
  if (Array.isArray(value)) return value.join("; ");
  return value;
}

function uniqueFieldHeaders(fields: readonly ExtractionField[]): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  return fields.map((field) => ((counts.get(field.name) ?? 0) > 1 ? `${field.name} [${field.id}]` : field.name));
}

function bibtexBaseKey(paper: Paper): string {
  const author = paper.authors[0] ?? "paper";
  const family = author.includes(",") ? author.split(",", 1)[0] : (author.trim().split(/\s+/).at(-1) ?? "paper");
  const familySlug = asciiSlug(family) || "paper";
  const titleWord = paper.title
    .split(/\s+/)
    .map(asciiSlug)
    .find((word) => word && !["a", "an", "the"].includes(word));
  return `${familySlug}${paper.year ?? "nd"}${titleWord || "study"}`;
}

function escapeBibtex(value: string): string {
  return value
    .replace(/[\\{}%&_#$]/g, (character) => (character === "\\" ? "\\textbackslash{}" : `\\${character}`))
    .replace(/\s+/g, " ")
    .trim();
}

function risText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownInline(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ").replace(/`/g, "\\`");
}

function markdownTable(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function asciiSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function sortPapers(papers: readonly Paper[]): Paper[] {
  return [...papers].sort(
    (left, right) =>
      compareText(left.title.toLowerCase(), right.title.toLowerCase()) ||
      compareOptionalNumber(left.year, right.year) ||
      compareText(left.id, right.id)
  );
}

function sortFields(fields: readonly ExtractionField[]): ExtractionField[] {
  return [...fields].sort(
    (left, right) => left.order - right.order || compareText(left.name, right.name) || compareText(left.id, right.id)
  );
}

function compareDecisions(left: ScreeningDecision, right: ScreeningDecision): number {
  return (
    compareText(left.paperId, right.paperId) ||
    screeningStageOrder(left.stage) - screeningStageOrder(right.stage) ||
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.id, right.id)
  );
}

function compareBatches(left: DiscoveryBatch, right: DiscoveryBatch): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function compareCandidateOrigins(left: ReviewCandidateOrigin, right: ReviewCandidateOrigin): number {
  return (
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.batchId, right.batchId) ||
    compareText(left.id, right.id)
  );
}

function compareExtractionValues(left: ExtractionValue, right: ExtractionValue): number {
  return (
    compareText(left.paperId, right.paperId) ||
    compareText(left.fieldId, right.fieldId) ||
    left.fieldRevision - right.fieldRevision ||
    compareText(left.updatedAt, right.updatedAt) ||
    compareText(left.id, right.id)
  );
}

function compareExtractionFieldHistory(left: ExtractionFieldHistoryEntry, right: ExtractionFieldHistoryEntry): number {
  return (
    compareText(left.id, right.id) || left.revision - right.revision || compareText(left.recordedAt, right.recordedAt)
  );
}

function compareExtractionValueHistory(left: ExtractionValueHistoryEntry, right: ExtractionValueHistoryEntry): number {
  return (
    compareText(left.id, right.id) ||
    left.changeRevision - right.changeRevision ||
    compareText(left.recordedAt, right.recordedAt)
  );
}

function compareCurrentValue(left: ExtractionValue, right: ExtractionValue): number {
  return (
    left.fieldRevision - right.fieldRevision ||
    compareText(left.updatedAt, right.updatedAt) ||
    compareText(left.id, right.id)
  );
}

function compareEvidence(left: ReviewEvidence, right: ReviewEvidence): number {
  return (
    compareText(left.paperId ?? "", right.paperId ?? "") ||
    compareText(left.evidenceId, right.evidenceId) ||
    compareText(left.id, right.id)
  );
}

function compareRuns(left: ReviewRun, right: ReviewRun): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function compareRunItems(left: PortableReviewRunItem, right: PortableReviewRunItem): number {
  return (
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.runId, right.runId) ||
    compareText(left.paperId, right.paperId) ||
    compareText(left.id, right.id)
  );
}

function compareAuditEvents(left: ReviewAuditEvent, right: ReviewAuditEvent): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function screeningStageOrder(stage: ScreeningDecision["stage"]): number {
  return stage === "title-abstract" ? 0 : 1;
}

function valueKey(paperId: string, fieldId: string): string {
  return `${paperId}\u0000${fieldId}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function ensureFinalNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function stableJsonStringify(value: unknown, space: number): string {
  return JSON.stringify(sortJsonValue(value), null, space);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, sortJsonValue(nested)])
    );
  }
  return value;
}
