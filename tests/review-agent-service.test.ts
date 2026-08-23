import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ReviewAgentService, type ReviewProvider } from "../src/main/services/review-agent-service";
import type { CredentialService } from "../src/main/services/credential-service";
import type { ProviderChatInput, ProviderChatResult } from "../src/main/services/research-provider";
import type { SettingsService } from "../src/main/services/settings-service";
import type { AppSettings, ReviewRun, ReviewRunEvent } from "../src/shared/schemas";

let directory: string;
let db: PaperPilotDb;

const settings: AppSettings = {
  ui: { theme: "system" },
  ai: {
    provider: "ollama",
    baseUrl: "http://ollama.test",
    model: "review-model",
    hasApiKey: false,
    reasoningEnabled: false
  },
  python: { runtimeMode: "managed", markitdownEnabled: true },
  sources: { disabledSourceIds: [] }
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paper-pilot-review-agent-"));
  db = new PaperPilotDb(join(directory, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("ReviewAgentService", () => {
  it("persists an evidence-backed advisory screening item without model tools", async () => {
    const fixture = createFixture();
    const provider = queueProvider([
      JSON.stringify({
        decision: "include",
        rationale: "The population is relevant.",
        assessments: [
          {
            criterionId: fixture.criterionId,
            assessment: "met",
            explanation: "The abstract describes the target population.",
            evidenceIds: ["S2"]
          }
        ]
      })
    ]);
    const service = createService(provider);

    const complete = completionPromise();
    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    const event = await complete.promise;

    expect(event.type).toBe("complete");
    expect(db.getReviewRun(run.id)?.status).toBe("completed");
    expect(db.listReviewRunItems(run.id)[0]).toMatchObject({
      status: "completed",
      suggestedDecision: "include",
      attemptCount: 1,
      criterionAssessments: [expect.objectContaining({ criterionId: fixture.criterionId, evidenceIds: ["S2"] })]
    });
    expect(db.listReviewEvidence(fixture.reviewId, { runId: run.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ evidenceId: "S2", sourceType: "paper-abstract" })])
    );
    expect(provider.chat).toHaveBeenCalledWith(expect.not.objectContaining({ tools: expect.anything() }));
  });

  it("repairs malformed provider output once and then fails closed", async () => {
    const fixture = createFixture();
    const provider = queueProvider(["not json", "still not json"]);
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    await complete.promise;

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(db.getReviewRun(run.id)).toMatchObject({ status: "failed", failedCount: 1 });
    expect(db.listReviewRunItems(run.id)[0]).toMatchObject({
      status: "failed",
      suggestedDecision: undefined,
      evidence: []
    });
    expect(db.listReviewEvidence(fixture.reviewId, { runId: run.id })).toEqual([]);
  });

  it("finalizes an unexpected persistence failure instead of leaving the run active", async () => {
    const fixture = createFixture();
    const provider = queueProvider([validIncludeResponse(fixture.criterionId).content]);
    const originalUpdate = db.updateReviewRunItem.bind(db);
    let injectedFailures = 2;
    vi.spyOn(db, "updateReviewRunItem").mockImplementation((itemId, patch) => {
      if ((patch.status === "completed" || patch.status === "failed") && injectedFailures > 0) {
        injectedFailures -= 1;
        throw new Error("Injected persistence failure");
      }
      return originalUpdate(itemId, patch);
    });
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    const event = await complete.promise;

    expect(event.run).toMatchObject({ id: run.id, status: "failed" });
    expect(db.getReviewRun(run.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/unexpectedly/i) });
    await vi.waitFor(() => expect(service.isProjectActive(db.getReviewById(fixture.reviewId)!.projectId)).toBe(false));
  });

  it("refuses an in-place retry when global provider provenance changed", async () => {
    const fixture = createFixture();
    const provider = queueProvider(["not json", "still not json"]);
    const changedSettings: AppSettings = {
      ...settings,
      ai: { ...settings.ai, provider: "vercel", model: "different-model" }
    };
    const settingsService = {
      get: vi.fn().mockResolvedValueOnce(settings).mockResolvedValue(changedSettings)
    } as unknown as SettingsService;
    const service = new ReviewAgentService(db, settingsService, {} as CredentialService, provider);
    const complete = completionPromise();
    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    await complete.promise;

    await expect(service.retry(run.id, () => undefined)).rejects.toThrow(/original ollama model review-model/i);
    expect(db.getReviewRun(run.id)?.status).toBe("failed");
    expect(db.listReviewRunItems(run.id)[0]?.status).toBe("failed");
  });

  it("atomically reserves a project across simultaneous retry calls", async () => {
    const fixture = createFixture();
    const failedRun = createFailedRun(fixture, "failed-concurrent-retry");
    const settingsGate = deferred<AppSettings>();
    const settingsService = {
      get: vi.fn(() => settingsGate.promise)
    } as unknown as SettingsService;
    const provider = queueProvider([validIncludeResponse(fixture.criterionId).content]);
    const service = new ReviewAgentService(db, settingsService, {} as CredentialService, provider);
    const complete = completionPromise();

    const firstRetry = service.retry(failedRun.id, complete.emit);
    expect(service.isProjectActive(db.getReviewById(fixture.reviewId)!.projectId)).toBe(true);
    await expect(service.retry(failedRun.id, () => undefined)).rejects.toThrow(/already has an active review run/i);

    settingsGate.resolve(settings);
    await firstRetry;
    await complete.promise;

    expect(settingsService.get).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(db.getReviewRun(failedRun.id)).toMatchObject({ status: "completed", completedCount: 1 });
  });

  it("shares the atomic reservation between start and retry", async () => {
    const fixture = createFixture();
    const failedRun = createFailedRun(fixture, "failed-start-versus-retry");
    const settingsGate = deferred<AppSettings>();
    const settingsService = {
      get: vi.fn(() => settingsGate.promise)
    } as unknown as SettingsService;
    const provider = queueProvider([validIncludeResponse(fixture.criterionId).content]);
    const service = new ReviewAgentService(db, settingsService, {} as CredentialService, provider);
    const complete = completionPromise();

    const starting = service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    await expect(service.retry(failedRun.id, () => undefined)).rejects.toThrow(/already has an active review run/i);

    settingsGate.resolve(settings);
    const startedRun = await starting;
    await complete.promise;

    expect(startedRun.id).not.toBe(failedRun.id);
    expect(settingsService.get).toHaveBeenCalledTimes(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(db.getReviewRun(failedRun.id)?.status).toBe("failed");
    expect(db.getReviewRun(startedRun.id)?.status).toBe("completed");
  });

  it("releases a reservation when setup fails before launch", async () => {
    const fixture = createFixture();
    const settingsService = {
      get: vi.fn().mockRejectedValueOnce(new Error("Settings unavailable")).mockResolvedValue(settings)
    } as unknown as SettingsService;
    const provider = queueProvider([validIncludeResponse(fixture.criterionId).content]);
    const service = new ReviewAgentService(db, settingsService, {} as CredentialService, provider);

    await expect(
      service.start(
        { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
        () => undefined
      )
    ).rejects.toThrow(/settings unavailable/i);
    expect(service.isProjectActive(db.getReviewById(fixture.reviewId)!.projectId)).toBe(false);

    const complete = completionPromise();
    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      complete.emit
    );
    await complete.promise;
    expect(db.getReviewRun(run.id)?.status).toBe("completed");
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("does not let a finishing run clear a newer reservation", async () => {
    const fixture = createFixture();
    const secondSettings = deferred<AppSettings>();
    const settingsService = {
      get: vi
        .fn()
        .mockResolvedValueOnce(settings)
        .mockImplementation(() => secondSettings.promise)
    } as unknown as SettingsService;
    const provider = queueProvider([
      validIncludeResponse(fixture.criterionId).content,
      validIncludeResponse(fixture.criterionId).content
    ]);
    const service = new ReviewAgentService(db, settingsService, {} as CredentialService, provider);
    const firstCompleted = deferred<void>();
    const secondComplete = completionPromise();
    let secondStart: Promise<ReviewRun> | undefined;

    await service.start(
      { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
      (event) => {
        if (event.type !== "complete") return;
        secondStart = service.start(
          { reviewId: fixture.reviewId, stage: "title-abstract", paperIds: [fixture.paperId] },
          secondComplete.emit
        );
        firstCompleted.resolve(undefined);
      }
    );
    await firstCompleted.promise;
    await Promise.resolve();
    expect(service.isProjectActive(db.getReviewById(fixture.reviewId)!.projectId)).toBe(true);

    secondSettings.resolve(settings);
    expect(secondStart).toBeDefined();
    await secondStart!;
    await secondComplete.promise;
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("uses an AbortController, retains completed work, and retries only cancelled items", async () => {
    const fixture = createFixture(true);
    let runId = "";
    const provider: ReviewProvider = {
      chat: vi
        .fn<ReviewProvider["chat"]>()
        .mockResolvedValueOnce(validIncludeResponse(fixture.criterionId))
        .mockImplementationOnce((input) => {
          queueMicrotask(() => service.cancel(runId));
          return abortableProviderResponse(input);
        })
        .mockResolvedValueOnce(validIncludeResponse(fixture.criterionId))
    };
    const service = createService(provider);
    const cancelled = completionPromise();
    const run = await service.start(
      {
        reviewId: fixture.reviewId,
        stage: "title-abstract",
        paperIds: [fixture.paperId, fixture.secondPaperId!]
      },
      cancelled.emit
    );
    runId = run.id;
    await cancelled.promise;
    expect(db.getReviewRun(run.id)).toMatchObject({ status: "cancelled", completedCount: 1, cancelledCount: 1 });

    const retried = completionPromise();
    await service.retry(run.id, retried.emit);
    await retried.promise;

    expect(db.getReviewRun(run.id)).toMatchObject({ status: "completed", completedCount: 2 });
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it("does not call a provider for full-text screening without trusted indexed text", async () => {
    const fixture = createFixture();
    db.setScreeningDecision({
      reviewId: fixture.reviewId,
      paperId: fixture.paperId,
      stage: "title-abstract",
      decision: "include"
    });
    const provider = queueProvider([]);
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      { reviewId: fixture.reviewId, stage: "full-text", paperIds: [fixture.paperId] },
      complete.emit
    );
    await complete.promise;

    expect(provider.chat).not.toHaveBeenCalled();
    expect(db.listReviewRunItems(run.id)[0]).toMatchObject({
      status: "completed",
      suggestedDecision: "uncertain",
      rationale: expect.stringMatching(/no trusted indexed full text/i)
    });
  });

  it("processes extraction fields in groups of at most six and stores evidence-backed suggestions", async () => {
    const fixture = createFixture();
    db.setScreeningDecision({
      reviewId: fixture.reviewId,
      paperId: fixture.paperId,
      stage: "title-abstract",
      decision: "include"
    });
    db.setScreeningDecision({
      reviewId: fixture.reviewId,
      paperId: fixture.paperId,
      stage: "full-text",
      decision: "include"
    });
    db.saveArtifact({
      id: "full_text",
      projectId: db.getReviewById(fixture.reviewId)!.projectId,
      type: "paper-pdf",
      title: "Indexed full text",
      path: join(directory, "full-text.pdf"),
      mime: "application/pdf",
      hash: "fixture",
      source: "test",
      metadata: { paperId: fixture.paperId },
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: db.getReviewById(fixture.reviewId)!.projectId,
      artifactId: "full_text",
      paperId: fixture.paperId,
      chunks: [{ text: "The measured result was 42 participants.", metadata: { page: 3 } }]
    });
    const fields = Array.from({ length: 7 }, (_, index) =>
      db.saveExtractionField({
        reviewId: fixture.reviewId,
        name: `Field ${index + 1}`,
        type: "number",
        order: index
      })
    );
    const provider = queueProvider([
      extractionResponse(fields.slice(0, 6).map((field) => field.id)),
      extractionResponse(fields.slice(6).map((field) => field.id))
    ]);
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      {
        reviewId: fixture.reviewId,
        stage: "extraction",
        paperIds: [fixture.paperId],
        fieldIds: fields.map((field) => field.id)
      },
      complete.emit
    );
    await complete.promise;

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(db.listReviewRunItems(run.id)[0]?.error).toBeUndefined();
    expect(db.getReviewRun(run.id)?.status).toBe("completed");
    expect(db.listExtractionValues(fixture.reviewId, fixture.paperId)).toHaveLength(7);
    expect(db.listExtractionValues(fixture.reviewId, fixture.paperId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 42, status: "suggested", origin: "ai", evidenceIds: [expect.any(String)] })
      ])
    );
  });

  it("keeps missing-evidence not-found results advisory until a reviewer accepts them", async () => {
    const fixture = createFixture();
    includeForExtraction(fixture.reviewId, fixture.paperId);
    const field = db.saveExtractionField({
      reviewId: fixture.reviewId,
      name: "Outcome",
      type: "short-text"
    });
    const provider = queueProvider([]);
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      {
        reviewId: fixture.reviewId,
        stage: "extraction",
        paperIds: [fixture.paperId],
        fieldIds: [field.id]
      },
      complete.emit
    );
    await complete.promise;

    expect(provider.chat).not.toHaveBeenCalled();
    expect(db.listReviewRunItems(run.id)[0]?.extractionSuggestions).toEqual([
      expect.objectContaining({ fieldId: field.id, status: "not-found", value: null })
    ]);
    expect(db.listExtractionValues(fixture.reviewId, fixture.paperId)).toEqual([
      expect.objectContaining({ fieldId: field.id, status: "suggested", value: null, origin: "ai" })
    ]);
    expect(db.getReviewFlowSummary(fixture.reviewId).extraction).toMatchObject({
      totalCells: 1,
      confirmedCells: 0,
      notFoundCells: 0,
      needsReviewCells: 1,
      completionPercent: 0
    });
  });

  it("persists model uncertainty as an unresolved needs-review advisory", async () => {
    const fixture = createFixture();
    includeForExtraction(fixture.reviewId, fixture.paperId);
    addIndexedFullText(fixture.reviewId, fixture.paperId, "The report gives conflicting descriptions of the outcome.");
    const field = db.saveExtractionField({
      reviewId: fixture.reviewId,
      name: "Outcome",
      type: "short-text"
    });
    const provider = queueProvider([
      JSON.stringify({
        values: [
          {
            fieldId: field.id,
            status: "unclear",
            note: "The indexed passages conflict.",
            evidenceIds: ["S1"]
          }
        ]
      })
    ]);
    const service = createService(provider);
    const complete = completionPromise();

    const run = await service.start(
      {
        reviewId: fixture.reviewId,
        stage: "extraction",
        paperIds: [fixture.paperId],
        fieldIds: [field.id]
      },
      complete.emit
    );
    await complete.promise;

    expect(db.listReviewRunItems(run.id)[0]?.extractionSuggestions).toEqual([
      expect.objectContaining({ fieldId: field.id, status: "needs-review", value: null, evidenceIds: ["S1"] })
    ]);
    expect(db.listExtractionValues(fixture.reviewId, fixture.paperId)).toEqual([
      expect.objectContaining({ fieldId: field.id, status: "needs-review", value: null, origin: "ai" })
    ]);
    expect(db.getReviewFlowSummary(fixture.reviewId).extraction).toMatchObject({
      confirmedCells: 0,
      notFoundCells: 0,
      needsReviewCells: 1,
      completionPercent: 0
    });
  });
});

function includeForExtraction(reviewId: string, paperId: string): void {
  db.setScreeningDecision({ reviewId, paperId, stage: "title-abstract", decision: "include" });
  db.setScreeningDecision({ reviewId, paperId, stage: "full-text", decision: "include" });
}

function addIndexedFullText(reviewId: string, paperId: string, text: string): void {
  const projectId = db.getReviewById(reviewId)!.projectId;
  const artifactId = `full_text_${paperId}`;
  db.saveArtifact({
    id: artifactId,
    projectId,
    type: "paper-pdf",
    title: "Indexed full text",
    path: join(directory, `${artifactId}.pdf`),
    mime: "application/pdf",
    hash: artifactId,
    source: "test",
    metadata: { paperId },
    createdAt: new Date().toISOString()
  });
  db.addDocumentChunks({
    projectId,
    artifactId,
    paperId,
    chunks: [{ text, metadata: { page: 3 } }]
  });
}

function createFixture(withSecondPaper = false): {
  reviewId: string;
  paperId: string;
  secondPaperId?: string;
  criterionId: string;
} {
  const project = db.createProject("Review project");
  const addPaper = (paperId: string) =>
    db.savePaper(project.id, {
      id: paperId,
      title: `Study ${paperId}`,
      abstract: "Adults receiving the intervention had a measured outcome.",
      authors: ["Ada Researcher"],
      year: 2025,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
  const paper = addPaper("paper_one");
  const second = withSecondPaper ? addPaper("paper_two") : undefined;
  const review = db.createReview({
    projectId: project.id,
    researchQuestion: "Does the intervention improve the outcome?",
    criteria: [
      {
        id: "relevant_population",
        stage: "title-abstract",
        type: "inclusion",
        label: "Relevant population"
      }
    ]
  });
  const criterionId = db.getReviewProtocolRevision(review.id)!.criteria[0]!.id;
  return { reviewId: review.id, paperId: paper.id, secondPaperId: second?.id, criterionId };
}

function createFailedRun(fixture: { reviewId: string; paperId: string }, runId: string): ReviewRun {
  const review = db.getReviewById(fixture.reviewId)!;
  const timestamp = new Date().toISOString();
  const run = db.saveReviewRun({
    id: runId,
    reviewId: fixture.reviewId,
    stage: "title-abstract",
    provider: settings.ai.provider,
    model: settings.ai.model,
    protocolRevisionId: review.currentRevisionId,
    status: "failed",
    paperIds: [fixture.paperId],
    fieldIds: [],
    completedCount: 0,
    failedCount: 1,
    cancelledCount: 0,
    error: "Provider unavailable.",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp
  });
  db.saveReviewRunItem({
    id: `${runId}-item`,
    runId,
    paperId: fixture.paperId,
    status: "failed",
    attemptCount: 1,
    criterionAssessments: [],
    extractionSuggestions: [],
    evidence: [],
    error: "Provider unavailable.",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp
  });
  return run;
}

function createService(provider: ReviewProvider): ReviewAgentService {
  const settingsService = { get: vi.fn().mockResolvedValue(settings) } as unknown as SettingsService;
  return new ReviewAgentService(db, settingsService, {} as CredentialService, provider);
}

function queueProvider(contents: string[]): ReviewProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn(async (): Promise<ProviderChatResult> => ({
      content: contents.shift() ?? "",
      toolCalls: []
    }))
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function completionPromise(): {
  promise: Promise<Extract<ReviewRunEvent, { type: "complete" }>>;
  emit: (event: ReviewRunEvent) => void;
} {
  let resolve!: (event: Extract<ReviewRunEvent, { type: "complete" }>) => void;
  const promise = new Promise<Extract<ReviewRunEvent, { type: "complete" }>>((done) => {
    resolve = done;
  });
  return {
    promise,
    emit: (event) => {
      if (event.type === "complete") resolve(event);
    }
  };
}

function validIncludeResponse(criterionId: string): ProviderChatResult {
  return {
    content: JSON.stringify({
      decision: "include",
      rationale: "The population is relevant.",
      assessments: [
        {
          criterionId,
          assessment: "met",
          explanation: "The evidence describes the relevant population.",
          evidenceIds: ["S2"]
        }
      ]
    }),
    toolCalls: []
  };
}

function abortableProviderResponse(input: ProviderChatInput): Promise<ProviderChatResult> {
  return new Promise((_resolve, reject) => {
    input.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  });
}

function extractionResponse(fieldIds: string[]): string {
  return JSON.stringify({
    values: fieldIds.map((fieldId) => ({
      fieldId,
      status: "found",
      value: 42,
      evidenceIds: ["S1"]
    }))
  });
}
