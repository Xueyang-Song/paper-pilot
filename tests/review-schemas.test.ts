import { describe, expect, it } from "vitest";
import {
  MAX_REFERENCE_IMPORT_BYTES,
  MAX_REFERENCE_IMPORT_RECORDS,
  MAX_REVIEW_BATCH_PAPERS,
  activateReviewRequestSchema,
  crawlConfigSchema,
  extractionFieldSchema,
  extractionValueSchema,
  paperSchema,
  referenceImportPreviewSchema,
  reviewEvidenceSchema,
  reviewFlowSummarySchema,
  reviewPaperQuerySchema,
  reviewProtocolRevisionSchema,
  reviewRunEventSchema,
  saveExtractionValueRequestSchema,
  saveScreeningDecisionRequestSchema,
  sourceIdSchema,
  startReviewRunRequestSchema
} from "../src/shared/schemas";

const timestamp = "2026-08-22T12:00:00.000Z";

describe("review-domain schemas", () => {
  it("keeps reference imports as paper provenance rather than crawler sources", () => {
    expect(
      paperSchema.parse({
        id: "paper-1",
        title: "Imported trial",
        source: "reference-import"
      }).source
    ).toBe("reference-import");

    expect(sourceIdSchema.safeParse("reference-import").success).toBe(false);
    expect(crawlConfigSchema.safeParse({ topic: "trials", sourceIds: ["reference-import"] }).success).toBe(false);
  });

  it("validates a versioned protocol revision", () => {
    const revision = reviewProtocolRevisionSchema.parse({
      id: "revision-2",
      reviewId: "review-1",
      version: 2,
      researchQuestion: "Does the intervention improve recovery?",
      objectives: ["Measure recovery time"],
      criteria: [
        {
          id: "criterion-1",
          stage: "full-text",
          type: "exclusion",
          label: "Wrong population",
          order: 0
        }
      ],
      createdAt: timestamp
    });

    expect(revision.version).toBe(2);
    expect(revision.criteria[0]?.stage).toBe("full-text");
  });

  it("requires a reason for full-text exclusions only", () => {
    const common = {
      reviewId: "review-1",
      paperId: "paper-1",
      protocolRevisionId: "revision-1",
      decision: "exclude" as const
    };

    expect(saveScreeningDecisionRequestSchema.safeParse({ ...common, stage: "full-text" }).success).toBe(false);
    expect(
      saveScreeningDecisionRequestSchema.safeParse({
        ...common,
        stage: "full-text",
        customReason: "The full text reports the wrong population"
      }).success
    ).toBe(true);
    expect(saveScreeningDecisionRequestSchema.safeParse({ ...common, stage: "title-abstract" }).success).toBe(true);
  });

  it("enforces extraction-field option rules", () => {
    const base = {
      id: "field-1",
      reviewId: "review-1",
      name: "Study design",
      order: 0,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    expect(extractionFieldSchema.safeParse({ ...base, type: "single-select" }).success).toBe(false);
    expect(
      extractionFieldSchema.safeParse({
        ...base,
        type: "single-select",
        options: ["RCT", "Cohort"]
      }).success
    ).toBe(true);
    expect(extractionFieldSchema.safeParse({ ...base, type: "number", options: ["not applicable"] }).success).toBe(
      false
    );
  });

  it("requires evidence before confirming an AI-derived value", () => {
    const base = {
      id: "value-1",
      reviewId: "review-1",
      paperId: "paper-1",
      fieldId: "field-1",
      fieldRevision: 1,
      value: "Randomized controlled trial",
      status: "confirmed" as const,
      origin: "ai" as const,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    expect(extractionValueSchema.safeParse(base).success).toBe(false);
    expect(extractionValueSchema.safeParse({ ...base, evidenceIds: ["evidence-1"] }).success).toBe(true);
    expect(extractionValueSchema.safeParse({ ...base, origin: "manual" }).success).toBe(true);
  });

  it("requires an explicit not-found state instead of confirming blank extraction values", () => {
    const base = {
      reviewId: "review-1",
      paperId: "paper-1",
      fieldId: "field-1",
      expectedFieldRevision: 1,
      status: "confirmed" as const,
      evidenceIds: []
    };

    for (const value of [null, "", "   ", []]) {
      expect(saveExtractionValueRequestSchema.safeParse({ ...base, value }).success).toBe(false);
    }
    expect(saveExtractionValueRequestSchema.safeParse({ ...base, value: null, status: "not-found" }).success).toBe(
      true
    );
    expect(saveExtractionValueRequestSchema.safeParse({ ...base, value: false }).success).toBe(true);
    expect(saveExtractionValueRequestSchema.safeParse({ ...base, value: 0 }).success).toBe(true);
  });

  it("preserves evidence snapshots after linked records disappear", () => {
    const evidence = reviewEvidenceSchema.parse({
      id: "evidence-row-1",
      reviewId: "review-1",
      evidenceId: "S1",
      sourceType: "artifact-chunk",
      title: "Archived paper title",
      excerpt: "The study randomized 120 participants.",
      locator: "Methods, paragraph 2",
      createdAt: timestamp
    });

    expect(evidence.paperId).toBeUndefined();
    expect(evidence.artifactId).toBeUndefined();
    expect(evidence.excerpt).toContain("120 participants");
  });

  it("bounds review batches and extraction fields at the API boundary", () => {
    expect(
      startReviewRunRequestSchema.safeParse({
        reviewId: "review-1",
        stage: "title-abstract",
        paperIds: Array.from({ length: MAX_REVIEW_BATCH_PAPERS }, (_, index) => `paper-${index}`)
      }).success
    ).toBe(true);
    expect(
      startReviewRunRequestSchema.safeParse({
        reviewId: "review-1",
        stage: "title-abstract",
        paperIds: Array.from({ length: MAX_REVIEW_BATCH_PAPERS + 1 }, (_, index) => `paper-${index}`)
      }).success
    ).toBe(false);
  });

  it("defaults persisted review runs to no selected extraction fields", () => {
    const event = reviewRunEventSchema.parse({
      type: "complete",
      runId: "run-1",
      reviewId: "review-1",
      run: {
        id: "run-1",
        reviewId: "review-1",
        stage: "title-abstract",
        provider: "ollama",
        model: "test-model",
        protocolRevisionId: "revision-1",
        status: "completed",
        paperIds: ["paper-1"],
        createdAt: timestamp,
        updatedAt: timestamp
      }
    });

    expect(event.type === "complete" ? event.run.fieldIds : undefined).toEqual([]);
  });

  it("applies stable queue defaults and rejects inverted year ranges", () => {
    const query = reviewPaperQuerySchema.parse({ reviewId: "review-1" });
    expect(query).toMatchObject({
      stage: "title-abstract",
      page: 1,
      pageSize: 25,
      fullText: "any",
      sort: "created",
      direction: "asc"
    });
    expect(reviewPaperQuerySchema.safeParse({ reviewId: "review-1", yearFrom: 2025, yearTo: 2020 }).success).toBe(
      false
    );
  });

  it("validates redacted, discriminated review run events", () => {
    const event = reviewRunEventSchema.parse({
      type: "progress",
      runId: "run-1",
      reviewId: "review-1",
      completed: 2,
      failed: 1,
      cancelled: 0,
      total: 10,
      currentPaperId: "paper-4"
    });

    expect(event.type).toBe("progress");
    expect("rawProviderPayload" in event).toBe(false);
  });

  it("validates deterministic flow-summary counts", () => {
    const summary = reviewFlowSummarySchema.parse({
      reviewId: "review-1",
      identifiedRecords: 100,
      filteredRecords: 5,
      invalidRecords: 2,
      duplicateRecords: 13,
      mergedRecords: 3,
      newRecords: 77,
      uniqueRecordsScreened: 80,
      titleAbstractExclusions: 40,
      fullTextsSought: 40,
      fullTextsUnavailable: 5,
      fullTextExclusionsByReason: { "Wrong population": 10 },
      includedPapers: 25,
      extraction: {
        totalCells: 100,
        confirmedCells: 75,
        notFoundCells: 5,
        needsReviewCells: 20,
        completionPercent: 80
      },
      historicalCountsAvailable: true,
      generatedAt: timestamp
    });

    expect(summary.includedPapers).toBe(25);
    expect(summary.extraction.completionPercent).toBe(80);
  });

  it("enforces import limits without accepting renderer file paths", () => {
    const preview = {
      previewId: "preview-1",
      projectId: "project-1",
      reviewId: "review-1",
      fileName: "references.ris",
      format: "ris" as const,
      sizeBytes: MAX_REFERENCE_IMPORT_BYTES,
      totalRecords: MAX_REFERENCE_IMPORT_RECORDS,
      validRecords: 1,
      invalidRecords: 0,
      items: []
    };
    expect(referenceImportPreviewSchema.safeParse(preview).success).toBe(true);
    expect(
      referenceImportPreviewSchema.safeParse({
        ...preview,
        sizeBytes: MAX_REFERENCE_IMPORT_BYTES + 1
      }).success
    ).toBe(false);
  });

  it("defaults new reviews to the blank template", () => {
    const request = activateReviewRequestSchema.parse({ projectId: "project-1" });
    expect(request.template).toBe("blank");
    expect(request.criteria).toEqual([]);
  });
});
