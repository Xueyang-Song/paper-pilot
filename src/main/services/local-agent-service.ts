import type { ChatResponse, CrawlConfig, SourceId } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import type { SourceRegistry } from "../sources/registry.js";
import type { AiService } from "./ai-service.js";
import type { CrawlService } from "./crawl-service.js";
import type { JobQueue } from "./job-queue.js";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "./ollama-config.js";
import type { SettingsService } from "./settings-service.js";

interface OllamaToolCall {
  id?: string;
  function: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaResponse {
  message?: OllamaMessage;
}

interface LocalAgentConfig {
  provider: "ollama";
  baseUrl: string;
  model: string;
}

export class LocalAgentService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly registry: SourceRegistry,
    private readonly crawl: CrawlService,
    private readonly ai: AiService,
    private readonly jobs: JobQueue,
    private readonly options: { model?: string; baseUrl?: string; settings?: SettingsService } = {}
  ) {}

  async available(): Promise<boolean> {
    const config = await this.activeConfig();
    if (!config) return false;
    try {
      const response = await fetch(`${baseUrl(config)}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async run(projectId: string, content: string): Promise<{ content: string; response: ChatResponse; provider: "ollama"; model: string }> {
    const config = await this.activeConfig();
    if (!config) throw new Error("Local Ollama agent is disabled because Ollama is not the selected AI provider.");
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const messages: OllamaMessage[] = [
      {
        role: "system",
        content: [
          "You are Paper Pilot, a local-first scientific research agent.",
          "The app database is the only source of truth for projects, papers, artifacts, and jobs.",
          "Never inspect, infer from, or refer to the user's operating-system folders or the current working directory.",
          "Use tools whenever a user asks to search the corpus, list project data, or create a research brief.",
          "Crawls are handled by Paper Pilot's crawl service before this chat path, so do not claim a requested crawl is already complete unless project tools show it.",
          "External crawl and script tools may return waiting-approval; never claim they finished unless the tool result says completed.",
          "Keep final answers concise and cite artifacts or papers when available.",
          `Current app project snapshot: ${JSON.stringify(this.projectSnapshot(projectId)).slice(0, 4000)}`
        ].join(" ")
      },
      { role: "user", content }
    ];

    let finalContent = "";
    for (let turn = 0; turn < 5; turn += 1) {
      const message = await this.chat(config, messages);
      const toolCalls = message.tool_calls ?? [];
      if (!toolCalls.length) {
        finalContent = message.content || "I'm ready to continue with the project.";
        break;
      }
      messages.push({
        role: "assistant",
        content: message.content ?? "",
        tool_calls: toolCalls
      });
      for (const toolCall of toolCalls) {
        const result = await this.executeTool(projectId, toolCall.function.name, toolCall.function.arguments ?? {});
        messages.push({
          role: "tool",
          tool_name: toolCall.function.name,
          content: JSON.stringify(result).slice(0, 12000)
        });
      }
    }

    if (!finalContent) {
      finalContent = "I used the available project tools and updated the workspace.";
    }
    return {
      content: finalContent,
      provider: config.provider,
      model: config.model,
      response: {
        project,
        messages: this.db.listMessages(projectId),
        jobs: this.jobs.list(projectId),
        artifacts: this.db.listArtifacts(projectId)
      }
    };
  }

  private async chat(config: LocalAgentConfig, messages: OllamaMessage[]): Promise<OllamaMessage> {
    const response = await fetch(`${baseUrl(config)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages,
        tools: this.tools()
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama agent request failed ${response.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await response.json()) as OllamaResponse;
    return data.message ?? { role: "assistant", content: "" };
  }

  private async executeTool(projectId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "list_sources") {
      return { sources: this.registry.list() };
    }
    if (name === "list_project_state") {
      return {
        project: this.db.getProject(projectId),
        papers: this.db.listPapers(projectId).slice(0, 20),
        artifacts: this.db.listArtifacts(projectId).slice(0, 20),
        jobs: this.jobs.list(projectId)
      };
    }
    if (name === "search_corpus") {
      const query = String(args.query ?? "");
      return { chunks: this.db.hybridSearchChunks(projectId, query, 8) };
    }
    if (name === "run_crawl") {
      const config: Partial<CrawlConfig> = {
        topic: String(args.topic ?? this.db.getProject(projectId)?.topic ?? "scientific literature"),
        maxPapers: typeof args.maxPapers === "number" ? args.maxPapers : 10,
        sourceIds: Array.isArray(args.sourceIds) ? (args.sourceIds as SourceId[]) : undefined,
        allowBrowserFallback: Boolean(args.allowBrowserFallback)
      };
      return this.crawl.runCrawl(projectId, config, { approved: false });
    }
    if (name === "generate_research_brief") {
      return this.ai.generateResearchBrief(projectId, String(args.prompt ?? "Generate a research brief."));
    }
    return { error: `Unknown tool: ${name}` };
  }

  private tools(): unknown[] {
    return [
      {
        type: "function",
        function: {
          name: "list_sources",
          description: "List configured scholarly sources and their capabilities.",
          parameters: { type: "object", properties: {}, required: [] }
        }
      },
      {
        type: "function",
        function: {
          name: "list_project_state",
          description: "List current project metadata, papers, artifacts, and jobs.",
          parameters: { type: "object", properties: {}, required: [] }
        }
      },
      {
        type: "function",
        function: {
          name: "search_corpus",
          description: "Search indexed project artifacts and paper digests.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "run_crawl",
          description: "Prepare or run an approved scholarly source crawl according to project policy.",
          parameters: {
            type: "object",
            properties: {
              topic: { type: "string" },
              maxPapers: { type: "number" },
              sourceIds: { type: "array", items: { type: "string" } },
              allowBrowserFallback: { type: "boolean" }
            },
            required: ["topic"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "generate_research_brief",
          description: "Generate a citation-backed research brief from the project corpus.",
          parameters: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"]
          }
        }
      }
    ];
  }

  private async activeConfig(): Promise<LocalAgentConfig | undefined> {
    if (this.options.settings) {
      const settings = await this.options.settings.get();
      if (settings.ai.provider !== "ollama") return undefined;
      return { provider: "ollama", baseUrl: settings.ai.baseUrl, model: settings.ai.model };
    }
    return {
      provider: "ollama",
      baseUrl: this.options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      model: this.options.model ?? DEFAULT_OLLAMA_MODEL
    };
  }

  private projectSnapshot(projectId: string): unknown {
    const papers = this.db.listPapers(projectId);
    const artifacts = this.db.listArtifacts(projectId);
    return {
      project: this.db.getProject(projectId),
      paperCount: papers.length,
      artifactCount: artifacts.length,
      recentPaperTitles: papers.slice(0, 8).map((paper) => paper.title),
      recentArtifacts: artifacts.slice(0, 8).map((artifact) => ({ title: artifact.title, type: artifact.type })),
      jobs: this.jobs.list(projectId).slice(0, 8).map((job) => ({ title: job.title, status: job.status, detail: job.detail }))
    };
  }
}

function baseUrl(config: LocalAgentConfig): string {
  return config.baseUrl.replace(/\/+$/, "");
}
