import electron from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  activateReviewRequestSchema,
  artifactSchema,
  attachReviewPaperPdfRequestSchema,
  cancelReviewRunRequestSchema,
  discoveryBatchSchema,
  exportReviewRequestSchema,
  extractionFieldSchema,
  extractionValueSchema,
  fetchReviewPaperFullTextRequestSchema,
  getReviewSummaryRequestSchema,
  markReviewPapersForReviewRequestSchema,
  paperSchema,
  referenceImportCommitRequestSchema,
  referenceImportCommitResponseSchema,
  referenceImportMappingSchema,
  referenceImportPreviewRequestSchema,
  referenceImportPreviewSchema,
  reorderExtractionFieldsRequestSchema,
  retryReviewRunRequestSchema,
  reviseReviewProtocolRequestSchema,
  reviewFlowSummarySchema,
  reviewEvidenceSchema,
  reviewPaperPageSchema,
  reviewPaperQuerySchema,
  reviewProtocolRevisionSchema,
  reviewProtocolSchema,
  reviewRunEventSchema,
  reviewRunItemSchema,
  reviewRunSchema,
  saveExtractionValueRequestSchema,
  saveScreeningDecisionRequestSchema,
  screeningDecisionSchema,
  startReviewRunRequestSchema,
  upsertExtractionFieldRequestSchema,
  type ReviewProtocol,
  type ReviewRunEvent,
  type ScreeningDecision
} from "../shared/schemas.js";
import type { PaperPilotDb } from "./db.js";
import type { ArtifactService } from "./services/artifact-service.js";
import type { FullTextService } from "./services/full-text-service.js";
import type { ReviewAgentService } from "./services/review-agent-service.js";
import { renderReviewExportPackage } from "./services/review-export-service.js";
import type { ReviewImportManager } from "./services/review-import-manager.js";
import type { SettingsService } from "./services/settings-service.js";
import { ensureDir, safeFilename } from "./utils.js";

export interface ReviewIpcServices {
  db: PaperPilotDb;
  imports: ReviewImportManager;
  agent: ReviewAgentService;
  artifacts: ArtifactService;
  fullText: FullTextService;
  settings: SettingsService;
}

type ReviewIpcHandler = (event: IpcMainInvokeEvent, input: unknown) => unknown;

/** Minimal runtime surface keeps IPC registration testable without launching Electron. */
export interface ReviewIpcRuntime {
  handle(channel: string, listener: ReviewIpcHandler): void;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue>;
}

const reviewStateSchema = z.object({
  protocol: reviewProtocolSchema,
  revision: reviewProtocolRevisionSchema
});
const reviewIdSchema = z.string().min(1);
const extractionValueListRequestSchema = z.object({
  reviewId: z.string(),
  paperIds: z.array(z.string()).max(500).optional()
});
const reviewEvidenceListRequestSchema = z.object({
  reviewId: z.string(),
  evidenceIds: z.array(z.string()).max(1_000).optional()
});
const remapReferenceImportRequestSchema = z.object({
  previewId: z.string().min(1),
  mapping: referenceImportMappingSchema
});
const fileActionResponseSchema = z.object({
  ok: z.boolean(),
  artifactId: z.string().optional(),
  warning: z.string().optional()
});
const exportResponseSchema = z.object({
  ok: z.boolean(),
  path: z.string().optional(),
  fileCount: z.number().int().nonnegative().optional()
});
const markForReviewResponseSchema = z.object({ ok: z.literal(true), marked: z.number().int().nonnegative() });
const cancelRunResponseSchema = z.object({ cancelled: z.boolean() });

export function registerReviewIpc(services: ReviewIpcServices, providedRuntime?: ReviewIpcRuntime): void {
  const runtime = providedRuntime ?? electronReviewIpcRuntime();

  runtime.handle("review:get", (_event, projectIdInput) => {
    const projectId = z.string().parse(projectIdInput);
    const protocol = services.db.getReview(projectId);
    if (!protocol) return undefined;
    return parseReviewState(services.db, protocol);
  });

  runtime.handle("review:activate", (_event, input) => {
    const parsed = activateReviewRequestSchema.parse(input);
    const protocol = services.db.createReview(parsed);
    return parseReviewState(services.db, protocol);
  });

  runtime.handle("review:listProtocolRevisions", (_event, reviewIdInput) => {
    const reviewId = reviewIdSchema.parse(reviewIdInput);
    requireReview(services.db, reviewId);
    return z.array(reviewProtocolRevisionSchema).parse(services.db.listReviewProtocolRevisions(reviewId));
  });

  runtime.handle("review:reviseProtocol", (_event, input) => {
    const parsed = reviseReviewProtocolRequestSchema.parse(input);
    const review = requireReview(services.db, parsed.reviewId);
    if (review.currentRevisionNumber !== parsed.expectedVersion) {
      throw new Error(
        `The review protocol changed from version ${parsed.expectedVersion} to ${review.currentRevisionNumber}. Reload before saving.`
      );
    }
    return reviewProtocolRevisionSchema.parse(
      services.db.reviseReviewProtocol({
        reviewId: parsed.reviewId,
        researchQuestion: parsed.researchQuestion,
        objectives: parsed.objectives,
        criteria: parsed.criteria,
        changeNote: parsed.changeNote
      })
    );
  });

  runtime.handle("review:listPapers", (_event, input) => {
    const parsed = reviewPaperQuerySchema.parse(input);
    return reviewPaperPageSchema.parse(services.db.listReviewPapers(parsed));
  });

  runtime.handle("review:listDiscoveryBatches", (_event, reviewIdInput) => {
    const reviewId = reviewIdSchema.parse(reviewIdInput);
    requireReview(services.db, reviewId);
    return z.array(discoveryBatchSchema).parse(services.db.listDiscoveryBatches(reviewId));
  });

  runtime.handle("review:previewImport", async (_event, input) => {
    const parsed = referenceImportPreviewRequestSchema.parse(input);
    requireReviewInProject(services.db, parsed.reviewId, parsed.projectId);
    const selection = await runtime.showOpenDialog({
      title: "Preview reference import",
      properties: ["openFile"],
      filters: [
        { name: "Reference files", extensions: ["ris", "bib", "bibtex", "csv"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) return undefined;
    try {
      const preview = await services.imports.preview({ ...parsed, filePath });
      return referenceImportPreviewSchema.parse(preview);
    } catch (error) {
      throw redactSelectedPath(error, filePath);
    }
  });

  runtime.handle("review:remapImport", async (_event, input) => {
    const parsed = remapReferenceImportRequestSchema.parse(input);
    return referenceImportPreviewSchema.parse(await services.imports.remap(parsed.previewId, parsed.mapping));
  });

  runtime.handle("review:commitImport", async (_event, input) => {
    const parsed = referenceImportCommitRequestSchema.parse(input);
    requireReviewInProject(services.db, parsed.reviewId, parsed.projectId);
    return referenceImportCommitResponseSchema.parse(await services.imports.commit(parsed));
  });

  runtime.handle("review:saveDecision", (_event, input) => {
    const parsed = saveScreeningDecisionRequestSchema.parse(input);
    return screeningDecisionSchema.parse(services.db.setScreeningDecision(parsed));
  });

  runtime.handle("review:markForReview", (_event, input) => {
    const parsed = markReviewPapersForReviewRequestSchema.parse(input);
    requireReview(services.db, parsed.reviewId);
    const stages: Array<"title-abstract" | "full-text"> = parsed.stage
      ? [parsed.stage]
      : ["title-abstract", "full-text"];
    const marked = stages.reduce(
      (total, stage) =>
        total + services.db.markScreeningForRereview({ reviewId: parsed.reviewId, paperIds: parsed.paperIds, stage }),
      0
    );
    return markForReviewResponseSchema.parse({ ok: true, marked });
  });

  runtime.handle("review:listExtractionFields", (_event, reviewIdInput) => {
    const reviewId = reviewIdSchema.parse(reviewIdInput);
    requireReview(services.db, reviewId);
    return z.array(extractionFieldSchema).parse(services.db.listExtractionFields(reviewId));
  });

  runtime.handle("review:upsertExtractionField", (_event, input) => {
    const parsed = upsertExtractionFieldRequestSchema.parse(input);
    const existing = parsed.fieldId
      ? services.db.listExtractionFields(parsed.reviewId, true).find((candidate) => candidate.id === parsed.fieldId)
      : undefined;
    if (parsed.fieldId && !existing) throw new Error(`Extraction field not found: ${parsed.fieldId}`);
    if (existing && parsed.expectedRevision !== undefined && existing.revision !== parsed.expectedRevision) {
      throw new Error(
        `Extraction field ${existing.name} changed from revision ${parsed.expectedRevision} to ${existing.revision}. Reload before saving.`
      );
    }
    if (!parsed.fieldId && parsed.expectedRevision !== undefined) {
      throw new Error("A new extraction field cannot specify an expected revision.");
    }
    return extractionFieldSchema.parse(
      services.db.saveExtractionField({
        id: parsed.fieldId,
        reviewId: parsed.reviewId,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        options: parsed.options,
        order: parsed.order
      })
    );
  });

  runtime.handle("review:reorderExtractionFields", (_event, input) => {
    const parsed = reorderExtractionFieldsRequestSchema.parse(input);
    const fields = services.db.listExtractionFields(parsed.reviewId);
    const expectedIds = new Set(fields.map((field) => field.id));
    if (
      parsed.fieldIds.length !== expectedIds.size ||
      new Set(parsed.fieldIds).size !== parsed.fieldIds.length ||
      parsed.fieldIds.some((fieldId) => !expectedIds.has(fieldId))
    ) {
      throw new Error("Extraction field order must include every active field exactly once.");
    }
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const [order, fieldId] of parsed.fieldIds.entries()) {
      const field = byId.get(fieldId)!;
      services.db.saveExtractionField({
        id: field.id,
        reviewId: field.reviewId,
        name: field.name,
        description: field.description,
        type: field.type,
        options: field.options,
        order,
        active: field.active
      });
    }
    return z.array(extractionFieldSchema).parse(services.db.listExtractionFields(parsed.reviewId));
  });

  runtime.handle("review:listExtractionValues", (_event, input) => {
    const parsed = extractionValueListRequestSchema.parse(input);
    requireReview(services.db, parsed.reviewId);
    const values = services.db.listExtractionValues(parsed.reviewId);
    const requestedIds = parsed.paperIds ? new Set(parsed.paperIds) : undefined;
    return z
      .array(extractionValueSchema)
      .parse(requestedIds ? values.filter((value) => requestedIds.has(value.paperId)) : values);
  });

  runtime.handle("review:listEvidence", (_event, input) => {
    const parsed = reviewEvidenceListRequestSchema.parse(input);
    requireReview(services.db, parsed.reviewId);
    const evidence = services.db.listReviewEvidence(parsed.reviewId);
    const requestedIds = parsed.evidenceIds ? new Set(parsed.evidenceIds) : undefined;
    return z
      .array(reviewEvidenceSchema)
      .parse(requestedIds ? evidence.filter((entry) => requestedIds.has(entry.id)) : evidence);
  });

  runtime.handle("review:saveExtractionValue", (_event, input) => {
    const parsed = saveExtractionValueRequestSchema.parse(input);
    const field = services.db
      .listExtractionFields(parsed.reviewId)
      .find((candidate) => candidate.id === parsed.fieldId);
    if (!field) throw new Error(`Active extraction field not found: ${parsed.fieldId}`);
    if (field.revision !== parsed.expectedFieldRevision) {
      throw new Error(
        `Extraction field ${field.name} changed from revision ${parsed.expectedFieldRevision} to ${field.revision}. Reload before saving.`
      );
    }
    const existing = services.db
      .listExtractionValues(parsed.reviewId, parsed.paperId)
      .find((value) => value.fieldId === parsed.fieldId);
    const confirmsAiSuggestion =
      existing?.origin === "ai" &&
      existing.status === "suggested" &&
      parsed.status === "confirmed" &&
      JSON.stringify(existing.value) === JSON.stringify(parsed.value) &&
      sameStringSet(existing.evidenceIds, parsed.evidenceIds);
    const rejectsAiSuggestion =
      existing?.origin === "ai" &&
      (existing.status === "suggested" || existing.status === "needs-review") &&
      parsed.status === "rejected";
    const acceptsAiNotFoundSuggestion =
      existing?.origin === "ai" &&
      (existing.status === "suggested" || existing.status === "needs-review") &&
      existing.value === null &&
      parsed.status === "not-found";
    const preservesAiProvenance = rejectsAiSuggestion || confirmsAiSuggestion;
    const retainsOriginatingRun = preservesAiProvenance || acceptsAiNotFoundSuggestion;
    return extractionValueSchema.parse(
      services.db.saveExtractionValue({
        id: existing?.id,
        reviewId: parsed.reviewId,
        paperId: parsed.paperId,
        fieldId: parsed.fieldId,
        value: rejectsAiSuggestion ? existing.value : parsed.value,
        status: parsed.status,
        origin: preservesAiProvenance ? "ai" : "manual",
        evidenceIds: rejectsAiSuggestion ? existing.evidenceIds : parsed.evidenceIds,
        runItemId: retainsOriginatingRun ? existing?.runItemId : undefined,
        createdAt: existing?.createdAt
      })
    );
  });

  runtime.handle("review:startRun", async (event, input) => {
    const parsed = startReviewRunRequestSchema.parse(input);
    await confirmHostedReviewRun(services, runtime, parsed.reviewId);
    return reviewRunSchema.parse(await services.agent.start(parsed, senderEmitter(event)));
  });

  runtime.handle("review:cancelRun", (_event, input) => {
    const parsed = cancelReviewRunRequestSchema.parse(input);
    return cancelRunResponseSchema.parse({ cancelled: services.agent.cancel(parsed.runId) });
  });

  runtime.handle("review:retryRun", async (event, input) => {
    const parsed = retryReviewRunRequestSchema.parse(input);
    const run = services.db.getReviewRun(parsed.runId);
    if (!run) throw new Error(`Review run not found: ${parsed.runId}`);
    await confirmHostedReviewRun(services, runtime, run.reviewId);
    return reviewRunSchema.parse(await services.agent.retry(parsed.runId, senderEmitter(event)));
  });

  runtime.handle("review:listRuns", (_event, reviewIdInput) => {
    const reviewId = reviewIdSchema.parse(reviewIdInput);
    requireReview(services.db, reviewId);
    return z.array(reviewRunSchema).parse(services.db.listReviewRuns(reviewId));
  });

  runtime.handle("review:listRunItems", (_event, runIdInput) => {
    const runId = z.string().parse(runIdInput);
    if (!services.db.getReviewRun(runId)) throw new Error(`Review run not found: ${runId}`);
    return z.array(reviewRunItemSchema).parse(services.db.listReviewRunItems(runId));
  });

  runtime.handle("review:getSummary", (_event, input) => {
    const parsed = getReviewSummaryRequestSchema.parse(input);
    return reviewFlowSummarySchema.parse(services.db.getReviewFlowSummary(parsed.reviewId));
  });

  runtime.handle("review:fetchFullText", async (_event, input) => {
    const parsed = fetchReviewPaperFullTextRequestSchema.parse(input);
    const { paper } = requireReviewPaper(services.db, parsed);
    const result = await services.fullText.fetchOpenAccessPdf(parsed.projectId, paper);
    const artifact = result.artifact ? artifactSchema.parse(result.artifact) : undefined;
    if (artifact) {
      services.db.appendReviewAuditEvent({
        reviewId: parsed.reviewId,
        kind: "paper-pdf-attached",
        actor: "system",
        entityType: "paper",
        entityId: paper.id,
        payload: { artifactId: artifact.id, method: "open-access-fetch" }
      });
    }
    return fileActionResponseSchema.parse({
      ok: Boolean(artifact),
      artifactId: artifact?.id,
      warning: result.warning ?? (artifact ? undefined : "No trusted open-access PDF URL is available for this paper.")
    });
  });

  runtime.handle("review:attachPdf", async (_event, input) => {
    const parsed = attachReviewPaperPdfRequestSchema.parse(input);
    const { paper } = requireReviewPaper(services.db, parsed);
    const selection = await runtime.showOpenDialog({
      title: `Attach PDF — ${paper.title}`,
      properties: ["openFile"],
      filters: [{ name: "PDF documents", extensions: ["pdf"] }]
    });
    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) return fileActionResponseSchema.parse({ ok: false });
    try {
      await assertPdfFile(filePath);
      const artifact = artifactSchema.parse(
        await services.artifacts.importFile({
          projectId: parsed.projectId,
          type: "paper-pdf",
          title: paper.title,
          sourcePath: filePath,
          source: "review-pdf-attachment",
          metadata: {
            paperId: paper.id,
            doi: paper.doi,
            sourcePaperId: paper.sourcePaperId
          },
          indexText: true
        })
      );
      services.db.appendReviewAuditEvent({
        reviewId: parsed.reviewId,
        kind: "paper-pdf-attached",
        actor: "user",
        entityType: "paper",
        entityId: paper.id,
        payload: { artifactId: artifact.id, method: "manual-attachment" }
      });
      return fileActionResponseSchema.parse({ ok: true, artifactId: artifact.id });
    } catch (error) {
      throw redactSelectedPath(error, filePath);
    }
  });

  runtime.handle("review:export", async (_event, input) => {
    const parsed = exportReviewRequestSchema.parse(input);
    const review = requireReview(services.db, parsed.reviewId);
    const revision = services.db.getReviewProtocolRevision(review.id);
    if (!revision) throw new Error(`Current protocol revision not found for review: ${review.id}`);
    const project = services.db.getProject(review.projectId);
    if (!project) throw new Error(`Project not found: ${review.projectId}`);
    const selection = await runtime.showOpenDialog({
      title: "Export evidence review package",
      defaultPath: `${safeFilename(project.title)}-evidence-review`,
      properties: ["openDirectory", "createDirectory"]
    });
    const selectedDirectory = selection.filePaths[0];
    if (selection.canceled || !selectedDirectory) return exportResponseSchema.parse({ ok: false });

    const portabilityState = services.db.exportReviewPortabilityState(review.id);
    const flowSummary = reviewFlowSummarySchema.parse({
      ...services.db.getReviewFlowSummary(review.id),
      generatedAt: stableReviewStateTimestamp(portabilityState)
    });
    const includedPaperIds = currentEligibleIncludedPaperIds(portabilityState);
    const includedPapers = services.db.listPapers(review.projectId).filter((paper) => includedPaperIds.has(paper.id));
    const packageFiles = renderReviewExportPackage({
      protocol: reviewProtocolSchema.parse(review),
      revision: reviewProtocolRevisionSchema.parse(revision),
      revisions: portabilityState.revisions,
      batches: z.array(discoveryBatchSchema).parse(portabilityState.discoveryBatches),
      candidateOrigins: portabilityState.candidateOrigins,
      screeningDecisions: portabilityState.screeningDecisions,
      includedPapers: z.array(paperSchema).parse(includedPapers),
      includedPaperIds: [...includedPaperIds],
      extractionFields: z.array(extractionFieldSchema).parse(portabilityState.extractionFields),
      extractionFieldHistory: portabilityState.extractionFieldHistory ?? [],
      extractionValues: portabilityState.extractionValues,
      extractionValueHistory: portabilityState.extractionValueHistory ?? [],
      evidence: portabilityState.evidence,
      runs: z.array(reviewRunSchema).parse(portabilityState.runs),
      runItems: portabilityState.runItems,
      auditEvents: portabilityState.auditEvents,
      flowSummary
    });
    const suffix = flowSummary.generatedAt.replace(/[:.]/g, "-");
    const targetDirectory = await availableExportDirectory(
      join(selectedDirectory, `${safeFilename(project.title)}-evidence-review-${suffix}`)
    );
    await ensureDir(selectedDirectory);
    const stagingDirectory = await mkdtemp(join(selectedDirectory, ".paper-pilot-review-export-"));
    try {
      await Promise.all(
        [...packageFiles].map(([fileName, content]) => writeFile(join(stagingDirectory, fileName), content, "utf8"))
      );
      await rename(stagingDirectory, targetDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    return exportResponseSchema.parse({ ok: true, path: targetDirectory, fileCount: packageFiles.size });
  });
}

function stableReviewStateTimestamp(state: ReturnType<PaperPilotDb["exportReviewPortabilityState"]>): string {
  const timestamps = [
    state.review.activatedAt,
    state.review.createdAt,
    state.review.updatedAt,
    ...state.revisions.map((revision) => revision.createdAt),
    ...state.discoveryBatches.flatMap((batch) => [batch.createdAt, batch.completedAt]),
    ...state.candidateOrigins.map((origin) => origin.createdAt),
    ...state.rereviewFlags.flatMap((flag) => [flag.createdAt, flag.resolvedAt]),
    ...state.screeningDecisions.map((decision) => decision.createdAt),
    ...state.extractionFields.flatMap((field) => [field.createdAt, field.updatedAt]),
    ...(state.extractionFieldHistory ?? []).map((field) => field.recordedAt),
    ...state.extractionValues.flatMap((value) => [value.createdAt, value.updatedAt, value.confirmedAt]),
    ...(state.extractionValueHistory ?? []).map((value) => value.recordedAt),
    ...state.evidence.map((evidence) => evidence.createdAt),
    ...state.runs.flatMap((run) => [run.createdAt, run.updatedAt, run.startedAt, run.completedAt]),
    ...state.runItems.flatMap((item) => [item.createdAt, item.updatedAt, item.startedAt, item.completedAt]),
    ...state.auditEvents.map((event) => event.createdAt)
  ].filter((value): value is string => Boolean(value));
  return timestamps.sort().at(-1) ?? state.review.activatedAt;
}

async function availableExportDirectory(basePath: string): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? basePath : `${basePath}-${suffix}`;
    try {
      await stat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
  }
}

function electronReviewIpcRuntime(): ReviewIpcRuntime {
  return {
    handle: (channel, listener) => {
      electron.ipcMain.handle(channel, (event, input) => listener(event, input));
    },
    showOpenDialog: (options) => electron.dialog.showOpenDialog(options),
    showMessageBox: (options) => electron.dialog.showMessageBox(options)
  };
}

function parseReviewState(db: PaperPilotDb, protocolInput: ReviewProtocol) {
  const protocol = reviewProtocolSchema.parse(protocolInput);
  const revision = db.getReviewProtocolRevision(protocol.id, protocol.currentRevisionId);
  if (!revision) throw new Error(`Current protocol revision not found for review: ${protocol.id}`);
  return reviewStateSchema.parse({ protocol, revision });
}

function requireReview(db: PaperPilotDb, reviewId: string): ReviewProtocol {
  const review = db.getReviewById(reviewId);
  if (!review) throw new Error(`Review not found: ${reviewId}`);
  return reviewProtocolSchema.parse(review);
}

function requireReviewInProject(db: PaperPilotDb, reviewId: string, projectId: string): ReviewProtocol {
  const review = requireReview(db, reviewId);
  if (review.projectId !== projectId) throw new Error("Review not found in the selected project.");
  return review;
}

function requireReviewPaper(db: PaperPilotDb, input: { reviewId: string; projectId: string; paperId: string }) {
  const review = requireReviewInProject(db, input.reviewId, input.projectId);
  const paper = db.getPaper(input.projectId, input.paperId);
  if (!paper) throw new Error(`Paper not found in review project: ${input.paperId}`);
  return { review, paper: paperSchema.parse(paper) };
}

function senderEmitter(event: IpcMainInvokeEvent): (runEvent: ReviewRunEvent) => void {
  return (runEvent) => {
    const validated = reviewRunEventSchema.parse(runEvent);
    if (!event.sender.isDestroyed()) event.sender.send("review:run-event", validated);
  };
}

async function confirmHostedReviewRun(
  services: ReviewIpcServices,
  runtime: ReviewIpcRuntime,
  reviewId: string
): Promise<void> {
  const review = requireReview(services.db, reviewId);
  const project = services.db.getProject(review.projectId);
  if (!project) throw new Error(`Project not found: ${review.projectId}`);
  const settings = await services.settings.get();
  if (settings.ai.provider === "ollama" || !project.policy.warnOnPaidModelRuns) return;
  const confirmation = await runtime.showMessageBox({
    type: "warning",
    title: "Run hosted review assistance?",
    message: `This batch will use ${settings.ai.provider} with ${settings.ai.model}.`,
    detail:
      "The selected papers' review evidence will be sent to the configured hosted provider and may incur charges.",
    buttons: ["Cancel", "Run review"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (confirmation.response !== 1) throw new Error("Hosted review run cancelled before contacting the provider.");
}

async function assertPdfFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(5);
    const result = await handle.read(header, 0, header.length, 0);
    if (result.bytesRead < 5 || header.toString("ascii") !== "%PDF-") {
      throw new Error("The selected file is not a valid PDF document.");
    }
  } finally {
    await handle.close();
  }
}

function currentScreeningDecisions(decisions: readonly ScreeningDecision[]): ScreeningDecision[] {
  const current = new Map<string, ScreeningDecision>();
  for (const decision of decisions) current.set(`${decision.paperId}\u0000${decision.stage}`, decision);
  return [...current.values()];
}

/**
 * Keep package membership aligned with the review-flow summary and extraction
 * queue: a current full-text inclusion is only eligible while the current
 * title/abstract decision is also Include and no unresolved downstream
 * invalidation is open for full-text screening.
 */
function currentEligibleIncludedPaperIds(state: ReturnType<PaperPilotDb["exportReviewPortabilityState"]>): Set<string> {
  const currentDecisions = currentScreeningDecisions(state.screeningDecisions);
  const titleAbstractIncluded = new Set(
    currentDecisions
      .filter((decision) => decision.stage === "title-abstract" && decision.decision === "include")
      .map((decision) => decision.paperId)
  );
  const invalidatedFullText = new Set(
    state.rereviewFlags
      .filter(
        (flag) => flag.stage === "full-text" && flag.invalidatesDownstream === true && flag.resolvedAt === undefined
      )
      .map((flag) => flag.paperId)
  );
  return new Set(
    currentDecisions
      .filter(
        (decision) =>
          decision.stage === "full-text" &&
          decision.decision === "include" &&
          titleAbstractIncluded.has(decision.paperId) &&
          !invalidatedFullText.has(decision.paperId)
      )
      .map((decision) => decision.paperId)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function redactSelectedPath(error: unknown, selectedPath: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message.split(selectedPath).join("the selected file");
  return new Error(redacted);
}
