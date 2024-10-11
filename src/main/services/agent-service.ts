import {
  type ChatRequest,
  type ChatResponse,
  type CrawlConfig,
  crawlConfigSchema,
  type Project
} from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import type { ArtifactService } from "./artifact-service.js";
import type { AiService } from "./ai-service.js";
import type { CrawlService } from "./crawl-service.js";
import type { JobQueue } from "./job-queue.js";
import type { LocalAgentService } from "./local-agent-service.js";

export class AgentService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly crawl: CrawlService,
    private readonly ai: AiService,
    private readonly artifacts: ArtifactService,
    private readonly jobs: JobQueue,
    private readonly localAgent?: LocalAgentService
  ) {}

  async handleChat(request: ChatRequest): Promise<ChatResponse> {
    const project = request.projectId ? this.db.getProject(request.projectId) ?? this.createProjectFromPrompt(request.content) : this.createProjectFromPrompt(request.content);
    this.db.appendMessage({ projectId: project.id, role: "user", content: request.content, metadata: {} });

    if (this.localAgent && (await this.localAgent.available())) {
      try {
        const agentRun = await this.localAgent.run(project.id, request.content);
        this.db.appendMessage({
          projectId: project.id,
          role: "assistant",
          content: agentRun.content,
          metadata: { agent: "ollama", model: "qwen2.5:0.5b" }
        });
        return {
          project: this.db.getProject(project.id) ?? project,
          messages: this.db.listMessages(project.id),
          jobs: this.jobs.list(project.id),
          artifacts: this.db.listArtifacts(project.id)
        };
      } catch (error) {
        this.db.appendMessage({
          projectId: project.id,
          role: "tool",
          content: `Local Ollama agent failed; falling back to deterministic planner. ${error instanceof Error ? error.message : String(error)}`,
          metadata: { agent: "ollama", status: "failed" }
        });
      }
    }

    const intent = classifyIntent(request.content);
    if (intent === "crawl") {
      const config = buildCrawlConfig(project, request);
      const result = await this.crawl.runCrawl(project.id, config, { approved: false });
      const warningText = result.warnings.length ? `\n\nWarnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
      const crawlJob = this.jobs.get(result.jobId);
      this.db.appendMessage({
        projectId: project.id,
        role: "assistant",
        content:
          crawlJob?.status === "waiting-approval"
            ? `I prepared a crawl for "${config.topic}" and it is waiting for your approval in the job panel.${warningText}`
            : result.papers.length > 0
            ? `I crawled ${result.papers.length} open-access papers for "${config.topic}" and added ${result.artifacts.length} artifacts to the project.${warningText}`
            : `I started the crawl workflow for "${config.topic}", but no papers were retained yet.${warningText}`,
        metadata: { tool: "crawl", jobId: result.jobId, artifactIds: result.artifacts.map((artifact) => artifact.id) }
      });
    } else if (intent === "brief") {
      const brief = await this.ai.generateResearchBrief(project.id, request.content);
      this.db.appendMessage({
        projectId: project.id,
        role: "assistant",
        content: brief.content,
        metadata: { tool: "research-brief", jobId: brief.jobId, artifactId: brief.artifactId }
      });
    } else {
      this.db.appendMessage({
        projectId: project.id,
        role: "assistant",
        content: [
          `Project "${project.title}" is ready.`,
          "Ask me to crawl a topic, compare papers, generate a research brief, or run a guarded Python analysis script."
        ].join("\n"),
        metadata: { tool: "orientation" }
      });
    }

    return {
      project: this.db.getProject(project.id) ?? project,
      messages: this.db.listMessages(project.id),
      jobs: this.jobs.list(project.id),
      artifacts: this.db.listArtifacts(project.id)
    };
  }

  private createProjectFromPrompt(prompt: string): Project {
    const title = inferProjectTitle(prompt);
    return this.db.createProject(title, title);
  }
}

function classifyIntent(content: string): "crawl" | "brief" | "chat" {
  const text = content.toLowerCase();
  if (/\b(crawl|search|find|collect|gather|papers?|literature|sources?)\b/.test(text)) return "crawl";
  if (/\b(brief|insight|summarize|synthesis|compare|gap|controvers|timeline|report)\b/.test(text)) return "brief";
  return "chat";
}

function buildCrawlConfig(project: Project, request: ChatRequest): CrawlConfig {
  const topic = request.crawlConfig?.topic ?? inferTopic(request.content) ?? project.topic ?? project.title;
  return crawlConfigSchema.parse({
    ...request.crawlConfig,
    topic,
    maxPapers: request.crawlConfig?.maxPapers ?? Math.min(project.policy.maxCrawlPapers, 25)
  });
}

function inferProjectTitle(prompt: string): string {
  const topic = inferTopic(prompt) ?? prompt;
  return topic
    .replace(/\b(crawl|search|find|collect|gather|papers?|literature|about|on|for)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Untitled research project";
}

function inferTopic(prompt: string): string | undefined {
  const quoted = prompt.match(/"([^"]+)"/)?.[1] ?? prompt.match(/'([^']+)'/)?.[1];
  if (quoted) return quoted;
  const about = prompt.match(/\b(?:about|on|for|topic)\s+(.+)$/i)?.[1];
  if (about) return about.trim().replace(/[.?!]$/, "");
  return prompt.trim().replace(/[.?!]$/, "");
}
