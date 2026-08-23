import type {
  AppSettings,
  ExtractionField,
  ReviewEvidence,
  ReviewExtractionSuggestion,
  ReviewRun,
  ReviewRunEvent,
  ReviewRunItem,
  ReviewStage,
  StartReviewRunRequest
} from "../../shared/schemas.js";
import { reviewRunEventSchema } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { id, nowIso } from "../utils.js";
import {
  formatReviewEvidence,
  fitReviewEvidenceBudget,
  parseReviewAgentJson,
  validateExtractionSuggestion,
  validateScreeningSuggestion,
  type ReviewAgentCriterion,
  type ReviewAgentEvidence,
  type ReviewAgentExtractionField
} from "./review-agent-utils.js";
import { collectReviewPaperEvidence } from "./review-evidence.js";
import type { CredentialService } from "./credential-service.js";
import { ResearchProvider, type ProviderChatInput, type ProviderChatResult } from "./research-provider.js";
import type { SettingsService } from "./settings-service.js";

type ReviewRunEmitter = (event: ReviewRunEvent) => void;

export interface ReviewProvider {
  chat(input: ProviderChatInput): Promise<ProviderChatResult>;
}

interface ActiveReviewRun {
  runId?: string;
  reviewId: string;
  projectId: string;
  controller: AbortController;
}

/**
 * Runs advisory review work independently of research chat. The service never
 * creates chat messages and never supplies model tools.
 */
export class ReviewAgentService {
  private readonly active = new Map<string, ActiveReviewRun>();
  private readonly provider: ReviewProvider;

  constructor(
    private readonly db: PaperPilotDb,
    private readonly settings: SettingsService,
    credentials: CredentialService,
    provider?: ReviewProvider
  ) {
    this.provider = provider ?? new ResearchProvider(credentials);
    this.db.markInterruptedReviewRuns();
  }

  async start(input: StartReviewRunRequest, emit: ReviewRunEmitter): Promise<ReviewRun> {
    const review = this.db.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const paperIds = [...new Set(input.paperIds)];
    if (paperIds.length !== input.paperIds.length) throw new Error("Review run paper IDs must be unique.");
    this.assertPapersEligible(review.id, review.projectId, input.stage, paperIds);
    if (input.stage !== "extraction" && input.fieldIds?.length) {
      throw new Error("Extraction fields may only be selected for extraction runs.");
    }
    const fieldIds = input.stage === "extraction" ? this.resolveExtractionFieldIds(review.id, input.fieldIds) : [];
    const reservation = this.reserveProject(review.id, review.projectId);
    try {
      const settings = await this.settings.get();
      const timestamp = nowIso();
      const run = this.db.saveReviewRun({
        id: id("review_run"),
        reviewId: review.id,
        stage: input.stage,
        provider: settings.ai.provider,
        model: settings.ai.model,
        protocolRevisionId: review.currentRevisionId,
        status: "queued",
        paperIds,
        fieldIds,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      for (const paperId of paperIds) {
        this.db.saveReviewRunItem(emptyRunItem(run.id, paperId, timestamp));
      }
      this.db.appendReviewAuditEvent({
        reviewId: review.id,
        kind: "run-started",
        actor: "user",
        entityType: "review-run",
        entityId: run.id,
        payload: { stage: run.stage, paperCount: run.paperIds.length, provider: run.provider, model: run.model }
      });
      this.launch(run, settings, fieldIds, emit, reservation);
      return run;
    } catch (error) {
      this.releaseProject(reservation);
      throw error;
    }
  }

  cancel(runId: string): boolean {
    const run = this.db.getReviewRun(runId);
    if (!run) return false;
    const review = this.db.getReviewById(run.reviewId);
    if (!review) return false;
    const active = this.active.get(review.projectId);
    if (!active || active.runId !== runId) return false;
    active.controller.abort(new DOMException("Review run cancelled by user.", "AbortError"));
    return true;
  }

  async retry(runId: string, emit: ReviewRunEmitter): Promise<ReviewRun> {
    const run = this.db.getReviewRun(runId);
    if (!run) throw new Error(`Review run not found: ${runId}`);
    if (!new Set<ReviewRun["status"]>(["failed", "partial", "cancelled"]).has(run.status)) {
      if (run.status === "completed") return run;
      throw new Error("Only failed, partial, or cancelled review runs can be retried.");
    }
    const review = this.db.getReviewById(run.reviewId);
    if (!review) throw new Error(`Review not found: ${run.reviewId}`);
    const retryable = this.db
      .listReviewRunItems(run.id)
      .filter((item) => item.status === "failed" || item.status === "cancelled");
    if (!retryable.length) return run;
    this.assertPapersEligible(
      review.id,
      review.projectId,
      run.stage,
      retryable.map((item) => item.paperId)
    );
    const reservation = this.reserveProject(review.id, review.projectId, run.id);
    try {
      const settings = await this.settings.get();
      if (settings.ai.provider !== run.provider || settings.ai.model !== run.model) {
        throw new Error(
          `Retry requires the original ${run.provider} model ${run.model}. Restore that global provider/model or start a new review batch.`
        );
      }
      const timestamp = nowIso();
      for (const item of retryable) {
        this.db.updateReviewRunItem(item.id, {
          status: "queued",
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
          updatedAt: timestamp
        });
      }
      const next = this.db.updateReviewRun(run.id, {
        status: "queued",
        failedCount: 0,
        cancelledCount: 0,
        error: undefined,
        completedAt: undefined
      });
      this.launch(next, settings, next.fieldIds, emit, reservation);
      return next;
    } catch (error) {
      this.releaseProject(reservation);
      throw error;
    }
  }

  isProjectActive(projectId: string): boolean {
    return this.active.has(projectId);
  }

  private reserveProject(reviewId: string, projectId: string, runId?: string): ActiveReviewRun {
    if (this.active.has(projectId)) throw new Error("This project already has an active review run.");
    const reservation = { runId, reviewId, projectId, controller: new AbortController() };
    this.active.set(projectId, reservation);
    return reservation;
  }

  private releaseProject(reservation: ActiveReviewRun): void {
    if (this.active.get(reservation.projectId) === reservation) this.active.delete(reservation.projectId);
  }

  private launch(
    run: ReviewRun,
    settings: AppSettings,
    fieldIds: string[] | undefined,
    emit: ReviewRunEmitter,
    reservation: ActiveReviewRun
  ): void {
    const review = this.db.getReviewById(run.reviewId)!;
    if (this.active.get(review.projectId) !== reservation || reservation.reviewId !== run.reviewId) {
      throw new Error("The review run lost its project reservation before launch.");
    }
    reservation.runId = run.id;
    queueMicrotask(() => {
      void this.execute(run.id, settings, fieldIds, reservation.controller, emit, reservation)
        .catch((error: unknown) => this.finalizeUnexpectedFailure(run.id, error, emit, reservation))
        .finally(() => this.releaseProject(reservation));
    });
  }

  private finalizeUnexpectedFailure(
    runId: string,
    error: unknown,
    emit: ReviewRunEmitter,
    reservation: ActiveReviewRun
  ): void {
    const message = `Review run stopped unexpectedly. ${safeError(error)}`;
    try {
      const current = this.db.getReviewRun(runId);
      if (!current || !new Set<ReviewRun["status"]>(["queued", "running"]).has(current.status)) return;
      for (const item of this.db
        .listReviewRunItems(runId)
        .filter((candidate) => candidate.status === "queued" || candidate.status === "running")) {
        this.db.updateReviewRunItem(item.id, {
          status: "failed",
          error: message,
          completedAt: nowIso()
        });
      }
      const counted = this.refreshRunCounts(runId);
      const status: ReviewRun["status"] = counted.completedCount > 0 ? "partial" : "failed";
      const failed = this.db.updateReviewRun(runId, {
        status,
        error: message,
        completedAt: nowIso()
      });
      this.db.appendReviewAuditEvent({
        reviewId: failed.reviewId,
        kind: "run-completed",
        actor: "system",
        entityType: "review-run",
        entityId: failed.id,
        payload: { status, unexpectedFailure: true, error: message }
      });
      this.releaseProject(reservation);
      emitValidated(emit, {
        type: "error",
        runId: failed.id,
        reviewId: failed.reviewId,
        status: "failed",
        error: message
      });
      emitValidated(emit, { type: "complete", runId: failed.id, reviewId: failed.reviewId, run: failed });
    } catch {
      try {
        const current = this.db.getReviewRun(runId);
        if (current) {
          emitValidated(emit, {
            type: "error",
            runId: current.id,
            reviewId: current.reviewId,
            status: "failed",
            error: message
          });
        }
      } catch {
        // The database itself is unavailable; the startup recovery pass will finalize the row on next launch.
      }
    }
  }

  private async execute(
    runId: string,
    settings: AppSettings,
    fieldIds: string[] | undefined,
    controller: AbortController,
    emit: ReviewRunEmitter,
    reservation: ActiveReviewRun
  ): Promise<void> {
    let run = this.db.updateReviewRun(runId, { status: "running", startedAt: nowIso() });
    emitValidated(emit, { type: "status", runId: run.id, reviewId: run.reviewId, status: "running" });
    const review = this.db.getReviewById(run.reviewId)!;
    const revision = this.db.getReviewProtocolRevision(run.reviewId, run.protocolRevisionId);
    if (!revision) throw new Error(`Protocol revision not found: ${run.protocolRevisionId}`);
    const items = this.db.listReviewRunItems(run.id).filter((item) => item.status === "queued");

    for (let index = 0; index < items.length; index += 1) {
      if (controller.signal.aborted) break;
      const item = items[index];
      emitValidated(emit, progressEvent(run, item.paperId));
      if (controller.signal.aborted) break;
      try {
        const completed = await this.processItem({
          run,
          item,
          projectId: review.projectId,
          settings,
          fieldIds,
          signal: controller.signal
        });
        emitValidated(emit, { type: "item", runId: run.id, reviewId: run.reviewId, item: completed });
      } catch (error) {
        const cancelled = controller.signal.aborted || isAbortError(error);
        const recordedAttempts = this.db.getReviewRunItem(item.id)?.attemptCount ?? item.attemptCount;
        const failed = this.db.updateReviewRunItem(item.id, {
          status: cancelled ? "cancelled" : "failed",
          attemptCount: recordedAttempts,
          error: cancelled ? "Review run cancelled by user." : safeError(error),
          completedAt: nowIso()
        });
        emitValidated(emit, { type: "item", runId: run.id, reviewId: run.reviewId, item: failed });
        if (cancelled) break;
      }
      run = this.refreshRunCounts(run.id);
      emitValidated(emit, progressEvent(run));
    }

    if (controller.signal.aborted) {
      for (const item of this.db.listReviewRunItems(run.id).filter((candidate) => candidate.status === "queued")) {
        this.db.updateReviewRunItem(item.id, {
          status: "cancelled",
          error: "Review run cancelled before processing began.",
          completedAt: nowIso()
        });
      }
    }
    run = this.refreshRunCounts(run.id);
    const total = run.paperIds.length;
    const status: ReviewRun["status"] = controller.signal.aborted
      ? "cancelled"
      : run.failedCount === total
        ? "failed"
        : run.failedCount > 0 || run.cancelledCount > 0
          ? "partial"
          : "completed";
    run = this.db.updateReviewRun(run.id, {
      status,
      error: status === "failed" ? "Every selected paper failed review assistance." : undefined,
      completedAt: nowIso()
    });
    this.db.appendReviewAuditEvent({
      reviewId: run.reviewId,
      kind: status === "cancelled" ? "run-cancelled" : "run-completed",
      actor: status === "cancelled" ? "user" : "ai",
      entityType: "review-run",
      entityId: run.id,
      payload: {
        status,
        completedCount: run.completedCount,
        failedCount: run.failedCount,
        cancelledCount: run.cancelledCount
      }
    });
    this.releaseProject(reservation);
    emitValidated(emit, progressEvent(run));
    if (status === "failed" || status === "cancelled") {
      emitValidated(emit, {
        type: "error",
        runId: run.id,
        reviewId: run.reviewId,
        error: status === "cancelled" ? "Review run cancelled by user." : (run.error ?? "Review run failed."),
        status
      });
    }
    emitValidated(emit, { type: "complete", runId: run.id, reviewId: run.reviewId, run });
  }

  private async processItem(input: {
    run: ReviewRun;
    item: ReviewRunItem;
    projectId: string;
    settings: AppSettings;
    fieldIds: string[] | undefined;
    signal: AbortSignal;
  }): Promise<ReviewRunItem> {
    const timestamp = nowIso();
    let item = this.db.updateReviewRunItem(input.item.id, {
      status: "running",
      attemptCount: input.item.attemptCount,
      startedAt: timestamp,
      error: undefined
    });
    const paper = this.db.getPaper(input.projectId, item.paperId);
    if (!paper) throw new Error(`Paper not found: ${item.paperId}`);
    const revision = this.db.getReviewProtocolRevision(input.run.reviewId, input.run.protocolRevisionId)!;
    const evidence = fitReviewEvidenceBudget(
      collectReviewPaperEvidence({
        db: this.db,
        projectId: input.projectId,
        paperId: item.paperId,
        stage: input.run.stage,
        query: `${revision.researchQuestion}\n${revision.objectives.join("\n")}`,
        limit: 12
      }),
      input.settings.ai.provider
    );
    const storedEvidence = evidence.map((entry) => toStoredEvidence(input.run, item.id, paper, entry, timestamp));

    if (input.run.stage === "extraction") {
      const allFields = this.db.listExtractionFields(input.run.reviewId);
      const selected = input.fieldIds?.length
        ? allFields.filter((field) => input.fieldIds!.includes(field.id))
        : allFields;
      if (!selected.length) throw new Error("No active extraction fields were selected.");
      let providerAttempts = 0;
      const suggestions = evidence.length
        ? await this.extractInGroups(input, selected, evidence, () => {
            providerAttempts += 1;
            this.db.updateReviewRunItem(item.id, {
              attemptCount: input.item.attemptCount + providerAttempts
            });
          })
        : selected.map(notFoundSuggestion);
      item = this.db.updateReviewRunItem(item.id, {
        status: "completed",
        attemptCount: input.item.attemptCount + providerAttempts,
        extractionSuggestions: suggestions,
        evidence: storedEvidence,
        completedAt: nowIso()
      });
      for (const suggestion of suggestions) {
        this.db.saveExtractionValue({
          reviewId: input.run.reviewId,
          paperId: item.paperId,
          fieldId: suggestion.fieldId,
          value: suggestion.value,
          // A model can recommend that a field is not found, but only a reviewer
          // can accept that as a completed extraction state.
          status: suggestion.status === "not-found" ? "suggested" : suggestion.status,
          origin: "ai",
          evidenceIds: suggestion.evidenceIds
            .map((evidenceId) => storedEvidence.find((entry) => entry.evidenceId === evidenceId)?.id)
            .filter((value): value is string => Boolean(value)),
          runItemId: item.id
        });
      }
      return item;
    }

    const criteria: ReviewAgentCriterion[] = revision.criteria
      .filter((criterion) => criterion.stage === input.run.stage)
      .map((criterion) => ({
        id: criterion.id,
        kind: criterion.type,
        text: `${criterion.label}${criterion.description ? ` — ${criterion.description}` : ""}`
      }));
    if (!evidence.length) {
      return this.db.updateReviewRunItem(item.id, {
        status: "completed",
        suggestedDecision: "uncertain",
        rationale:
          input.run.stage === "title-abstract"
            ? "No abstract or usable metadata is available."
            : "No trusted indexed full text is available for this paper.",
        evidence: [],
        completedAt: nowIso()
      });
    }
    let providerAttempts = 0;
    const result = await this.requestAndValidate(
      input.settings,
      screeningPrompt(input.run.stage, revision.researchQuestion, revision.objectives, criteria, evidence),
      (value) => validateScreeningSuggestion({ value, criteria, evidence, paperId: paper.id }),
      input.signal,
      () => {
        providerAttempts += 1;
        this.db.updateReviewRunItem(item.id, {
          attemptCount: input.item.attemptCount + providerAttempts
        });
      }
    );
    const reasonCriterionId = exclusionReason(result.value.assessments, criteria);
    return this.db.updateReviewRunItem(item.id, {
      status: "completed",
      attemptCount: input.item.attemptCount + result.attempts,
      suggestedDecision: result.value.decision,
      suggestedReasonCriterionId: result.value.decision === "exclude" ? reasonCriterionId : undefined,
      suggestedCustomReason:
        result.value.decision === "exclude" && !reasonCriterionId
          ? "AI suggested exclusion; reviewer must choose a reason."
          : undefined,
      rationale: result.value.rationale,
      criterionAssessments: result.value.assessments,
      evidence: storedEvidence,
      completedAt: nowIso()
    });
  }

  private async extractInGroups(
    input: {
      run: ReviewRun;
      item: ReviewRunItem;
      settings: AppSettings;
      signal: AbortSignal;
    },
    fields: ExtractionField[],
    evidence: ReviewAgentEvidence[],
    onProviderAttempt: () => void
  ): Promise<ReviewExtractionSuggestion[]> {
    const revision = this.db.getReviewProtocolRevision(input.run.reviewId, input.run.protocolRevisionId)!;
    const suggestions: ReviewExtractionSuggestion[] = [];
    for (let offset = 0; offset < fields.length; offset += 6) {
      const group = fields.slice(offset, offset + 6);
      const agentFields: ReviewAgentExtractionField[] = group.map((field) => ({
        id: field.id,
        type: field.type,
        options: field.options
      }));
      const result = await this.requestAndValidate(
        input.settings,
        extractionPrompt(revision.researchQuestion, group, evidence),
        (value) => validateExtractionSuggestion({ value, fields: agentFields, evidence, paperId: input.item.paperId }),
        input.signal,
        onProviderAttempt
      );
      for (const value of result.value.values) {
        suggestions.push({
          fieldId: value.fieldId,
          value: value.status === "found" ? (value.value as ReviewExtractionSuggestion["value"]) : null,
          status: value.status === "found" ? "suggested" : value.status === "unclear" ? "needs-review" : "not-found",
          evidenceIds: value.status === "found" || value.status === "unclear" ? value.evidenceIds : [],
          rationale: value.note
        });
      }
    }
    return suggestions;
  }

  private async requestAndValidate<T>(
    settings: AppSettings,
    prompt: string,
    validate: (value: unknown) => T,
    signal: AbortSignal,
    onAttempt?: () => void
  ): Promise<{ value: T; attempts: number }> {
    let invalidOutput = "";
    let validationError = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const messages =
        attempt === 1
          ? [{ role: "user" as const, content: prompt }]
          : [
              { role: "user" as const, content: prompt },
              { role: "assistant" as const, content: invalidOutput },
              {
                role: "user" as const,
                content: `The previous JSON was invalid: ${validationError}. Return one corrected JSON object only.`
              }
            ];
      onAttempt?.();
      const response = await this.provider.chat({
        settings,
        system: reviewSystemPrompt(),
        messages,
        signal,
        onDelta: () => undefined
      });
      invalidOutput = response.content;
      try {
        return { value: validate(parseReviewAgentJson(response.content)), attempts: attempt };
      } catch (error) {
        validationError = safeError(error);
        if (attempt === 2) {
          throw new Error(`Review response validation failed after one repair attempt. ${validationError}`, {
            cause: error
          });
        }
      }
    }
    throw new Error("Review response validation failed.");
  }

  private refreshRunCounts(runId: string): ReviewRun {
    const items = this.db.listReviewRunItems(runId);
    return this.db.updateReviewRun(runId, {
      completedCount: items.filter((item) => item.status === "completed").length,
      failedCount: items.filter((item) => item.status === "failed").length,
      cancelledCount: items.filter((item) => item.status === "cancelled").length
    });
  }

  private assertPapersEligible(reviewId: string, projectId: string, stage: ReviewStage, paperIds: string[]): void {
    for (const paperId of paperIds) {
      if (!this.db.getPaper(projectId, paperId)) throw new Error(`Paper not found in review project: ${paperId}`);
      if (
        (stage === "full-text" || stage === "extraction") &&
        this.db.getCurrentScreeningDecision(reviewId, paperId, "title-abstract")?.decision !== "include"
      ) {
        throw new Error(
          `${stage === "extraction" ? "Extraction" : "Full-text"} assistance is limited to papers currently included during title/abstract screening.`
        );
      }
      if (
        stage === "extraction" &&
        this.db.getCurrentScreeningDecision(reviewId, paperId, "full-text")?.decision !== "include"
      ) {
        throw new Error("Extraction assistance is limited to papers included during full-text screening.");
      }
    }
  }

  private resolveExtractionFieldIds(reviewId: string, requested: string[] | undefined): string[] {
    const activeIds = this.db.listExtractionFields(reviewId).map((field) => field.id);
    const selected = requested?.length ? [...new Set(requested)] : activeIds;
    if (!selected.length) throw new Error("At least one active extraction field is required.");
    if (requested && selected.length !== requested.length) throw new Error("Extraction field IDs must be unique.");
    const active = new Set(activeIds);
    const unknown = selected.find((fieldId) => !active.has(fieldId));
    if (unknown) throw new Error(`Active extraction field not found: ${unknown}`);
    return selected;
  }
}

function emptyRunItem(runId: string, paperId: string, timestamp: string): ReviewRunItem {
  return {
    id: id("review_item"),
    runId,
    paperId,
    status: "queued",
    attemptCount: 0,
    criterionAssessments: [],
    extractionSuggestions: [],
    evidence: [],
    stale: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function toStoredEvidence(
  run: ReviewRun,
  runItemId: string,
  paper: { id: string; title: string; doi?: string; url?: string },
  evidence: ReviewAgentEvidence,
  createdAt: string
): ReviewEvidence {
  return {
    id: id("review_evidence"),
    reviewId: run.reviewId,
    evidenceId: evidence.evidenceId,
    runId: run.id,
    runItemId,
    paperId: evidence.paperId,
    artifactId: evidence.artifactId,
    chunkId: evidence.chunkId,
    sourceType:
      evidence.sourceType === "artifact"
        ? "artifact-chunk"
        : evidence.locator === "Abstract"
          ? "paper-abstract"
          : "paper-metadata",
    title: evidence.title || paper.title,
    excerpt: evidence.excerpt,
    locator: evidence.locator,
    page: evidence.page,
    doi: paper.doi,
    url: paper.url,
    createdAt
  };
}

function reviewSystemPrompt(): string {
  return [
    "You are an advisory evidence-review assistant.",
    "Use only the supplied evidence for this paper and return exactly one JSON object.",
    "Never make a human screening decision, invent evidence, or reveal hidden reasoning.",
    "When evidence is insufficient, use uncertain or not-found as instructed."
  ].join("\n");
}

function screeningPrompt(
  stage: Exclude<ReviewStage, "extraction">,
  question: string,
  objectives: string[],
  criteria: ReviewAgentCriterion[],
  evidence: ReviewAgentEvidence[]
): string {
  return [
    `Stage: ${stage}`,
    `Research question: ${question || "Not specified"}`,
    `Objectives: ${objectives.length ? objectives.join("; ") : "Not specified"}`,
    "Criteria:",
    ...criteria.map((criterion) => `- ${criterion.id} (${criterion.kind}): ${criterion.text}`),
    "Evidence:",
    formatReviewEvidence(evidence),
    "Return JSON with decision (include|exclude|uncertain), rationale, and assessments.",
    "Each assessment must contain criterionId, assessment (met|not-met|unclear), explanation, and evidenceIds.",
    "Assess every criterion exactly once. Non-unclear assessments require evidence IDs."
  ].join("\n\n");
}

function extractionPrompt(question: string, fields: ExtractionField[], evidence: ReviewAgentEvidence[]): string {
  return [
    `Research question: ${question || "Not specified"}`,
    "Extraction fields:",
    ...fields.map(
      (field) =>
        `- ${field.id}: ${field.name} (${field.type})${field.options.length ? `; options: ${field.options.join(", ")}` : ""}${field.description ? ` — ${field.description}` : ""}`
    ),
    "Evidence:",
    formatReviewEvidence(evidence),
    "Return JSON with a values array. Include every field exactly once.",
    "Each item must contain fieldId, status (found|not-found|unclear), value when found, evidenceIds, and optional note.",
    "Found values require current-paper evidence. Never infer a value that is not stated in the evidence."
  ].join("\n\n");
}

function exclusionReason(
  assessments: Array<{ criterionId: string; assessment: "met" | "not-met" | "unclear" }>,
  criteria: ReviewAgentCriterion[]
): string | undefined {
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  return assessments.find((assessment) => {
    const criterion = byId.get(assessment.criterionId);
    return criterion?.kind === "exclusion" ? assessment.assessment === "met" : assessment.assessment === "not-met";
  })?.criterionId;
}

function notFoundSuggestion(field: ExtractionField): ReviewExtractionSuggestion {
  return {
    fieldId: field.id,
    value: null,
    status: "not-found",
    evidenceIds: [],
    rationale: "No trusted indexed full text is available for this paper."
  };
}

function progressEvent(run: ReviewRun, currentPaperId?: string): ReviewRunEvent {
  return {
    type: "progress",
    runId: run.id,
    reviewId: run.reviewId,
    completed: run.completedCount,
    failed: run.failedCount,
    cancelled: run.cancelledCount,
    total: run.paperIds.length,
    currentPaperId
  };
}

function emitValidated(emit: ReviewRunEmitter, event: ReviewRunEvent): void {
  emit(reviewRunEventSchema.parse(event));
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 4_000);
  return String(error).slice(0, 4_000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}
