import { describe, expect, it } from "vitest";
import type {
  DiscoveryBatch,
  ExtractionField,
  Paper,
  ReviewAuditEvent,
  ReviewEvidence,
  ReviewFlowSummary,
  ReviewProtocol,
  ReviewProtocolRevision,
  ReviewRun
} from "../src/shared/schemas";
import type {
  PortableExtractionValue,
  PortableReviewRunItem,
  PortableScreeningDecision,
  ReviewCandidateOrigin
} from "../src/main/db";
import {
  renderReviewExportPackage,
  REVIEW_EXPORT_FILE_NAMES,
  type ReviewExportInput
} from "../src/main/services/review-export-service";

describe("renderReviewExportPackage", () => {
  it("renders the complete deterministic package", () => {
    const input = exportFixture();
    const first = renderReviewExportPackage(input);
    const reordered = renderReviewExportPackage({
      ...input,
      revisions: [...input.revisions].reverse(),
      batches: [...input.batches].reverse(),
      candidateOrigins: [...input.candidateOrigins].reverse(),
      screeningDecisions: [...input.screeningDecisions].reverse(),
      includedPapers: [...input.includedPapers].reverse(),
      extractionFields: [...input.extractionFields].reverse(),
      extractionFieldHistory: [...input.extractionFieldHistory].reverse(),
      extractionValues: [...input.extractionValues].reverse(),
      extractionValueHistory: [...input.extractionValueHistory].reverse(),
      evidence: [...input.evidence].reverse(),
      runs: [...input.runs].reverse(),
      runItems: [...input.runItems].reverse(),
      auditEvents: [...input.auditEvents].reverse()
    });

    expect([...first.keys()]).toEqual(REVIEW_EXPORT_FILE_NAMES);
    expect(Object.fromEntries(reordered)).toEqual(Object.fromEntries(first));
    for (const content of first.values()) expect(content.endsWith("\n")).toBe(true);
  });

  it("exports only current confirmed extraction values with correct CSV escaping", () => {
    const files = renderReviewExportPackage(exportFixture());
    const matrix = files.get("evidence-matrix.csv")!;

    expect(matrix.split("\n", 1)[0]).toBe('paper_id,title,authors,year,doi,Study notes,"Effect, estimate"');
    expect(matrix.indexOf("paper-alpha")).toBeLessThan(matrix.indexOf("paper-beta"));
    expect(matrix).toContain('"Alpha & ""Trial"""');
    expect(matrix).toContain('"Doe, Jane; Roe, John"');
    expect(matrix).toContain('"Line one,\n""quoted"""');
    expect(matrix).toContain(",1.25\n");
    expect(matrix).not.toContain("obsolete value");
    expect(matrix).not.toContain("inactive value");
    expect(matrix).not.toContain("excluded paper value");
  });

  it("neutralizes spreadsheet formulas in untrusted text cells without changing numeric values", () => {
    const input = exportFixture();
    const includedPapers = input.includedPapers.map((paper) =>
      paper.id === "paper-alpha" ? { ...paper, title: '  =HYPERLINK("https://evil.test")' } : paper
    );
    const extractionValues = input.extractionValues.map((value) =>
      value.id === "value-notes" ? { ...value, value: "+SUM(1,1)" } : value
    );
    const matrix = renderReviewExportPackage({ ...input, includedPapers, extractionValues }).get(
      "evidence-matrix.csv"
    )!;

    expect(matrix).toContain("'  =HYPERLINK");
    expect(matrix).toContain('"\'+SUM(1,1)"');
    expect(matrix).toContain(",1.25\n");
  });

  it("links exported evidence to its confirmed value and preserves locators", () => {
    const locators = renderReviewExportPackage(exportFixture()).get("evidence-locators.csv")!;

    expect(locators).toContain("value-effect");
    expect(locators).toContain("ev-db");
    expect(locators).toContain("S1");
    expect(locators).toContain("artifact-chunk");
    expect(locators).toContain('"Evidence, line one\n""line two"""');
    expect(locators).toContain(",7,Methods section,");
    expect(locators).toContain("Unreferenced evidence");
  });

  it("renders current screening decisions and human-readable exclusion reasons", () => {
    const decisions = renderReviewExportPackage(exportFixture()).get("screening-decisions.csv")!;

    expect(decisions.indexOf("decision-ta")).toBeLessThan(decisions.indexOf("decision-ft"));
    expect(decisions).toContain("Wrong population");
    expect(decisions).toContain('"Not eligible, because ""wrong population"".\nVerified manually."');
    expect(decisions).toContain("revision-2");
  });

  it("renders deterministic RIS and BibTeX reference round-trip files", () => {
    const files = renderReviewExportPackage(exportFixture());
    const ris = files.get("included-references.ris")!;
    const bib = files.get("included-references.bib")!;

    expect(ris.indexOf("TI  - Alpha")).toBeLessThan(ris.indexOf("TI  - Beta"));
    expect(ris).toContain("AU  - Doe, Jane\nAU  - Roe, John");
    expect(ris).toContain("AB  - First line second line");
    expect(ris).toContain("DO  - 10.1/alpha");
    expect(ris).toContain("ER  -\n");

    expect(bib.indexOf("@article{doe2020alpha")).toBeLessThan(bib.indexOf("@article{alpha2021beta"));
    expect(bib).toContain('title = {Alpha \\& "Trial"}');
    expect(bib).toContain("author = {Doe, Jane and Roe, John}");
    expect(bib).toContain("source = {reference-import}");
  });

  it("produces a factual summary and accessible explicitly non-PRISMA flow", () => {
    const files = renderReviewExportPackage(exportFixture());
    const summary = files.get("review-summary.md")!;
    const svg = files.get("review-flow.svg")!;

    expect(summary).toContain("not a PRISMA 2020-compliant report, diagram, or certification");
    expect(summary).toContain("does not contain AI-generated conclusions");
    expect(summary).toContain("Historical discovery and duplicate counts were unavailable");
    expect(summary).toContain("| Wrong population | 1 |");
    expect(summary).toContain("| Included papers | 2 |");
    expect(summary).toContain("AI assistance was advisory");
    expect(summary).not.toContain("Supports the effect estimate");

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="review-flow-title review-flow-desc"');
    expect(svg).toContain('<title id="review-flow-title">Review flow</title>');
    expect(svg).toContain("not a PRISMA 2020 diagram");
    expect(svg).toContain("Included papers");
    expect(svg).toContain(">2</text>");
  });

  it("includes sorted protocol, provenance, run metadata, and audit history in JSON", () => {
    const json = renderReviewExportPackage(exportFixture()).get("review-audit.json")!;
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      exportKind: string;
      includedPapers: Paper[];
      batches: DiscoveryBatch[];
      auditEvents: ReviewAuditEvent[];
      flowSummary: ReviewFlowSummary;
      protocolHistory: ReviewProtocolRevision[];
      candidateOrigins: ReviewCandidateOrigin[];
      runItems: PortableReviewRunItem[];
      paperSnapshots: Paper[];
    };

    expect(parsed).toMatchObject({
      schemaVersion: 2,
      exportKind: "paper-pilot-review-audit",
      flowSummary: { reviewId: "review-1", includedPapers: 2 }
    });
    expect(parsed.includedPapers.map((paper) => paper.id)).toEqual(["paper-alpha", "paper-beta"]);
    expect(parsed.batches.map((batch) => batch.id)).toEqual(["batch-old", "batch-import"]);
    expect(parsed.auditEvents.map((event) => event.id)).toEqual(["audit-old", "audit-new"]);
    expect(parsed.protocolHistory.map((revision) => revision.id)).toEqual(["revision-1", "revision-2"]);
    expect(parsed.candidateOrigins[0]).toMatchObject({ sourceRecordId: "RIS-1", resolution: "duplicate" });
    expect(parsed.runItems[0]).toMatchObject({ id: "run-item-1", evidenceIds: ["ev-db"] });
    expect(parsed.paperSnapshots.some((paper) => paper.id === "paper-z-excluded")).toBe(true);
    expect(json.indexOf('"a": 1')).toBeLessThan(json.indexOf('"z": 2'));
  });

  it("recovers deleted included references and excluded titles from immutable snapshots", () => {
    const input = exportFixture();
    const deleted = paperSnapshot("paper-deleted", "Deleted but included trial");
    deleted.authors = ["Snapshot, Dana"];
    deleted.year = 2019;
    deleted.doi = "10.1/deleted";
    const files = renderReviewExportPackage({
      ...input,
      includedPaperIds: [...input.includedPaperIds, deleted.id],
      screeningDecisions: [
        ...input.screeningDecisions,
        {
          id: "decision-deleted",
          reviewId: "review-1",
          paperId: deleted.id,
          paperSnapshot: deleted,
          stage: "full-text",
          decision: "include",
          protocolRevisionId: "revision-2",
          createdAt: "2026-08-24T00:00:00.000Z"
        }
      ]
    });

    expect(files.get("included-references.ris")).toContain("TI  - Deleted but included trial");
    expect(files.get("included-references.bib")).toContain("doi = {10.1/deleted}");
    expect(files.get("screening-decisions.csv")).toContain("Excluded population study");
  });
});

function exportFixture(): ReviewExportInput {
  const protocol: ReviewProtocol = {
    id: "review-1",
    projectId: "project-1",
    template: "general-empirical",
    currentRevisionId: "revision-2",
    currentRevisionNumber: 2,
    historicalCountsAvailable: false,
    activatedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z"
  };
  const revision: ReviewProtocolRevision = {
    id: "revision-2",
    reviewId: "review-1",
    version: 2,
    researchQuestion: "What is the effect?",
    objectives: ["Estimate the effect", "Record study characteristics"],
    criteria: [
      {
        id: "criterion-population",
        stage: "full-text",
        type: "exclusion",
        label: "Wrong population",
        description: "The population is outside scope.",
        order: 1
      },
      {
        id: "criterion-empirical",
        stage: "title-abstract",
        type: "inclusion",
        label: "Empirical study",
        order: 0
      }
    ],
    changeNote: "Clarified the population.",
    createdAt: "2026-08-20T00:00:00.000Z"
  };
  const firstRevision: ReviewProtocolRevision = {
    id: "revision-1",
    reviewId: "review-1",
    version: 1,
    researchQuestion: "What was studied?",
    objectives: ["Describe the studies"],
    criteria: [],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
  const batches: DiscoveryBatch[] = [
    {
      id: "batch-import",
      reviewId: "review-1",
      kind: "reference-import",
      label: "Imported, library",
      fileName: "library.csv",
      importFormat: "csv",
      status: "completed",
      counts: { identified: 4, filtered: 0, invalid: 1, duplicates: 1, merged: 0, newRecords: 2 },
      historicalCountsAvailable: true,
      createdAt: "2026-08-03T00:00:00.000Z",
      completedAt: "2026-08-03T00:01:00.000Z"
    },
    {
      id: "batch-old",
      reviewId: "review-1",
      kind: "pre-existing",
      label: "Pre-existing project papers",
      status: "completed",
      counts: { identified: 2, filtered: 0, invalid: 0, duplicates: 0, merged: 0, newRecords: 0 },
      historicalCountsAvailable: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:00.000Z"
    }
  ];
  const screeningDecisions: PortableScreeningDecision[] = [
    {
      id: "decision-z",
      reviewId: "review-1",
      paperId: "paper-z-excluded",
      paperSnapshot: paperSnapshot("paper-z-excluded", "Excluded population study"),
      stage: "full-text",
      decision: "exclude",
      protocolRevisionId: "revision-2",
      reasonCriterionId: "criterion-population",
      customReason: 'Not eligible, because "wrong population".\nVerified manually.',
      createdAt: "2026-08-23T00:00:00.000Z"
    },
    {
      id: "decision-ft",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      stage: "full-text",
      decision: "include",
      protocolRevisionId: "revision-2",
      createdAt: "2026-08-22T00:00:00.000Z"
    },
    {
      id: "decision-ta",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      stage: "title-abstract",
      decision: "include",
      protocolRevisionId: "revision-2",
      createdAt: "2026-08-21T00:00:00.000Z"
    }
  ];
  const includedPapers: Paper[] = [
    {
      id: "paper-beta",
      projectId: "project-1",
      title: "Beta, Study",
      authors: ["Team Alpha"],
      year: 2021,
      source: "reference-import",
      sourcePaperId: "beta-key",
      isOpenAccess: false,
      fieldsOfStudy: []
    },
    {
      id: "paper-alpha",
      projectId: "project-1",
      title: 'Alpha & "Trial"',
      abstract: "First line\nsecond line",
      authors: ["Doe, Jane", "Roe, John"],
      year: 2020,
      doi: "10.1/alpha",
      url: "https://example.test/alpha",
      pdfUrl: "https://example.test/alpha.pdf",
      source: "arxiv",
      sourcePaperId: "2001.00001",
      venue: "Trials & Reviews",
      citationCount: 12,
      isOpenAccess: true,
      fieldsOfStudy: []
    }
  ];
  const extractionFields: ExtractionField[] = [
    {
      id: "field-effect",
      reviewId: "review-1",
      name: "Effect, estimate",
      type: "number",
      options: [],
      order: 1,
      revision: 2,
      active: true,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z"
    },
    {
      id: "field-inactive",
      reviewId: "review-1",
      name: "Retired field",
      type: "short-text",
      options: [],
      order: 2,
      revision: 1,
      active: false,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z"
    },
    {
      id: "field-notes",
      reviewId: "review-1",
      name: "Study notes",
      type: "long-text",
      options: [],
      order: 0,
      revision: 1,
      active: true,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z"
    }
  ];
  const extractionValues: PortableExtractionValue[] = [
    {
      id: "value-excluded-paper",
      reviewId: "review-1",
      paperId: "paper-z-excluded",
      paperSnapshot: paperSnapshot("paper-z-excluded", "Excluded population study"),
      fieldId: "field-notes",
      fieldRevision: 1,
      value: "excluded paper value",
      status: "confirmed",
      origin: "manual",
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      confirmedAt: "2026-08-22T00:00:00.000Z"
    },
    {
      id: "value-needs-review",
      reviewId: "review-1",
      paperId: "paper-beta",
      paperSnapshot: paperSnapshot("paper-beta", "Beta, Study"),
      fieldId: "field-effect",
      fieldRevision: 2,
      value: 2.5,
      status: "needs-review",
      origin: "ai",
      evidenceIds: ["ev-db"],
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z"
    },
    {
      id: "value-obsolete-revision",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      fieldId: "field-effect",
      fieldRevision: 1,
      value: "obsolete value",
      status: "confirmed",
      origin: "manual",
      evidenceIds: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      confirmedAt: "2026-08-12T00:00:00.000Z"
    },
    {
      id: "value-effect-old",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      fieldId: "field-effect",
      fieldRevision: 2,
      value: 0.5,
      status: "confirmed",
      origin: "ai",
      evidenceIds: ["ev-db"],
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
      confirmedAt: "2026-08-21T00:00:00.000Z"
    },
    {
      id: "value-effect",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      fieldId: "field-effect",
      fieldRevision: 2,
      value: 1.25,
      status: "confirmed",
      origin: "ai",
      evidenceIds: ["ev-db"],
      runItemId: "run-item-1",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      confirmedAt: "2026-08-22T00:00:00.000Z"
    },
    {
      id: "value-notes",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      fieldId: "field-notes",
      fieldRevision: 1,
      value: 'Line one,\n"quoted"',
      status: "confirmed",
      origin: "manual",
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      confirmedAt: "2026-08-22T00:00:00.000Z"
    },
    {
      id: "value-inactive",
      reviewId: "review-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      fieldId: "field-inactive",
      fieldRevision: 1,
      value: "inactive value",
      status: "confirmed",
      origin: "manual",
      evidenceIds: [],
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      confirmedAt: "2026-08-22T00:00:00.000Z"
    }
  ];
  const evidence: ReviewEvidence[] = [
    {
      id: "ev-unused",
      reviewId: "review-1",
      evidenceId: "S2",
      paperId: "paper-beta",
      sourceType: "paper-abstract",
      title: "Unreferenced evidence",
      excerpt: "Not used by a confirmed value.",
      createdAt: "2026-08-22T00:00:00.000Z"
    },
    {
      id: "ev-db",
      reviewId: "review-1",
      evidenceId: "S1",
      runId: "run-1",
      runItemId: "run-item-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      artifactId: "artifact-1",
      chunkId: "chunk-7",
      sourceType: "artifact-chunk",
      title: "Alpha evidence",
      excerpt: 'Evidence, line one\n"line two"',
      locator: "Methods section",
      page: 7,
      doi: "10.1/alpha",
      url: "https://example.test/alpha#page=7",
      retrievalScore: 0.91,
      createdAt: "2026-08-22T00:00:00.000Z"
    }
  ];
  const runs: ReviewRun[] = [
    {
      id: "run-1",
      reviewId: "review-1",
      stage: "extraction",
      provider: "ollama",
      model: "qwen3:8b",
      protocolRevisionId: "revision-2",
      status: "completed",
      paperIds: ["paper-alpha"],
      fieldIds: ["field-effect"],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:01:00.000Z"
    }
  ];
  const runItems: PortableReviewRunItem[] = [
    {
      id: "run-item-1",
      runId: "run-1",
      paperId: "paper-alpha",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      status: "completed",
      attemptCount: 1,
      rationale: "The reported value was extracted from S1.",
      criterionAssessments: [],
      extractionSuggestions: [
        {
          fieldId: "field-effect",
          value: 1.25,
          status: "suggested",
          evidenceIds: ["S1"]
        }
      ],
      evidenceIds: ["ev-db"],
      stale: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:01:00.000Z",
      startedAt: "2026-08-22T00:00:00.000Z",
      completedAt: "2026-08-22T00:01:00.000Z"
    }
  ];
  const candidateOrigins: ReviewCandidateOrigin[] = [
    {
      id: "origin-1",
      reviewId: "review-1",
      batchId: "batch-import",
      paperId: "paper-alpha",
      matchedPaperId: "paper-alpha",
      sourceRecordId: "RIS-1",
      resolution: "duplicate",
      paperSnapshot: paperSnapshot("paper-alpha", 'Alpha & "Trial"'),
      recordSnapshot: { title: 'Alpha & "Trial"', doi: "10.1/alpha" },
      createdAt: "2026-08-03T00:00:30.000Z"
    }
  ];
  const auditEvents: ReviewAuditEvent[] = [
    {
      id: "audit-new",
      reviewId: "review-1",
      kind: "extraction-value-confirmed",
      actor: "user",
      entityType: "extraction-value",
      entityId: "value-effect",
      payload: { z: 2, a: 1 },
      createdAt: "2026-08-22T00:02:00.000Z"
    },
    {
      id: "audit-old",
      reviewId: "review-1",
      kind: "review-activated",
      actor: "user",
      entityType: "review",
      entityId: "review-1",
      payload: {},
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  ];
  const flowSummary: ReviewFlowSummary = {
    reviewId: "review-1",
    identifiedRecords: 6,
    filteredRecords: 0,
    invalidRecords: 1,
    duplicateRecords: 1,
    mergedRecords: 0,
    newRecords: 2,
    uniqueRecordsScreened: 4,
    titleAbstractExclusions: 1,
    fullTextsSought: 3,
    fullTextsUnavailable: 0,
    fullTextExclusionsByReason: { "Wrong population": 1 },
    includedPapers: 2,
    extraction: {
      totalCells: 4,
      confirmedCells: 2,
      notFoundCells: 0,
      needsReviewCells: 1,
      completionPercent: 50
    },
    historicalCountsAvailable: false,
    warnings: ["Historical duplicate counts are unavailable."],
    generatedAt: "2026-08-23T12:00:00.000Z"
  };
  return {
    protocol,
    revision,
    revisions: [revision, firstRevision],
    batches,
    candidateOrigins,
    screeningDecisions,
    includedPapers,
    includedPaperIds: ["paper-alpha", "paper-beta"],
    extractionFields,
    extractionFieldHistory: extractionFields.map((field) => ({ ...field, recordedAt: field.updatedAt })),
    extractionValues,
    extractionValueHistory: extractionValues.map((value) => ({
      ...value,
      changeRevision: 1,
      recordedAt: value.updatedAt
    })),
    evidence,
    runs,
    runItems,
    auditEvents,
    flowSummary
  };
}

function paperSnapshot(id: string, title: string): Paper {
  return {
    id,
    projectId: "project-1",
    title,
    authors: [],
    source: "reference-import",
    isOpenAccess: false,
    fieldsOfStudy: []
  };
}
