import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { registerReviewIpc, type ReviewIpcRuntime, type ReviewIpcServices } from "../src/main/review-ipc";
import type { ReviewRun, ReviewRunEvent } from "../src/shared/schemas";

let directory: string;
let db: PaperPilotDb;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paper-pilot-review-ipc-"));
  db = new PaperPilotDb(join(directory, "review-ipc.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("registerReviewIpc", () => {
  it("registers the complete review API and returns validated review state", async () => {
    const project = db.createProject("IPC review");
    const runtime = new FakeReviewRuntime();
    registerReviewIpc(fakeServices(), runtime);

    expect([...runtime.handlers.keys()].sort()).toEqual(
      [
        "review:activate",
        "review:attachPdf",
        "review:cancelRun",
        "review:commitImport",
        "review:export",
        "review:fetchFullText",
        "review:get",
        "review:getSummary",
        "review:listDiscoveryBatches",
        "review:listEvidence",
        "review:listExtractionFields",
        "review:listExtractionValues",
        "review:listPapers",
        "review:listProtocolRevisions",
        "review:listRunItems",
        "review:listRuns",
        "review:markForReview",
        "review:previewImport",
        "review:remapImport",
        "review:reorderExtractionFields",
        "review:retryRun",
        "review:reviseProtocol",
        "review:saveDecision",
        "review:saveExtractionValue",
        "review:startRun",
        "review:upsertExtractionField"
      ].sort()
    );
    expect(await runtime.invoke("review:get", project.id)).toBeUndefined();

    const activated = (await runtime.invoke("review:activate", {
      projectId: project.id,
      template: "blank",
      researchQuestion: "What works?",
      objectives: [],
      criteria: []
    })) as { protocol: { id: string; currentRevisionNumber: number }; revision: { researchQuestion: string } };
    expect(activated.protocol.currentRevisionNumber).toBe(1);
    expect(activated.revision.researchQuestion).toBe("What works?");
    expect(await runtime.invoke("review:get", project.id)).toEqual(activated);

    await expect(
      runtime.invoke("review:reviseProtocol", {
        reviewId: activated.protocol.id,
        expectedVersion: 9,
        researchQuestion: "Stale update",
        objectives: [],
        criteria: []
      })
    ).rejects.toThrow("changed from version 9 to 1");
  });

  it("keeps selected import paths inside the main-process manager", async () => {
    const project = db.createProject("Import review");
    const review = db.createReview({ projectId: project.id });
    const selectedPath = "C:\\private\\references.ris";
    const preview = {
      previewId: "preview-1",
      projectId: project.id,
      reviewId: review.id,
      fileName: "references.ris",
      format: "ris" as const,
      sizeBytes: 42,
      totalRecords: 1,
      validRecords: 1,
      invalidRecords: 0,
      columns: [],
      items: [
        {
          recordIndex: 0,
          record: { title: "Imported study", authors: [] },
          rawTitle: "Imported study",
          valid: true,
          errors: [],
          match: { kind: "none" as const, candidatePaperIds: [] }
        }
      ],
      warnings: []
    };
    const importPreview = vi.fn(async (input: { filePath: string }) => {
      expect(input.filePath).toBe(selectedPath);
      return preview;
    });
    const remap = vi.fn(async (previewId: string, mapping: { title: string }) => {
      expect(previewId).toBe(preview.previewId);
      expect(mapping).toEqual({ title: "Study title" });
      return preview;
    });
    const runtime = new FakeReviewRuntime([{ canceled: false, filePaths: [selectedPath] }]);
    registerReviewIpc(fakeServices({ imports: { preview: importPreview, remap } }), runtime);

    const result = await runtime.invoke("review:previewImport", {
      projectId: project.id,
      reviewId: review.id
    });
    expect(result).toEqual(preview);
    expect(JSON.stringify(result)).not.toContain(selectedPath);
    expect(importPreview).toHaveBeenCalledOnce();
    expect(
      await runtime.invoke("review:remapImport", {
        previewId: preview.previewId,
        mapping: { title: "Study title" }
      })
    ).toEqual(preview);
    expect(remap).toHaveBeenCalledOnce();
  });

  it("copies a verified PDF while returning no selected or internal path", async () => {
    const project = db.createProject("PDF review");
    const paper = db.savePaper(project.id, {
      id: "paper-pdf",
      title: "Attached PDF study",
      authors: [],
      source: "arxiv",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id });
    const selectedPath = join(directory, "selected-secret.pdf");
    const internalPath = join(directory, "internal-artifact.pdf");
    await writeFile(selectedPath, "%PDF-1.7\nfixture");
    const importFile = vi.fn(async (input: { sourcePath: string; metadata?: Record<string, unknown> }) => {
      expect(input.sourcePath).toBe(selectedPath);
      expect(input.metadata).not.toHaveProperty("sourcePath");
      return {
        id: "artifact-pdf",
        projectId: project.id,
        type: "paper-pdf" as const,
        title: paper.title,
        path: internalPath,
        mime: "application/pdf",
        hash: "hash",
        source: "review-pdf-attachment",
        metadata: { paperId: paper.id },
        createdAt: "2026-08-23T00:00:00.000Z"
      };
    });
    const runtime = new FakeReviewRuntime([{ canceled: false, filePaths: [selectedPath] }]);
    registerReviewIpc(fakeServices({ artifacts: { importFile } }), runtime);

    const result = await runtime.invoke("review:attachPdf", {
      projectId: project.id,
      reviewId: review.id,
      paperId: paper.id
    });
    expect(result).toEqual({ ok: true, artifactId: "artifact-pdf" });
    expect(JSON.stringify(result)).not.toContain(selectedPath);
    expect(JSON.stringify(result)).not.toContain(internalPath);
    expect(db.listReviewAuditEvents(review.id).at(-1)).toMatchObject({
      kind: "paper-pdf-attached",
      entityId: paper.id,
      payload: { artifactId: "artifact-pdf", method: "manual-attachment" }
    });
  });

  it("preserves AI provenance only for an unchanged evidence-backed confirmation", async () => {
    const project = db.createProject("Extraction review");
    const paper = db.savePaper(project.id, {
      id: "paper-extraction",
      title: "Extraction paper",
      abstract: "The reported outcome improved.",
      authors: [],
      source: "pubmed",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id });
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include"
    });
    const field = db.saveExtractionField({
      reviewId: review.id,
      name: "Outcome",
      type: "short-text"
    });
    const timestamp = "2026-08-23T00:00:00.000Z";
    const run = db.saveReviewRun({
      id: "run-extraction",
      reviewId: review.id,
      stage: "extraction",
      provider: "ollama",
      model: "review-model",
      protocolRevisionId: review.currentRevisionId,
      status: "completed",
      paperIds: [paper.id],
      fieldIds: [field.id],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp
    });
    const runItem = db.saveReviewRunItem({
      id: "run-item-extraction",
      runId: run.id,
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      criterionAssessments: [],
      extractionSuggestions: [],
      evidence: [
        {
          id: "evidence-extraction",
          reviewId: review.id,
          evidenceId: "S1",
          runId: run.id,
          runItemId: "run-item-extraction",
          paperId: paper.id,
          sourceType: "paper-abstract",
          title: paper.title,
          excerpt: paper.abstract!,
          locator: "Abstract",
          createdAt: timestamp
        }
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp
    });
    const evidence = runItem.evidence[0];
    const suggestion = db.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "suggested",
      origin: "ai",
      evidenceIds: [evidence.id],
      runItemId: runItem.id
    });
    const runtime = new FakeReviewRuntime();
    registerReviewIpc(fakeServices(), runtime);

    const rejected = await runtime.invoke("review:saveExtractionValue", {
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      expectedFieldRevision: field.revision,
      value: "Renderer-tampered value",
      status: "rejected",
      evidenceIds: []
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      origin: "ai",
      value: "Improved",
      evidenceIds: [evidence.id],
      runItemId: runItem.id
    });
    db.saveExtractionValue({
      id: suggestion.id,
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "suggested",
      origin: "ai",
      evidenceIds: [evidence.id],
      runItemId: runItem.id,
      createdAt: suggestion.createdAt
    });

    const confirmed = await runtime.invoke("review:saveExtractionValue", {
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      expectedFieldRevision: field.revision,
      value: "Improved",
      status: "confirmed",
      evidenceIds: [evidence.id]
    });
    expect(confirmed).toMatchObject({ status: "confirmed", origin: "ai" });

    const manualOverride = await runtime.invoke("review:saveExtractionValue", {
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      expectedFieldRevision: field.revision,
      value: "No improvement",
      status: "confirmed",
      evidenceIds: []
    });
    expect(manualOverride).toMatchObject({ status: "confirmed", origin: "manual", evidenceIds: [] });

    db.saveExtractionValue({
      id: suggestion.id,
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: null,
      status: "suggested",
      origin: "ai",
      evidenceIds: [],
      runItemId: runItem.id,
      createdAt: suggestion.createdAt
    });
    const acceptedNotFound = await runtime.invoke("review:saveExtractionValue", {
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      expectedFieldRevision: field.revision,
      value: null,
      status: "not-found",
      evidenceIds: []
    });
    expect(acceptedNotFound).toMatchObject({
      status: "not-found",
      origin: "manual",
      value: null,
      runItemId: runItem.id
    });
    expect(db.listReviewAuditEvents(review.id).at(-1)).toMatchObject({
      kind: "extraction-value-not-found",
      actor: "user",
      payload: { origin: "manual", runItemId: runItem.id }
    });
  });

  it("validates and scopes run events to the renderer that started the run", async () => {
    const project = db.createProject("Agent review");
    const paper = db.savePaper(project.id, {
      id: "paper-run",
      title: "Run paper",
      authors: [],
      source: "openalex",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id });
    const run: ReviewRun = {
      id: "run-1",
      reviewId: review.id,
      stage: "title-abstract",
      provider: "ollama",
      model: "qwen3:8b",
      protocolRevisionId: review.currentRevisionId,
      status: "queued",
      paperIds: [paper.id],
      fieldIds: [],
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z"
    };
    const event: ReviewRunEvent = {
      type: "status",
      runId: run.id,
      reviewId: review.id,
      status: "running"
    };
    const start = vi.fn(async (_input: unknown, emit: (value: ReviewRunEvent) => void) => {
      emit(event);
      return run;
    });
    const runtime = new FakeReviewRuntime();
    registerReviewIpc(fakeServices({ agent: { start } }), runtime);
    const sender = new FakeSender();

    expect(
      await runtime.invoke(
        "review:startRun",
        { reviewId: review.id, stage: "title-abstract", paperIds: [paper.id] },
        sender
      )
    ).toEqual(run);
    expect(sender.messages).toEqual([{ channel: "review:run-event", value: event }]);
  });

  it("writes the eight-file export into a newly created package directory", async () => {
    const project = db.createProject("Export review");
    const review = db.createReview({
      projectId: project.id,
      researchQuestion: "What was reviewed?"
    });
    const selectedDirectory = join(directory, "exports");
    const runtime = new FakeReviewRuntime([
      { canceled: false, filePaths: [selectedDirectory] },
      { canceled: false, filePaths: [selectedDirectory] }
    ]);
    registerReviewIpc(fakeServices(), runtime);

    const result = (await runtime.invoke("review:export", { reviewId: review.id })) as {
      ok: boolean;
      path: string;
      fileCount: number;
    };
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(8);
    expect((await readdir(result.path)).sort()).toEqual(
      [
        "evidence-locators.csv",
        "evidence-matrix.csv",
        "included-references.bib",
        "included-references.ris",
        "review-audit.json",
        "review-flow.svg",
        "review-summary.md",
        "screening-decisions.csv"
      ].sort()
    );
    expect(JSON.parse(await readFile(join(result.path, "review-audit.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      protocol: { id: review.id },
      protocolHistory: [{ id: review.currentRevisionId }],
      candidateOrigins: [],
      runItems: []
    });
    expect((await readdir(selectedDirectory)).some((name) => name.startsWith(".paper-pilot-review-export-"))).toBe(
      false
    );

    const repeated = (await runtime.invoke("review:export", { reviewId: review.id })) as typeof result;
    expect(repeated.path).not.toBe(result.path);
    for (const fileName of await readdir(result.path)) {
      expect(await readFile(join(repeated.path, fileName))).toEqual(await readFile(join(result.path, fileName)));
    }
  });

  it("exports only papers that currently pass both screening stages", async () => {
    const project = db.createProject("Eligibility export");
    const paper = db.savePaper(project.id, {
      id: "paper-invalidated-upstream",
      title: "Study invalidated by upstream screening",
      authors: ["Ada Reviewer"],
      source: "reference-import",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id });
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include"
    });
    const field = db.saveExtractionField({ reviewId: review.id, name: "Outcome", type: "short-text" });
    db.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "confirmed",
      origin: "manual"
    });

    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "exclude"
    });
    expect(db.getReviewFlowSummary(review.id).includedPapers).toBe(0);

    const selectedDirectory = join(directory, "eligibility-export");
    const runtime = new FakeReviewRuntime([{ canceled: false, filePaths: [selectedDirectory] }]);
    registerReviewIpc(fakeServices(), runtime);
    const result = (await runtime.invoke("review:export", { reviewId: review.id })) as { path: string };
    const audit = JSON.parse(await readFile(join(result.path, "review-audit.json"), "utf8")) as {
      flowSummary: { includedPapers: number };
      includedPapers: Array<{ id: string }>;
    };

    expect(audit.flowSummary.includedPapers).toBe(0);
    expect(audit.includedPapers).toEqual([]);
    expect(await readFile(join(result.path, "included-references.ris"), "utf8")).not.toContain(paper.title);
    expect(await readFile(join(result.path, "included-references.bib"), "utf8")).not.toContain(paper.title);
    expect(await readFile(join(result.path, "evidence-matrix.csv"), "utf8")).not.toContain(paper.id);
  });

  it("does not overwrite an existing package directory", async () => {
    const project = db.createProject("Atomic export");
    const review = db.createReview({ projectId: project.id, researchQuestion: "Is export atomic?" });
    const selectedDirectory = join(directory, "atomic-exports");
    const suffix = review.updatedAt.replace(/[:.]/g, "-");
    const targetDirectory = join(selectedDirectory, `Atomic export-evidence-review-${suffix}`);
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(join(targetDirectory, "sentinel.txt"), "keep", "utf8");
    const runtime = new FakeReviewRuntime([{ canceled: false, filePaths: [selectedDirectory] }]);
    registerReviewIpc(fakeServices(), runtime);

    const result = (await runtime.invoke("review:export", { reviewId: review.id })) as { path: string };

    expect(result.path).toBe(`${targetDirectory}-2`);
    expect(await readFile(join(targetDirectory, "sentinel.txt"), "utf8")).toBe("keep");
    expect((await readdir(selectedDirectory)).filter((name) => name.startsWith(".paper-pilot-review-export-"))).toEqual(
      []
    );
  });
});

class FakeSender {
  readonly messages: Array<{ channel: string; value: unknown }> = [];

  isDestroyed(): boolean {
    return false;
  }

  send(channel: string, value: unknown): void {
    this.messages.push({ channel, value });
  }
}

class FakeReviewRuntime implements ReviewIpcRuntime {
  readonly handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>();
  private readonly selections: Electron.OpenDialogReturnValue[];

  constructor(selections: Electron.OpenDialogReturnValue[] = []) {
    this.selections = [...selections];
  }

  handle(channel: string, listener: (event: IpcMainInvokeEvent, input: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }

  async showOpenDialog(): Promise<Electron.OpenDialogReturnValue> {
    return this.selections.shift() ?? { canceled: true, filePaths: [] };
  }

  async showMessageBox(): Promise<Electron.MessageBoxReturnValue> {
    return { response: 1, checkboxChecked: false };
  }

  async invoke(channel: string, input: unknown, sender = new FakeSender()): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler({ sender } as unknown as IpcMainInvokeEvent, input);
  }
}

function fakeServices(
  overrides: {
    imports?: Partial<ReviewIpcServices["imports"]>;
    agent?: Partial<ReviewIpcServices["agent"]>;
    artifacts?: Partial<ReviewIpcServices["artifacts"]>;
    fullText?: Partial<ReviewIpcServices["fullText"]>;
  } = {}
): ReviewIpcServices {
  return {
    db,
    imports: {
      preview: async () => {
        throw new Error("Unexpected import preview");
      },
      commit: async () => {
        throw new Error("Unexpected import commit");
      },
      ...overrides.imports
    } as unknown as ReviewIpcServices["imports"],
    agent: {
      start: async () => {
        throw new Error("Unexpected agent start");
      },
      cancel: () => false,
      retry: async () => {
        throw new Error("Unexpected agent retry");
      },
      ...overrides.agent
    } as unknown as ReviewIpcServices["agent"],
    artifacts: {
      importFile: async () => {
        throw new Error("Unexpected artifact import");
      },
      ...overrides.artifacts
    } as unknown as ReviewIpcServices["artifacts"],
    fullText: {
      fetchOpenAccessPdf: async () => ({}),
      ...overrides.fullText
    } as unknown as ReviewIpcServices["fullText"],
    settings: {
      get: async () => ({
        ui: { theme: "system" },
        ai: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen3:8b",
          hasApiKey: false,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true },
        sources: { disabledSourceIds: [] }
      })
    } as unknown as ReviewIpcServices["settings"]
  };
}
