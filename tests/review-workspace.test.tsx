// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperPilotApi } from "../src/preload/index";
import { App } from "../src/renderer/App";
import { ReviewWorkspace, type ReviewState } from "../src/renderer/components/review-workspace";
import { TooltipProvider } from "../src/renderer/components/ui/tooltip";
import type {
  AppSettings,
  DiscoveryBatch,
  ExtractionField,
  ExtractionValue,
  ReferenceImportPreview,
  ReviewFlowSummary,
  ReviewPaperPage,
  ReviewRun,
  ReviewRunItem,
  ScreeningDecision
} from "../src/shared/schemas";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn()
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "pdf.worker.mjs" }));

const timestamp = "2026-08-22T12:00:00.000Z";
const projectId = "project-1";
const reviewId = "review-1";
const revisionId = "revision-1";

const review: ReviewState = {
  protocol: {
    id: reviewId,
    projectId,
    template: "general-empirical",
    currentRevisionId: revisionId,
    currentRevisionNumber: 1,
    historicalCountsAvailable: false,
    activatedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  },
  revision: {
    id: revisionId,
    reviewId,
    version: 1,
    researchQuestion: "Which interventions improve recovery?",
    objectives: ["Compare outcomes"],
    criteria: [],
    createdAt: timestamp
  }
};

const paper = {
  reviewId,
  paperId: "paper-1",
  title: "Controlled recovery trial",
  authors: ["Ada Researcher"],
  abstract: "A randomized trial reports recovery outcomes.",
  year: 2025,
  venue: "Evidence Journal",
  source: "pubmed" as const,
  discoveryBatchIds: ["batch-1"],
  hasFullText: true,
  extractionProgress: { total: 1, confirmed: 0, needsReview: 1 },
  needsReReview: false,
  aiSuggestionStale: false
};

const paperPage: ReviewPaperPage = {
  items: [paper],
  page: 1,
  pageSize: 25,
  total: 1,
  totalPages: 1,
  counts: { pending: 1, include: 0, exclude: 0, uncertain: 0 }
};

function renderReview(
  api: Record<string, unknown>,
  state: ReviewState | null = review,
  onOpenArtifact?: (artifactId: string, page?: number) => void
): JSX.Element {
  Object.defineProperty(window, "paperPilot", {
    configurable: true,
    value: {
      getReview: vi.fn().mockResolvedValue(state),
      listReviewProtocolRevisions: vi.fn().mockResolvedValue(state ? [state.revision] : []),
      onReviewRunEvent: vi.fn().mockReturnValue(() => undefined),
      listDiscoveryBatches: vi.fn().mockResolvedValue([]),
      listReviewRuns: vi.fn().mockResolvedValue([]),
      listReviewRunItems: vi.fn().mockResolvedValue([]),
      listReviewEvidence: vi.fn().mockResolvedValue([]),
      ...api
    }
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  const view = (
    <QueryClientProvider client={queryClient}>
      <ReviewWorkspace projectId={projectId} projectTitle="Recovery review" onOpenArtifact={onOpenArtifact} />
    </QueryClientProvider>
  );
  render(view);
  return view;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("evidence review workspace", () => {
  it("activates a review from a PICO-style template", async () => {
    const activateReview = vi.fn().mockResolvedValue({
      ...review,
      protocol: { ...review.protocol, template: "pico" as const }
    });
    renderReview({ activateReview }, null);

    fireEvent.click(await screen.findByRole("button", { name: /PICO-style review/i }));
    expect((screen.getByLabelText(/Research question/i) as HTMLTextAreaElement).value).toBe(
      "In [population], how does [intervention] compared with [comparator] affect [outcome]?"
    );
    fireEvent.click(screen.getByRole("button", { name: /Activate review/i }));

    await waitFor(() =>
      expect(activateReview).toHaveBeenCalledWith(
        expect.objectContaining({ projectId, template: "pico", criteria: expect.arrayContaining([expect.any(Object)]) })
      )
    );
    expect(await screen.findByText("Evidence review")).toBeTruthy();
  });

  it("supports keyboard screening, required full-text reasons, and bounded AI batches", async () => {
    const decision: ScreeningDecision = {
      id: "decision-1",
      reviewId,
      paperId: paper.paperId,
      stage: "title-abstract",
      decision: "include",
      protocolRevisionId: revisionId,
      createdAt: timestamp
    };
    const saveScreeningDecision = vi.fn().mockResolvedValue(decision);
    const run: ReviewRun = {
      id: "run-1",
      reviewId,
      stage: "title-abstract",
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId: revisionId,
      status: "running",
      paperIds: [paper.paperId],
      fieldIds: [],
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const startReviewRun = vi.fn().mockResolvedValue(run);
    renderReview({
      listReviewPapers: vi.fn().mockResolvedValue(paperPage),
      saveScreeningDecision,
      markReviewPapersForReview: vi.fn(),
      fetchReviewPaperFullText: vi.fn(),
      attachReviewPaperPdf: vi.fn(),
      startReviewRun
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    const row = await screen.findByLabelText(`Screen ${paper.title}`);
    fireEvent.keyDown(row, { key: "i" });
    await waitFor(() =>
      expect(saveScreeningDecision).toHaveBeenCalledWith(
        expect.objectContaining({ paperId: paper.paperId, stage: "title-abstract", decision: "include" })
      )
    );

    fireEvent.click(screen.getByLabelText(`Select ${paper.title}`));
    fireEvent.click(screen.getByRole("button", { name: /Suggest with AI \(1\)/i }));
    await waitFor(() =>
      expect(startReviewRun).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "title-abstract", paperIds: [paper.paperId] })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    const fullTextRow = await screen.findByLabelText(`Screen ${paper.title}`);
    fireEvent.keyDown(fullTextRow, { key: "e" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter a full-text exclusion reason/i);
    fireEvent.change(screen.getByLabelText(/Full-text exclusion reason/i), {
      target: { value: "Wrong population" }
    });
    fireEvent.keyDown(fullTextRow, { key: "e" });
    await waitFor(() =>
      expect(saveScreeningDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: "full-text", decision: "exclude", customReason: "Wrong population" })
      )
    );
  });

  it("filters the screening queue by source and year and exposes complete paper metadata", async () => {
    const listReviewPapers = vi.fn().mockResolvedValue({
      ...paperPage,
      items: [{ ...paper, doi: "10.1000/recovery" }]
    });
    const provenanceBatch: DiscoveryBatch = {
      id: "batch-1",
      reviewId,
      kind: "reference-import",
      label: "Imported registry search",
      status: "completed",
      counts: { identified: 1, filtered: 0, invalid: 0, duplicates: 0, merged: 0, newRecords: 1 },
      historicalCountsAvailable: true,
      createdAt: timestamp,
      completedAt: timestamp
    };
    renderReview({
      listReviewPapers,
      listDiscoveryBatches: vi.fn().mockResolvedValue([provenanceBatch]),
      getProjectBundle: vi.fn().mockResolvedValue({
        papers: [
          {
            id: paper.paperId,
            projectId,
            title: paper.title,
            authors: paper.authors,
            abstract: `${paper.abstract} Full methods and outcome details.`,
            year: paper.year,
            doi: "10.1000/recovery",
            url: "https://example.test/recovery-trial",
            source: "pubmed"
          }
        ]
      }),
      saveScreeningDecision: vi.fn(),
      markReviewPapersForReview: vi.fn(),
      fetchReviewPaperFullText: vi.fn(),
      attachReviewPaperPdf: vi.fn(),
      startReviewRun: vi.fn()
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    fireEvent.change(await screen.findByLabelText("Source"), { target: { value: "pubmed" } });
    fireEvent.change(screen.getByLabelText("Year from"), { target: { value: "2020" } });
    fireEvent.change(screen.getByLabelText("Year to"), { target: { value: "2025" } });

    await waitFor(() =>
      expect(listReviewPapers).toHaveBeenLastCalledWith(
        expect.objectContaining({ sources: ["pubmed"], yearFrom: 2020, yearTo: 2025 })
      )
    );

    fireEvent.click(await screen.findByText("View paper details"));
    expect(screen.getByRole("link", { name: "10.1000/recovery" }).getAttribute("href")).toContain("doi.org");
    expect(screen.getByRole("link", { name: "https://example.test/recovery-trial" })).toBeTruthy();
    expect(screen.getByText(/Full methods and outcome details/)).toBeTruthy();
    expect(await screen.findByText(/Imported registry search/)).toBeTruthy();
    expect(screen.getByText(/Source: PubMed/)).toBeTruthy();
  });

  it("applies protocol exclusion criteria and all bulk screening decisions", async () => {
    const secondPaper = { ...paper, paperId: "paper-2", title: "Second recovery trial" };
    const twoPaperPage: ReviewPaperPage = {
      ...paperPage,
      items: [paper, secondPaper],
      total: 2,
      counts: { ...paperPage.counts, pending: 2 }
    };
    const saveScreeningDecision = vi.fn().mockResolvedValue({
      id: "bulk-decision",
      reviewId,
      paperId: paper.paperId,
      stage: "full-text",
      decision: "exclude",
      protocolRevisionId: revisionId,
      createdAt: timestamp
    });
    renderReview(
      {
        listReviewPapers: vi.fn().mockResolvedValue(twoPaperPage),
        saveScreeningDecision,
        markReviewPapersForReview: vi.fn(),
        fetchReviewPaperFullText: vi.fn(),
        attachReviewPaperPdf: vi.fn(),
        startReviewRun: vi.fn()
      },
      {
        ...review,
        revision: {
          ...review.revision,
          criteria: [
            {
              id: "wrong-population",
              stage: "full-text",
              type: "exclusion",
              label: "Wrong population",
              order: 0
            }
          ]
        }
      }
    );

    fireEvent.click(await screen.findByRole("button", { name: "Full text" }));
    fireEvent.change(await screen.findByLabelText("Full-text exclusion criterion"), {
      target: { value: "wrong-population" }
    });
    fireEvent.click(screen.getByLabelText(`Select ${paper.title}`));
    fireEvent.click(screen.getByLabelText(`Select ${secondPaper.title}`));
    fireEvent.click(screen.getByRole("button", { name: "Exclude selected (2)" }));

    await waitFor(() => expect(saveScreeningDecision).toHaveBeenCalledTimes(2));
    expect(saveScreeningDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ decision: "exclude", reasonCriterionId: "wrong-population" })
    );
    expect(saveScreeningDecision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ decision: "exclude", reasonCriterionId: "wrong-population" })
    );

    fireEvent.click(screen.getByLabelText(`Select ${paper.title}`));
    fireEvent.click(screen.getByRole("button", { name: "Include selected (1)" }));
    await waitFor(() => expect(saveScreeningDecision).toHaveBeenCalledTimes(3));
    expect(saveScreeningDecision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "include" }));

    fireEvent.click(screen.getByLabelText(`Select ${paper.title}`));
    fireEvent.click(screen.getByRole("button", { name: "Uncertain selected (1)" }));
    await waitFor(() => expect(saveScreeningDecision).toHaveBeenCalledTimes(4));
    expect(saveScreeningDecision).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "uncertain" }));
  });

  it("reports success and failure for full-text actions", async () => {
    const metadataOnlyPage: ReviewPaperPage = {
      ...paperPage,
      items: [{ ...paper, hasFullText: false }]
    };
    const fetchReviewPaperFullText = vi.fn().mockResolvedValue({ ok: true, artifactId: "artifact-1" });
    const attachReviewPaperPdf = vi.fn().mockRejectedValue(new Error("The PDF could not be indexed"));
    renderReview({
      listReviewPapers: vi.fn().mockResolvedValue(metadataOnlyPage),
      saveScreeningDecision: vi.fn(),
      markReviewPapersForReview: vi.fn(),
      fetchReviewPaperFullText,
      attachReviewPaperPdf,
      startReviewRun: vi.fn()
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fetch full text" }));
    expect((await screen.findByRole("status")).textContent).toContain("fetched and indexed");
    fireEvent.click(screen.getByRole("button", { name: "Attach PDF" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The PDF could not be indexed");
  });

  it("previews CSV mapping and commits conservative import resolutions", async () => {
    const batch: DiscoveryBatch = {
      id: "batch-1",
      reviewId,
      kind: "pre-existing",
      label: "Pre-existing project papers",
      status: "completed",
      counts: { identified: 1, filtered: 0, invalid: 0, duplicates: 0, merged: 0, newRecords: 1 },
      historicalCountsAvailable: false,
      createdAt: timestamp,
      completedAt: timestamp
    };
    const preview: ReferenceImportPreview = {
      previewId: "preview-1",
      projectId,
      reviewId,
      fileName: "trials.csv",
      format: "csv",
      sizeBytes: 100,
      totalRecords: 1,
      validRecords: 1,
      invalidRecords: 0,
      columns: ["Study title", "DOI"],
      suggestedMapping: { title: "Study title", doi: "DOI" },
      items: [
        {
          recordIndex: 0,
          record: { title: "Imported trial", authors: [] },
          valid: true,
          errors: [],
          match: { kind: "none", candidatePaperIds: [] }
        }
      ],
      warnings: []
    };
    const commitReferenceImport = vi.fn().mockResolvedValue({ batch, counts: batch.counts });
    const remapReferenceImport = vi.fn().mockResolvedValue(preview);
    renderReview({
      listDiscoveryBatches: vi.fn().mockResolvedValue([batch]),
      previewReferenceImport: vi.fn().mockResolvedValue(preview),
      remapReferenceImport,
      commitReferenceImport
    });

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    fireEvent.click(screen.getByRole("button", { name: /Import references/i }));
    expect(await screen.findByTestId("reference-import-preview")).toBeTruthy();
    expect((screen.getByLabelText("Title (required)") as HTMLSelectElement).value).toBe("Study title");
    fireEvent.change(screen.getByLabelText(/^abstract$/i), { target: { value: "DOI" } });
    expect((screen.getByRole("button", { name: /Commit import/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Apply mapping and refresh preview/i }));
    await waitFor(() =>
      expect(remapReferenceImport).toHaveBeenCalledWith(
        expect.objectContaining({ previewId: preview.previewId, mapping: expect.objectContaining({ abstract: "DOI" }) })
      )
    );
    fireEvent.click(screen.getByRole("button", { name: /Commit import/i }));

    await waitFor(() =>
      expect(commitReferenceImport).toHaveBeenCalledWith(
        expect.objectContaining({
          previewId: preview.previewId,
          mapping: expect.objectContaining({ title: "Study title" })
        })
      )
    );
    expect((await screen.findByRole("status")).textContent).toContain("Import complete");
  });

  it("paginates every ambiguous import match and requires explicit resolutions before commit", async () => {
    const items = Array.from({ length: 101 }, (_, index) => ({
      recordIndex: index,
      record: { title: `Ambiguous ${index + 1}`, authors: [] },
      valid: true,
      errors: [],
      match: { kind: "ambiguous" as const, candidatePaperIds: [`paper-match-${index}`] }
    }));
    const preview: ReferenceImportPreview = {
      previewId: "preview-many",
      projectId,
      reviewId,
      fileName: "ambiguous.ris",
      format: "ris",
      sizeBytes: 10_000,
      totalRecords: items.length,
      validRecords: items.length,
      invalidRecords: 0,
      columns: [],
      items,
      warnings: []
    };
    const batch: DiscoveryBatch = {
      id: "batch-many",
      reviewId,
      kind: "reference-import",
      label: "Ambiguous import",
      status: "completed",
      counts: { identified: 101, filtered: 101, invalid: 0, duplicates: 0, merged: 0, newRecords: 0 },
      historicalCountsAvailable: true,
      createdAt: timestamp,
      completedAt: timestamp
    };
    const commitReferenceImport = vi.fn().mockResolvedValue({ batch, counts: batch.counts });
    renderReview({
      previewReferenceImport: vi.fn().mockResolvedValue(preview),
      commitReferenceImport
    });

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    fireEvent.click(screen.getByRole("button", { name: /Import references/i }));
    expect(await screen.findByLabelText("Resolution for Ambiguous 1")).toBeTruthy();
    expect(screen.queryByLabelText("Resolution for Ambiguous 101")).toBeNull();
    expect((screen.getByRole("button", { name: /Commit import/i }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Ambiguous matches: next" }));
    fireEvent.click(screen.getByRole("button", { name: "Ambiguous matches: next" }));
    expect(await screen.findByLabelText("Resolution for Ambiguous 101")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip all unresolved" }));
    expect(screen.getByText(/101 of 101 explicitly resolved/i)).toBeTruthy();
    const commit = screen.getByRole("button", { name: /Commit import/i }) as HTMLButtonElement;
    expect(commit.disabled).toBe(false);
    fireEvent.click(commit);

    await waitFor(() => expect(commitReferenceImport).toHaveBeenCalledTimes(1));
    const request = commitReferenceImport.mock.calls[0][0];
    expect(request.resolutions).toHaveLength(101);
    expect(request.resolutions).toEqual(
      expect.arrayContaining([
        { recordIndex: 0, action: "skip", paperId: undefined },
        { recordIndex: 100, action: "skip", paperId: undefined }
      ])
    );
  });

  it("keeps invalid import details after the first preview page accessible", async () => {
    const items = Array.from({ length: 151 }, (_, index) =>
      index === 150
        ? {
            recordIndex: index,
            rawTitle: "Malformed late record",
            valid: false,
            errors: ["Year must contain four digits."],
            match: { kind: "none" as const, candidatePaperIds: [] }
          }
        : {
            recordIndex: index,
            record: { title: `Valid record ${index + 1}`, authors: [] },
            valid: true,
            errors: [],
            match: { kind: "none" as const, candidatePaperIds: [] }
          }
    );
    const preview: ReferenceImportPreview = {
      previewId: "preview-invalid-late",
      projectId,
      reviewId,
      fileName: "late-invalid.ris",
      format: "ris",
      sizeBytes: 15_000,
      totalRecords: 151,
      validRecords: 150,
      invalidRecords: 1,
      columns: [],
      items,
      warnings: []
    };
    renderReview({ previewReferenceImport: vi.fn().mockResolvedValue(preview) });

    fireEvent.click(await screen.findByRole("button", { name: "Discover" }));
    fireEvent.click(screen.getByRole("button", { name: /Import references/i }));
    expect(await screen.findByText("Valid record 1")).toBeTruthy();
    expect(screen.queryByText("Year must contain four digits.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Preview records"), { target: { value: "invalid" } });
    expect(await screen.findByText("Malformed late record")).toBeTruthy();
    expect(screen.getByText("Year must contain four digits.")).toBeTruthy();
  });

  it("confirms manual extraction values and exports the deterministic flow summary", async () => {
    const field: ExtractionField = {
      id: "field-1",
      reviewId,
      name: "Primary outcome",
      type: "short-text",
      options: [],
      order: 0,
      revision: 1,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    let values: ExtractionValue[] = [];
    const saveExtractionValue = vi.fn(async (input) => {
      const value: ExtractionValue = {
        id: "value-1",
        reviewId,
        paperId: paper.paperId,
        fieldId: field.id,
        fieldRevision: field.revision,
        value: input.value,
        status: input.status,
        origin: "manual",
        evidenceIds: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      values = [value];
      return value;
    });
    const summary: ReviewFlowSummary = {
      reviewId,
      identifiedRecords: 20,
      filteredRecords: 1,
      invalidRecords: 0,
      duplicateRecords: 4,
      mergedRecords: 0,
      newRecords: 15,
      uniqueRecordsScreened: 16,
      titleAbstractExclusions: 8,
      fullTextsSought: 8,
      fullTextsUnavailable: 1,
      fullTextExclusionsByReason: { "Wrong population": 2 },
      includedPapers: 5,
      extraction: {
        totalCells: 5,
        confirmedCells: 4,
        notFoundCells: 0,
        needsReviewCells: 1,
        completionPercent: 80
      },
      historicalCountsAvailable: true,
      warnings: [],
      generatedAt: timestamp
    };
    const exportReview = vi.fn().mockResolvedValue({ ok: true, path: "C:/exports/review" });
    renderReview({
      listExtractionFields: vi.fn().mockResolvedValue([field]),
      listReviewPapers: vi.fn().mockResolvedValue(paperPage),
      listExtractionValues: vi.fn(async () => values),
      saveExtractionValue,
      upsertExtractionField: vi.fn(),
      startReviewRun: vi.fn(),
      getReviewSummary: vi.fn().mockResolvedValue(summary),
      exportReview
    });

    fireEvent.click(await screen.findByRole("button", { name: "Extract" }));
    const cell = await screen.findByLabelText("Primary outcome");
    fireEvent.change(cell, { target: { value: "Faster recovery" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(saveExtractionValue).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: field.id, value: "Faster recovery", status: "confirmed" })
      )
    );
    expect(await screen.findByText("Manual—no linked evidence")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Summary" }));
    expect((await screen.findAllByText("Review flow")).length).toBeGreaterThan(0);
    expect(screen.getByText("80% complete · 4 confirmed · 0 not found · 1 need review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Export review package/i }));
    await waitFor(() => expect(exportReview).toHaveBeenCalledWith({ reviewId }));
    expect((await screen.findByRole("status")).textContent).toContain("C:/exports/review");
  });

  it("restores an active persisted run and its completed suggestions after returning to Review", async () => {
    const onOpenArtifact = vi.fn();
    const persistedRun: ReviewRun = {
      id: "persisted-run",
      reviewId,
      stage: "title-abstract",
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId: revisionId,
      status: "running",
      paperIds: [paper.paperId],
      fieldIds: [],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const item: ReviewRunItem = {
      id: "persisted-item",
      runId: persistedRun.id,
      paperId: paper.paperId,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      rationale: "The abstract matches the protocol.",
      criterionAssessments: [],
      extractionSuggestions: [],
      evidence: [
        {
          id: "persisted-evidence",
          reviewId,
          evidenceId: "S1",
          runId: persistedRun.id,
          runItemId: "persisted-item",
          paperId: paper.paperId,
          artifactId: "artifact-1",
          chunkId: "chunk-1",
          sourceType: "artifact-chunk",
          title: paper.title,
          excerpt: paper.abstract,
          locator: "Page 7",
          page: 7,
          createdAt: timestamp
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    };
    renderReview(
      {
        listReviewRuns: vi.fn().mockResolvedValue([persistedRun]),
        listReviewRunItems: vi.fn().mockResolvedValue([item]),
        listReviewPapers: vi.fn().mockResolvedValue(paperPage)
      },
      review,
      onOpenArtifact
    );

    expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText("ollama · qwen3.8")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abstract" }));
    expect(await screen.findByText(/AI suggestion:/i)).toBeTruthy();
    expect(screen.getByText("The abstract matches the protocol.")).toBeTruthy();
    fireEvent.click(screen.getByText("Evidence (1)"));
    fireEvent.click(screen.getByRole("button", { name: /Open source · p\. 7/i }));
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact-1", 7);
  });

  it("shows AI not-found as advisory, disables blank confirmation, and requires explicit acceptance", async () => {
    const field: ExtractionField = {
      id: "field-not-found",
      reviewId,
      name: "Primary outcome",
      type: "short-text",
      options: [],
      order: 0,
      revision: 1,
      active: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const value: ExtractionValue = {
      id: "value-not-found-suggestion",
      reviewId,
      paperId: paper.paperId,
      fieldId: field.id,
      fieldRevision: 1,
      value: null,
      status: "suggested",
      origin: "ai",
      evidenceIds: [],
      runItemId: "item-not-found",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const saveExtractionValue = vi.fn().mockResolvedValue({
      ...value,
      status: "not-found",
      origin: "manual"
    });
    renderReview({
      listExtractionFields: vi.fn().mockResolvedValue([field]),
      listReviewPapers: vi.fn().mockResolvedValue(paperPage),
      listExtractionValues: vi.fn().mockResolvedValue([value]),
      saveExtractionValue,
      upsertExtractionField: vi.fn(),
      reorderExtractionFields: vi.fn(),
      startReviewRun: vi.fn()
    });

    fireEvent.click(await screen.findByRole("button", { name: "Extract" }));
    expect(await screen.findByText("Suggested: not found")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Primary outcome"), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Accept not found" }));
    await waitFor(() =>
      expect(saveExtractionValue).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: field.id, value: null, status: "not-found" })
      )
    );
  });

  it("hydrates suggestions across batches without letting an older run replace a newer paper result", async () => {
    const secondPaper = { ...paper, paperId: "paper-2", title: "Second recovery trial" };
    const page: ReviewPaperPage = {
      ...paperPage,
      items: [paper, secondPaper],
      total: 2,
      counts: { ...paperPage.counts, pending: 2 }
    };
    const run = (id: string, updatedAt: string, paperIds: string[]): ReviewRun => ({
      id,
      reviewId,
      stage: "title-abstract",
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId: revisionId,
      status: "completed",
      paperIds,
      fieldIds: [],
      completedCount: paperIds.length,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: updatedAt,
      updatedAt,
      completedAt: updatedAt
    });
    const older = run("run-older", "2026-08-22T12:00:00.000Z", [paper.paperId]);
    const otherBatch = run("run-other", "2026-08-22T13:00:00.000Z", [secondPaper.paperId]);
    const newest = run("run-newest", "2026-08-22T14:00:00.000Z", [paper.paperId]);
    const item = (runId: string, paperId: string, rationale: string): ReviewRunItem => ({
      id: `item-${runId}`,
      runId,
      paperId,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      rationale,
      criterionAssessments: [],
      extractionSuggestions: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const listReviewRunItems = vi.fn(async (runId: string) => {
      if (runId === older.id) return [item(runId, paper.paperId, "Superseded older suggestion")];
      if (runId === otherBatch.id) return [item(runId, secondPaper.paperId, "Suggestion from earlier batch")];
      return [item(runId, paper.paperId, "Newest suggestion for paper one")];
    });
    renderReview({
      listReviewRuns: vi.fn().mockResolvedValue([newest, older, otherBatch]),
      listReviewRunItems,
      listReviewPapers: vi.fn().mockResolvedValue(page)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    expect(await screen.findByText("Newest suggestion for paper one")).toBeTruthy();
    expect(await screen.findByText("Suggestion from earlier batch")).toBeTruthy();
    expect(screen.queryByText("Superseded older suggestion")).toBeNull();
    expect(listReviewRunItems).toHaveBeenCalledTimes(3);
  });

  it("uses authoritative run order for timestamp ties while preferring current non-stale suggestions", async () => {
    const secondPaper = { ...paper, paperId: "paper-2", title: "Second recovery trial" };
    const page: ReviewPaperPage = {
      ...paperPage,
      items: [paper, secondPaper],
      total: 2,
      counts: { ...paperPage.counts, pending: 2 }
    };
    const tiedRun = (id: string, paperId: string, protocolRevisionId = revisionId): ReviewRun => ({
      id,
      reviewId,
      stage: "title-abstract",
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId,
      status: "completed",
      paperIds: [paperId],
      fieldIds: [],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const currentNewer = tiedRun("run-a-current-newer", paper.paperId);
    const currentOlder = tiedRun("run-z-current-older", paper.paperId);
    const staleNewer = tiedRun("run-a-stale-newer", secondPaper.paperId, "superseded-revision");
    const freshOlder = tiedRun("run-z-fresh-older", secondPaper.paperId);
    const item = (run: ReviewRun, rationale: string, stale = false): ReviewRunItem => ({
      id: `item-${run.id}`,
      runId: run.id,
      paperId: run.paperIds[0],
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      rationale,
      criterionAssessments: [],
      extractionSuggestions: [],
      evidence: [],
      stale,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const items = new Map([
      [currentNewer.id, [item(currentNewer, "Authoritative newer tied suggestion")]],
      [currentOlder.id, [item(currentOlder, "Lexically later but older suggestion")]],
      [staleNewer.id, [item(staleNewer, "Later stale suggestion", true)]],
      [freshOlder.id, [item(freshOlder, "Current non-stale suggestion")]]
    ]);
    renderReview({
      // The API is newest-first. IDs deliberately sort in the opposite direction.
      listReviewRuns: vi.fn().mockResolvedValue([staleNewer, currentNewer, freshOlder, currentOlder]),
      listReviewRunItems: vi.fn(async (runId: string) => items.get(runId) ?? []),
      listReviewPapers: vi.fn().mockResolvedValue(page)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    expect(await screen.findByText("Authoritative newer tied suggestion")).toBeTruthy();
    expect(await screen.findByText("Current non-stale suggestion")).toBeTruthy();
    expect(screen.queryByText("Lexically later but older suggestion")).toBeNull();
    expect(screen.queryByText("Later stale suggestion")).toBeNull();
  });

  it("isolates suggestions for the same paper by review stage", async () => {
    const run = (id: string, stage: "title-abstract" | "full-text"): ReviewRun => ({
      id,
      reviewId,
      stage,
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId: revisionId,
      status: "completed",
      paperIds: [paper.paperId],
      fieldIds: [],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const abstractRun = run("run-abstract", "title-abstract");
    const fullTextRun = run("run-full-text", "full-text");
    const item = (run: ReviewRun, rationale: string): ReviewRunItem => ({
      id: `item-${run.id}`,
      runId: run.id,
      paperId: paper.paperId,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      rationale,
      criterionAssessments: [],
      extractionSuggestions: [],
      evidence: [],
      stale: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    renderReview({
      listReviewRuns: vi.fn().mockResolvedValue([fullTextRun, abstractRun]),
      listReviewRunItems: vi.fn(async (runId: string) =>
        runId === abstractRun.id
          ? [item(abstractRun, "Abstract-stage suggestion")]
          : [item(fullTextRun, "Full-text-stage suggestion")]
      ),
      listReviewPapers: vi.fn().mockResolvedValue(paperPage)
    });

    fireEvent.click(await screen.findByRole("button", { name: "Abstract" }));
    expect(await screen.findByText("Abstract-stage suggestion")).toBeTruthy();
    expect(screen.queryByText("Full-text-stage suggestion")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Full text" }));
    expect(await screen.findByText("Full-text-stage suggestion")).toBeTruthy();
    expect(screen.queryByText("Abstract-stage suggestion")).toBeNull();
  });

  it("links confirmed AI screening suggestions to their run item and blocks stale confirmations", async () => {
    const freshPaper = {
      ...paper,
      // Historical stale items may exist, but the selected current item below is fresh.
      aiSuggestionStale: true
    };
    const stalePaper = {
      ...paper,
      paperId: "paper-stale",
      title: "Stale protocol result",
      aiSuggestionStale: true
    };
    const page: ReviewPaperPage = {
      ...paperPage,
      items: [freshPaper, stalePaper],
      total: 2,
      counts: { ...paperPage.counts, pending: 2 }
    };
    const run: ReviewRun = {
      id: "run-full-text",
      reviewId,
      stage: "full-text",
      provider: "ollama",
      model: "qwen3.8",
      protocolRevisionId: revisionId,
      status: "completed",
      paperIds: [paper.paperId, stalePaper.paperId],
      fieldIds: [],
      completedCount: 2,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    };
    const suggestion = (paperId: string, stale: boolean): ReviewRunItem => ({
      id: `suggestion-${paperId}`,
      runId: run.id,
      paperId,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "exclude",
      suggestedReasonCriterionId: "wrong-population",
      rationale: "The population does not meet the protocol.",
      criterionAssessments: [
        {
          criterionId: "wrong-population",
          assessment: "met",
          explanation: "The sampled population is outside scope.",
          evidenceIds: []
        }
      ],
      extractionSuggestions: [],
      evidence: [],
      stale,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const saveScreeningDecision = vi.fn().mockResolvedValue({
      id: "decision-ai",
      reviewId,
      paperId: paper.paperId,
      stage: "full-text",
      decision: "exclude",
      protocolRevisionId: revisionId,
      reasonCriterionId: "wrong-population",
      runItemId: `suggestion-${paper.paperId}`,
      createdAt: timestamp
    });
    renderReview({
      listReviewRuns: vi.fn().mockResolvedValue([run]),
      listReviewRunItems: vi
        .fn()
        .mockResolvedValue([suggestion(freshPaper.paperId, false), suggestion(stalePaper.paperId, true)]),
      listReviewPapers: vi.fn().mockResolvedValue(page),
      saveScreeningDecision
    });

    fireEvent.click(await screen.findByRole("button", { name: "Full text" }));
    expect(await screen.findAllByText(/Criterion assessments \(1\)/i)).toHaveLength(2);
    const confirmButtons = screen.getAllByRole("button", { name: "Confirm suggestion" });
    expect(confirmButtons).toHaveLength(1);
    fireEvent.click(confirmButtons[0]);
    await waitFor(() =>
      expect(saveScreeningDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          paperId: freshPaper.paperId,
          decision: "exclude",
          reasonCriterionId: "wrong-population",
          runItemId: `suggestion-${freshPaper.paperId}`
        })
      )
    );
    expect(
      (screen.getByRole("button", { name: "Rerun required for current protocol" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("preserves chat as the default and exposes the top-level Review switch", async () => {
    const settings: AppSettings = {
      ui: { theme: "system" },
      ai: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "test-model",
        hasApiKey: false,
        reasoningEnabled: true
      },
      python: { runtimeMode: "managed", markitdownEnabled: true },
      sources: { disabledSourceIds: [] }
    };
    Object.defineProperty(window, "paperPilot", {
      configurable: true,
      value: {
        listProjects: vi.fn().mockResolvedValue([]),
        listSources: vi.fn().mockResolvedValue([]),
        getSettings: vi.fn().mockResolvedValue(settings),
        setTitleBarTheme: vi.fn().mockResolvedValue(undefined),
        checkAiProvider: vi.fn().mockResolvedValue({
          provider: "ollama",
          baseUrl: settings.ai.baseUrl,
          model: settings.ai.model,
          hasApiKey: false,
          reachable: true,
          status: "ok",
          checkedAt: timestamp,
          models: []
        }),
        listCredentialFlags: vi.fn().mockResolvedValue([]),
        getUpdateStatus: vi
          .fn()
          .mockResolvedValue({ state: "idle", currentVersion: "0.0.0-development", retryCount: 0 }),
        platform: vi.fn().mockResolvedValue("win32"),
        onJobChanged: vi.fn().mockReturnValue(() => undefined),
        onChatRunEvent: vi.fn().mockReturnValue(() => undefined),
        onUpdateStatusChanged: vi.fn().mockReturnValue(() => undefined)
      } as unknown as PaperPilotApi
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <App />
        </TooltipProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText("Ask the project, inspect the evidence")).toBeTruthy();
    const reviewTab = screen.getByRole("tab", { name: "Review" });
    expect(reviewTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(reviewTab);
    expect(await screen.findByText("Select a project to begin an evidence review.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");
  });
});
