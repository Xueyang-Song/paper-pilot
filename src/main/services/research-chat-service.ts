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
  validateResearchCitations,
  type ResearchEvidence
} from "./research-grounding.js";
import {
  ResearchProvider,
  type ProviderMessage,
  type ProviderTool,
  type ProviderToolCall
} from "./research-provider.js";
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
    queueMicrotask(() => {
      void this.execute(input, appSettings, run, assistantMessage.id, controller, emit).finally(() => {
        const active = this.active.get(input.conversationId);
        if (active?.runId === runId) this.active.delete(input.conversationId);
      });
    });
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
    safeEmit(emit, runEventContext(run, assistantMessageId), { type: "status", status: "running" });

    const trace = (step: Omit<ChatTraceStep, "id" | "startedAt">): void => {
      const timestamp = nowIso();
      const next: ChatTraceStep = {
        id: id("trace"),
        startedAt: timestamp,
        completedAt: step.status === "running" || step.status === "waiting" ? undefined : timestamp,
        ...step
      };
      run = this.db.saveChatRun({ ...run, trace: [...run.trace, next], updatedAt: timestamp });
      safeEmit(emit, runEventContext(run, assistantMessageId), { type: "trace", step: next });
    };

    try {
      const toolResponse = await this.runAppOwnedTool(input, run.id, trace, controller.signal);
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
      let evidence = collectResearchEvidence(this.db, input.projectId, input.content, input.sourceRefs);
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

      const system = researchSystemPrompt(run.mode, formatEvidenceBundle(evidence));
      const reservedToolTokens = settings.ai.provider === "ollama" ? 1_024 : 2_048;
      const history = buildRecentContext(
        this.db
          .listMessages(input.projectId, input.conversationId)
          .filter((message) => message.id !== assistantMessageId && message.id !== run.userMessageId),
        settings.ai.provider,
        `${system}\n${input.content}`,
        reservedToolTokens
      );
      run = this.db.saveChatRun({
        ...run,
        includedMessageCount: history.included + 1,
        omittedMessageCount: history.omitted,
        updatedAt: nowIso()
      });
      trace({
        kind: "context",
        status: "completed",
        label: `Using ${history.included + 1} conversation ${history.included + 1 === 1 ? "message" : "messages"}`,
        detail: history.omitted ? `${history.omitted} older messages are outside the active context.` : undefined
      });

      trace({
        kind: "provider",
        status: "running",
        label: `Calling ${providerLabel(settings.ai.provider)} · ${settings.ai.model}`
      });
      const providerMessages: ProviderMessage[] = [
        ...history.messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: input.content }
      ];
      let content = "";
      let remainingToolOutputChars = reservedToolTokens * 4;
      for (let providerTurn = 0; providerTurn < 5; providerTurn += 1) {
        const result = await this.provider.chat({
          settings,
          system,
          messages: providerMessages,
          tools: this.providerTools(),
          signal: controller.signal,
          onDelta: (text) => {
            streamedContent += text;
            safeEmit(emit, runEventContext(run, assistantMessageId), { type: "delta", text });
          }
        });
        if (!result.toolCalls.length) {
          content = result.content;
          break;
        }
        providerMessages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
        for (const call of result.toolCalls) {
          const toolResult = await this.executeModelTool(input, run.id, call, trace, controller.signal, evidence);
          if (toolResult.evidence?.length) {
            evidence = mergeEvidence(evidence, toolResult.evidence);
          }
          const toolContent = boundedToolOutput(toolResult.output, remainingToolOutputChars);
          remainingToolOutputChars = Math.max(0, remainingToolOutputChars - toolContent.length);
          providerMessages.push({
            role: "tool",
            content: toolContent,
            toolCallId: call.id,
            toolName: call.name
          });
        }
        if (providerTurn === 4) throw new Error("The provider exceeded the five-turn tool limit.");
      }
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
        content = await this.repairCitations(
          settings,
          researchSystemPrompt(run.mode, formatEvidenceBundle(evidence)),
          content,
          validation,
          controller.signal
        );
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
      safeEmit(emit, runEventContext(run, assistantMessageId), {
        type: "error",
        error: errorText,
        status: stopped ? "stopped" : "failed"
      });
    }
  }

  private async runAppOwnedTool(
    input: StartChatRunRequest,
    runId: string,
    trace: (step: Omit<ChatTraceStep, "id" | "startedAt">) => void,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const content = input.content.trim();
    const lower = content.toLowerCase();
    if (this.registry && /\b(list|show)\b[\s\S]*\b(sources|providers)\b/.test(lower)) {
      const { output } = await this.executeModelTool(
        input,
        runId,
        { id: id("call"), name: "list_sources", arguments: {} },
        trace,
        signal,
        []
      );
      const rawSources = recordOutput(output).sources;
      const sources: unknown[] = Array.isArray(rawSources) ? rawSources : [];
      return [
        "## Scholarly sources",
        "",
        ...sources.map((source) => {
          const record = recordOutput(source);
          return `- **${String(record.displayName ?? "Source")}** — ${String(record.description ?? "")}`;
        })
      ].join("\n");
    }

    if (this.ai && /\b(generate|create|write)\b[\s\S]*\b(research )?brief\b/.test(lower)) {
      const { output } = await this.executeModelTool(
        input,
        runId,
        { id: id("call"), name: "generate_research_brief", arguments: { prompt: content } },
        trace,
        signal,
        []
      );
      const result = recordOutput(output);
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
      const { output } = await this.executeModelTool(
        input,
        runId,
        {
          id: id("call"),
          name: "run_crawl",
          arguments: { topic, maxPapers: Math.min(project.policy.maxCrawlPapers, 25) }
        },
        trace,
        signal,
        []
      );
      const result = recordOutput(output);
      return result.status === "waiting-approval"
        ? "I prepared a scholarly-source crawl. Review and approve it in the job panel before Paper Pilot contacts external sources."
        : `The crawl retained ${Number(result.paperCount ?? 0)} papers and created ${Number(result.artifactCount ?? 0)} project artifacts.`;
    }
    return undefined;
  }

  private providerTools(): ProviderTool[] {
    return [
      {
        type: "function",
        function: {
          name: "search_corpus",
          description:
            "Search trusted evidence in the current project. Use this when the supplied evidence is insufficient.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false
          }
        }
      },
      {
        type: "function",
        function: {
          name: "list_project_state",
          description:
            "List safe project metadata, papers, artifacts, and jobs without reading operating-system files.",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      },
      ...(this.registry
        ? [
            {
              type: "function" as const,
              function: {
                name: "list_sources",
                description: "List the configured scholarly source connectors and their capabilities.",
                parameters: { type: "object", properties: {}, additionalProperties: false }
              }
            }
          ]
        : []),
      ...(this.crawl
        ? [
            {
              type: "function" as const,
              function: {
                name: "run_crawl",
                description:
                  "Prepare a scholarly crawl only when the user explicitly asks to find or collect external papers.",
                parameters: {
                  type: "object",
                  properties: { topic: { type: "string" }, maxPapers: { type: "number" } },
                  required: ["topic"],
                  additionalProperties: false
                }
              }
            }
          ]
        : []),
      ...(this.ai
        ? [
            {
              type: "function" as const,
              function: {
                name: "generate_research_brief",
                description: "Generate a research brief only when the user explicitly asks for a saved brief.",
                parameters: {
                  type: "object",
                  properties: { prompt: { type: "string" } },
                  required: ["prompt"],
                  additionalProperties: false
                }
              }
            }
          ]
        : [])
    ];
  }

  private async executeModelTool(
    input: StartChatRunRequest,
    runId: string,
    call: ProviderToolCall,
    trace: (step: Omit<ChatTraceStep, "id" | "startedAt">) => void,
    signal: AbortSignal,
    currentEvidence: ResearchEvidence[]
  ): Promise<{ output: unknown; evidence?: ResearchEvidence[] }> {
    if (signal.aborted) throw signal.reason;
    const toolRunId = this.db.createToolRun(input.projectId, runId, call.name, redactToolInput(call));
    trace({ kind: "tool", status: "running", label: toolLabel(call.name, "running"), toolName: call.name });
    try {
      let result: { output: unknown; evidence?: ResearchEvidence[] };
      let completionStatus: "completed" | "waiting" = "completed";
      if (call.name === "search_corpus") {
        const query = stringArgument(call.arguments.query, input.content);
        const retrieved = collectResearchEvidence(this.db, input.projectId, query, input.sourceRefs);
        const merged = mergeEvidence(currentEvidence, retrieved);
        const byKey = new Map(merged.map((entry) => [evidenceKey(entry), entry]));
        const evidence = retrieved.flatMap((entry) => {
          const normalized = byKey.get(evidenceKey(entry));
          return normalized ? [normalized] : [];
        });
        result = { output: { evidence: evidence.map(providerEvidenceSummary) }, evidence };
      } else if (call.name === "list_project_state") {
        result = { output: safeProjectState(this.db, input.projectId, this.jobs) };
      } else if (call.name === "list_sources" && this.registry) {
        result = { output: { sources: this.registry.list() } };
      } else if (call.name === "run_crawl" && this.crawl) {
        const project = this.db.getProject(input.projectId)!;
        const topic = stringArgument(call.arguments.topic, project.topic || project.title);
        const requestedMax = Number(call.arguments.maxPapers);
        const maxPapers = Math.min(
          project.policy.maxCrawlPapers,
          Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : 25
        );
        const crawl = await this.crawl.runCrawl(input.projectId, { topic, maxPapers }, { approved: false });
        const jobStatus = this.jobs?.get(crawl.jobId)?.status ?? "completed";
        completionStatus = jobStatus === "waiting-approval" ? "waiting" : "completed";
        result = {
          output: {
            jobId: crawl.jobId,
            status: jobStatus,
            paperCount: crawl.papers.length,
            artifactCount: crawl.artifacts.length
          }
        };
      } else if (call.name === "generate_research_brief" && this.ai) {
        result = {
          output: await this.ai.generateResearchBrief(
            input.projectId,
            stringArgument(call.arguments.prompt, input.content)
          )
        };
      } else {
        throw new Error(`Unsupported research tool: ${call.name}`);
      }
      if (signal.aborted) throw signal.reason;
      this.db.finishToolRun(toolRunId, completionStatus, summarizeToolOutput(result.output));
      trace({
        kind: "tool",
        status: completionStatus,
        label: completionStatus === "waiting" ? "Crawl is waiting for approval" : toolLabel(call.name, "completed"),
        toolName: call.name
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.db.finishToolRun(toolRunId, "failed", undefined, detail);
      trace({ kind: "tool", status: "failed", label: toolLabel(call.name, "failed"), detail, toolName: call.name });
      throw error;
    }
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
    safeEmit(emit, runEventContext(completed, assistantMessageId), {
      type: "complete",
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
    "Use only the provided Paper Pilot tools; never inspect operating-system files or invent tool results.",
    "Call crawl or brief-generation tools only when the user's current request explicitly asks for that action.",
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
  return error instanceof Error && error.name === "AbortError";
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

function mergeEvidence(current: ResearchEvidence[], incoming: ResearchEvidence[]): ResearchEvidence[] {
  const merged = [...current];
  const keys = new Set(current.map(evidenceKey));
  const perSource = new Map<string, number>();
  for (const entry of current) {
    const source = entry.paperId ? `paper:${entry.paperId}` : `artifact:${entry.artifactId}`;
    perSource.set(source, (perSource.get(source) ?? 0) + 1);
  }
  for (const entry of incoming) {
    const key = evidenceKey(entry);
    const source = entry.paperId ? `paper:${entry.paperId}` : `artifact:${entry.artifactId}`;
    if (keys.has(key) || (perSource.get(source) ?? 0) >= 2 || merged.length >= 12) continue;
    keys.add(key);
    perSource.set(source, (perSource.get(source) ?? 0) + 1);
    merged.push({ ...entry, evidenceId: `S${merged.length + 1}` });
  }
  return merged;
}

function evidenceKey(entry: ResearchEvidence): string {
  return `${entry.paperId ?? ""}:${entry.artifactId ?? ""}:${entry.chunkId ?? entry.excerpt.slice(0, 120)}`;
}

function stringArgument(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2_000) : fallback;
}

function redactToolInput(call: ProviderToolCall): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(call.arguments).map(([key, value]) => [
      key,
      typeof value === "string" ? value.slice(0, 2_000) : value
    ])
  );
}

function summarizeToolOutput(output: unknown): Record<string, unknown> {
  const text = JSON.stringify(output);
  return { summary: text.length > 4_000 ? `${text.slice(0, 3_997)}...` : text };
}

function providerEvidenceSummary(entry: ResearchEvidence): Record<string, unknown> {
  return {
    evidenceId: entry.evidenceId,
    sourceType: entry.sourceType,
    paperId: entry.paperId,
    artifactId: entry.artifactId,
    title: entry.title,
    excerpt: entry.excerpt.slice(0, 600),
    locator: entry.locator,
    doi: entry.doi,
    url: entry.url
  };
}

function boundedToolOutput(output: unknown, remainingChars: number): string {
  const serialized = JSON.stringify(output);
  if (serialized.length <= remainingChars) return serialized;
  const prefix = "Truncated tool output:\n";
  return `${prefix}${serialized.slice(0, Math.max(0, remainingChars - prefix.length))}`;
}

function recordOutput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeProjectState(db: PaperPilotDb, projectId: string, jobs?: JobQueue): Record<string, unknown> {
  const project = db.getProject(projectId);
  return {
    project: project
      ? { id: project.id, title: project.title, topic: project.topic, description: project.description }
      : undefined,
    papers: db
      .listPapers(projectId)
      .slice(0, 20)
      .map(({ id: paperId, title, authors, year, doi, url }) => ({
        id: paperId,
        title,
        authors,
        year,
        doi,
        url
      })),
    artifacts: db
      .listArtifacts(projectId)
      .slice(0, 20)
      .map(({ id: artifactId, title, type }) => ({
        id: artifactId,
        title,
        type
      })),
    jobs: (jobs?.list(projectId) ?? []).slice(0, 20).map(({ id: jobId, title, status, detail }) => ({
      id: jobId,
      title,
      status,
      detail
    }))
  };
}

function toolLabel(name: string, status: "running" | "completed" | "failed"): string {
  const label =
    {
      search_corpus: "trusted project evidence",
      list_project_state: "project state",
      list_sources: "scholarly sources",
      run_crawl: "scholarly crawl",
      generate_research_brief: "research brief"
    }[name] ?? "research tool";
  if (status === "running") return `Using ${label}`;
  if (status === "failed") return `Failed to use ${label}`;
  return `Used ${label}`;
}

type RunEventContext = Pick<ChatRun, "id" | "projectId" | "conversationId"> & { assistantMessageId: string };
type RunEventPayload = ChatRunEvent extends infer Event
  ? Event extends ChatRunEvent
    ? Omit<Event, "runId" | "projectId" | "conversationId" | "assistantMessageId">
    : never
  : never;

function runEventContext(
  run: Pick<ChatRun, "id" | "projectId" | "conversationId">,
  assistantMessageId: string
): RunEventContext {
  return { ...run, assistantMessageId };
}

function safeEmit(emit: RunEmitter, context: RunEventContext, event: RunEventPayload): void {
  try {
    emit({
      ...event,
      runId: context.id,
      projectId: context.projectId,
      conversationId: context.conversationId,
      assistantMessageId: context.assistantMessageId
    } as ChatRunEvent);
  } catch {
    // The run continues if its renderer navigates or closes; persistence remains authoritative.
  }
}
