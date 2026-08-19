import type {
  AppSettings,
  ChatRun,
  ChatRunEvent,
  ChatTraceStep,
  Citation,
  StartChatRunRequest,
  StartChatRunResponse
} from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { id, nowIso } from "../utils.js";
import type { ArtifactService } from "./artifact-service.js";
import type { AiService } from "./ai-service.js";
import type { CredentialService } from "./credential-service.js";
import type { CrawlService } from "./crawl-service.js";
import type { JobQueue } from "./job-queue.js";
import {
  answerArtifactMarkdown,
  buildRecentContext,
  citationsForAnswer,
  collectResearchEvidence,
  deriveConversationTitle,
  formatEvidenceBundle,
  validateResearchCitations
} from "./research-grounding.js";
import { ResearchProvider } from "./research-provider.js";
import type { SettingsService } from "./settings-service.js";
import type { SourceRegistry } from "../sources/registry.js";

type RunEmitter = (event: ChatRunEvent) => void;

export class ResearchChatService {
  private readonly active = new Map<string, { runId: string; controller: AbortController }>();
  private readonly provider: ResearchProvider;

  constructor(
    private readonly db: PaperPilotDb,
    private readonly artifacts: ArtifactService,
    private readonly settings: SettingsService,
    credentials: CredentialService,
    private readonly registry?: SourceRegistry,
    private readonly crawl?: CrawlService,
    private readonly ai?: AiService,
    private readonly jobs?: JobQueue
  ) {
    this.provider = new ResearchProvider(credentials);
    this.db.markInterruptedChatRuns();
  }

  async start(input: StartChatRunRequest, emit: RunEmitter): Promise<StartChatRunResponse> {
    const project = this.db.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const conversation = this.db.getConversation(input.conversationId);
    if (!conversation || conversation.projectId !== input.projectId) {
      throw new Error(`Conversation not found in project: ${input.conversationId}`);
    }
    if (this.active.has(input.conversationId)) {
      throw new Error("This conversation already has an active response. Stop it before sending another message.");
    }

    const appSettings = await this.settings.get();
    const mode = input.mode ?? conversation.mode;
    this.db.updateConversation(conversation.id, {
      mode,
      title: conversation.title === "New chat" ? deriveConversationTitle(input.content) : conversation.title
    });

    const runId = id("run");
    const userMessage = this.db.appendMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId,
      role: "user",
      content: input.content,
      metadata: { mode, sourceRefs: input.sourceRefs }
    });
    const assistantMessage = this.db.appendMessage({
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId,
      role: "assistant",
      content: "",
      status: "streaming",
      metadata: { mode, provider: appSettings.ai.provider, model: appSettings.ai.model }
    });
    const timestamp = nowIso();
    const run = this.db.saveChatRun({
      id: runId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      provider: appSettings.ai.provider,
      model: appSettings.ai.model,
      mode,
      status: "queued",
      sourceRefs: input.sourceRefs,
      includedMessageCount: 0,
      omittedMessageCount: 0,
      trace: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const controller = new AbortController();
    this.active.set(input.conversationId, { runId, controller });
    setTimeout(() => {
      void this.execute(input, appSettings, run, assistantMessage.id, controller, emit).finally(() => {
        const active = this.active.get(input.conversationId);
        if (active?.runId === runId) this.active.delete(input.conversationId);
      });
    }, 10);
    return { runId, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
  }

  cancel(runId: string): boolean {
    for (const active of this.active.values()) {
      if (active.runId !== runId) continue;
      active.controller.abort(new DOMException("Response stopped by user.", "AbortError"));
      return true;
    }
    return false;
  }

  isConversationActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  isProjectActive(projectId: string): boolean {
    return [...this.active.keys()].some(
      (conversationId) => this.db.getConversation(conversationId)?.projectId === projectId
    );
  }

  private async execute(
    input: StartChatRunRequest,
    settings: AppSettings,
    initialRun: ChatRun,
    assistantMessageId: string,
    controller: AbortController,
    emit: RunEmitter
  ): Promise<void> {
    let run = this.db.saveChatRun({ ...initialRun, status: "running", updatedAt: nowIso() });
    let streamedContent = "";
    safeEmit(emit, { type: "status", runId: run.id, status: "running" });

    const trace = (step: Omit<ChatTraceStep, "id" | "startedAt">): void => {
      const timestamp = nowIso();
      const next: ChatTraceStep = {
        id: id("trace"),
        startedAt: timestamp,
        completedAt: step.status === "running" || step.status === "waiting" ? undefined : timestamp,
        ...step
      };
      run = this.db.saveChatRun({ ...run, trace: [...run.trace, next], updatedAt: timestamp });
      safeEmit(emit, { type: "trace", runId: run.id, step: next });
    };

    try {
      const toolResponse = await this.runAppOwnedTool(input, run.id, trace);
      if (toolResponse) {
        await this.completeRun(run, assistantMessageId, toolResponse, [], input, emit, trace);
        return;
      }
      trace({
        kind: "retrieval",
        status: "running",
        label: input.sourceRefs.length
          ? `Searching ${input.sourceRefs.length} pinned sources`
          : "Searching trusted project sources"
      });
      const evidence = collectResearchEvidence(this.db, input.projectId, input.content, input.sourceRefs);
      trace({
        kind: "retrieval",
        status: "completed",
        label: `Retrieved ${evidence.length} evidence ${evidence.length === 1 ? "entry" : "entries"}`,
        detail: evidence.length
          ? evidence
              .map((entry) => entry.title)
              .slice(0, 5)
              .join("; ")
          : undefined
      });

      if (run.mode === "grounded" && evidence.length === 0) {
        const content = [
          "## Insufficient project evidence",
          "",
          "I couldn't find trusted project sources that support an answer to this request.",
          "",
          "Try removing source pins, importing a relevant PDF or document, or starting a scholarly-source crawl."
        ].join("\n");
        await this.completeRun(run, assistantMessageId, content, [], input, emit, trace);
        return;
      }

      const evidenceBundle = formatEvidenceBundle(evidence);
      const system = researchSystemPrompt(run.mode, evidenceBundle);
      const history = buildRecentContext(
        this.db
          .listMessages(input.projectId, input.conversationId)
          .filter((message) => message.id !== assistantMessageId),
        settings.ai.provider,
        `${system}\n${input.content}`
      );
      run = this.db.saveChatRun({
        ...run,
        includedMessageCount: history.included,
        omittedMessageCount: history.omitted,
        updatedAt: nowIso()
      });
      trace({
        kind: "context",
        status: "completed",
        label: `Using ${history.included} conversation ${history.included === 1 ? "message" : "messages"}`,
        detail: history.omitted ? `${history.omitted} older messages are outside the active context.` : undefined
      });

      trace({
        kind: "provider",
        status: "running",
        label: `Calling ${providerLabel(settings.ai.provider)} · ${settings.ai.model}`
      });
      let content = await this.provider.stream({
        settings,
        system,
        messages: history.messages.map(({ role, content }) => ({ role, content })),
        signal: controller.signal,
        onDelta: (text) => {
          streamedContent += text;
          safeEmit(emit, { type: "delta", runId: run.id, text });
        }
      });
      if (!content.trim()) throw new Error("The configured model returned an empty response.");
      trace({ kind: "provider", status: "completed", label: "Model response received" });

      let validation = validateResearchCitations(content, evidence, run.mode === "grounded");
      if (!validation.valid) {
        trace({
          kind: "citation",
          status: "running",
          label: "Repairing citation coverage",
          detail: citationProblemDetail(validation)
        });
        content = await this.repairCitations(settings, system, content, validation, controller.signal);
        validation = validateResearchCitations(content, evidence, run.mode === "grounded");
      }
      if (!validation.valid) {
        trace({ kind: "citation", status: "failed", label: "Citation validation failed" });
        throw new Error(`Citation validation failed after one repair attempt. ${citationProblemDetail(validation)}`);
      }
      trace({
        kind: "citation",
        status: "completed",
        label: `Validated ${validation.referencedIds.length} citation ${validation.referencedIds.length === 1 ? "reference" : "references"}`
      });
      const citations = citationsForAnswer(run.id, assistantMessageId, validation.referencedIds, evidence);
      await this.completeRun(run, assistantMessageId, content, citations, input, emit, trace);
    } catch (error) {
      const stopped = controller.signal.aborted || isAbortError(error);
      const errorText = stopped ? "Response stopped by user." : error instanceof Error ? error.message : String(error);
      const content = stopped
        ? streamedContent
        : run.mode === "grounded"
          ? `I couldn't complete a citation-valid grounded answer.\n\n${errorText}`
          : `I couldn't complete this answer.\n\n${errorText}`;
      this.db.updateMessage(assistantMessageId, {
        content,
        status: stopped ? "stopped" : "failed",
        metadata: { mode: run.mode, provider: run.provider, model: run.model, error: errorText }
      });
      run = this.db.saveChatRun({
        ...run,
        status: stopped ? "stopped" : "failed",
        error: errorText,
        updatedAt: nowIso()
      });
      safeEmit(emit, { type: "error", runId: run.id, error: errorText, status: stopped ? "stopped" : "failed" });
    }
  }

  private async runAppOwnedTool(
    input: StartChatRunRequest,
    runId: string,
    trace: (step: Omit<ChatTraceStep, "id" | "startedAt">) => void
  ): Promise<string | undefined> {
    const content = input.content.trim();
    const lower = content.toLowerCase();
    if (this.registry && /\b(list|show)\b[\s\S]*\b(sources|providers)\b/.test(lower)) {
      const toolRunId = this.db.createToolRun(input.projectId, runId, "list_sources", {});
      trace({ kind: "tool", status: "running", label: "Listing scholarly sources", toolName: "list_sources" });
      const sources = this.registry.list();
      this.db.finishToolRun(toolRunId, "completed", { sourceCount: sources.length });
      trace({
        kind: "tool",
        status: "completed",
        label: `Listed ${sources.length} scholarly sources`,
        toolName: "list_sources"
      });
      return [
        "## Scholarly sources",
        "",
        ...sources.map((source) => `- **${source.displayName}** — ${source.description}`)
      ].join("\n");
    }

    if (this.ai && /\b(generate|create|write)\b[\s\S]*\b(research )?brief\b/.test(lower)) {
      const toolRunId = this.db.createToolRun(input.projectId, runId, "generate_research_brief", {
        prompt: content.slice(0, 500)
      });
      trace({
        kind: "tool",
        status: "running",
        label: "Generating research brief",
        toolName: "generate_research_brief"
      });
      let result: Awaited<ReturnType<AiService["generateResearchBrief"]>>;
      try {
        result = await this.ai.generateResearchBrief(input.projectId, content);
        this.db.finishToolRun(toolRunId, "completed", { artifactId: result.artifactId, jobId: result.jobId });
      } catch (error) {
        this.db.finishToolRun(toolRunId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
      trace({
        kind: "tool",
        status: "completed",
        label: "Research brief created",
        detail: `Artifact ${result.artifactId}`,
        toolName: "generate_research_brief"
      });
      return [
        "## Research brief created",
        "",
        "The full research brief is available in the project Artifacts panel.",
        "",
        `Artifact ID: ${result.artifactId}`
      ].join("\n");
    }

    const wantsCrawl =
      /\b(crawl|collect|gather)\b/.test(lower) ||
      /\b(search|find)\b[\s\S]*\b(new|more|external)\b[\s\S]*\b(papers?|literature|studies)\b/.test(lower);
    if (this.crawl && wantsCrawl) {
      const project = this.db.getProject(input.projectId)!;
      const topic = inferCrawlTopic(content, project.topic || project.title);
      const toolRunId = this.db.createToolRun(input.projectId, runId, "run_crawl", {
        topic,
        maxPapers: Math.min(project.policy.maxCrawlPapers, 25)
      });
      trace({ kind: "tool", status: "running", label: "Preparing scholarly-source crawl", toolName: "run_crawl" });
      let result: Awaited<ReturnType<CrawlService["runCrawl"]>>;
      try {
        result = await this.crawl.runCrawl(
          input.projectId,
          {
            topic,
            maxPapers: Math.min(project.policy.maxCrawlPapers, 25)
          },
          { approved: false }
        );
      } catch (error) {
        this.db.finishToolRun(toolRunId, "failed", undefined, error instanceof Error ? error.message : String(error));
        throw error;
      }
      const job = this.jobs?.get(result.jobId);
      const waiting = job?.status === "waiting-approval";
      this.db.finishToolRun(toolRunId, waiting ? "waiting" : "completed", {
        jobId: result.jobId,
        paperCount: result.papers.length,
        artifactCount: result.artifacts.length
      });
      trace({
        kind: "tool",
        status: waiting ? "waiting" : "completed",
        label: waiting ? "Crawl is waiting for approval" : "Crawl completed",
        detail: `${result.papers.length} papers retained`,
        toolName: "run_crawl"
      });
      return waiting
        ? "I prepared a scholarly-source crawl. Review and approve it in the job panel before Paper Pilot contacts external sources."
        : `The crawl retained ${result.papers.length} papers and created ${result.artifacts.length} project artifacts.`;
    }
    return undefined;
  }

  private async completeRun(
    run: ChatRun,
    assistantMessageId: string,
    content: string,
    citations: Citation[],
    input: StartChatRunRequest,
    emit: RunEmitter,
    trace: (step: Omit<ChatTraceStep, "id" | "startedAt">) => void
  ): Promise<void> {
    const message = this.db.updateMessage(assistantMessageId, {
      content,
      status: "completed",
      metadata: {
        mode: run.mode,
        provider: run.provider,
        model: run.model,
        citationIds: citations.map((citation) => citation.id),
        sourceRefs: input.sourceRefs
      }
    });
    this.db.replaceCitations(run.id, citations);
    const conversation = this.db.getConversation(run.conversationId)!;
    trace({ kind: "artifact", status: "running", label: "Saving generated answer" });
    const existing = this.db.getChatRun(run.id)?.outputArtifactId;
    const recoveredArtifact = this.db
      .listArtifacts(run.projectId)
      .find((candidate) => candidate.type === "chat-answer" && candidate.metadata.runId === run.id);
    const artifact =
      existing || recoveredArtifact
        ? existing
          ? this.db.getArtifact(run.projectId, existing)
          : recoveredArtifact
        : await this.artifacts.writeArtifact({
            projectId: run.projectId,
            type: "chat-answer",
            title: `Answer — ${deriveConversationTitle(input.content)}`,
            content: answerArtifactMarkdown({
              content,
              prompt: input.content,
              mode: run.mode,
              provider: run.provider,
              model: run.model,
              conversationTitle: conversation.title,
              citations,
              sourceRefs: input.sourceRefs
            }),
            source: "research-chat",
            metadata: {
              runId: run.id,
              messageId: assistantMessageId,
              conversationId: run.conversationId,
              mode: run.mode,
              provider: run.provider,
              model: run.model,
              sourceRefs: input.sourceRefs,
              citations
            },
            indexText: false
          });
    trace({ kind: "artifact", status: "completed", label: "Generated answer saved" });
    const completed = this.db.saveChatRun({
      ...(this.db.getChatRun(run.id) ?? run),
      outputArtifactId: artifact?.id,
      status: "completed",
      error: undefined,
      updatedAt: nowIso()
    });
    safeEmit(emit, {
      type: "complete",
      runId: run.id,
      run: completed,
      message,
      artifact,
      citations
    });
  }

  private async repairCitations(
    settings: AppSettings,
    system: string,
    content: string,
    validation: ReturnType<typeof validateResearchCitations>,
    signal: AbortSignal
  ): Promise<string> {
    const prompt = [
      "Rewrite the answer below so every substantive research paragraph, bullet, and table row has at least one valid evidence marker.",
      "Use only evidence IDs present in the supplied evidence bundle. Return only the complete repaired answer.",
      citationProblemDetail(validation),
      "",
      content
    ].join("\n");
    return this.provider.stream({
      settings,
      system,
      messages: [{ role: "user", content: prompt }],
      signal,
      onDelta: () => undefined
    });
  }
}

function researchSystemPrompt(mode: "grounded" | "exploratory", evidenceBundle: string): string {
  const grounding =
    mode === "grounded"
      ? [
          "Use only the supplied project evidence for research claims.",
          "Every substantive paragraph, bullet, and table row containing a research claim must cite at least one evidence ID using the exact form [[S1]].",
          "If the evidence does not support a claim, say so instead of filling the gap from model knowledge."
        ]
      : [
          "You may use broader model knowledge, but distinguish it from project evidence.",
          "Whenever you use supplied project evidence, cite its exact ID using the form [[S1]]."
        ];
  return [
    "You are Paper Pilot, a careful scientific research assistant.",
    "Be concise, explicit about uncertainty, and never reveal hidden chain-of-thought.",
    ...grounding,
    "",
    "Project evidence:",
    evidenceBundle || "No project evidence was retrieved."
  ].join("\n");
}

function citationProblemDetail(validation: ReturnType<typeof validateResearchCitations>): string {
  const parts: string[] = [];
  if (validation.invalidIds.length) parts.push(`Invalid evidence IDs: ${validation.invalidIds.join(", ")}.`);
  if (validation.uncoveredBlocks.length)
    parts.push(`${validation.uncoveredBlocks.length} substantive blocks lack citations.`);
  return parts.join(" ") || "Citation formatting is invalid.";
}

function providerLabel(provider: AppSettings["ai"]["provider"]): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "vercel") return "Vercel AI Gateway";
  return "OpenAI-compatible provider";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && /abort|stopped/i.test(`${error.name} ${error.message}`);
}

function inferCrawlTopic(content: string, fallback: string): string {
  const explicit = content.match(/\b(?:about|on|for)\s+(.+)$/i)?.[1]?.trim();
  if (explicit) return explicit;
  const stripped = content
    .replace(/^\s*(?:please\s+)?(?:crawl|collect|gather|search|find)\s+/i, "")
    .replace(/^(?:new|more|external|open-access)\s+(?:papers?|literature|studies)\s*/i, "")
    .trim();
  return stripped.length >= 3 ? stripped : fallback;
}

function safeEmit(emit: RunEmitter, event: ChatRunEvent): void {
  try {
    emit(event);
  } catch {
    // The run continues if its renderer navigates or closes; persistence remains authoritative.
  }
}
