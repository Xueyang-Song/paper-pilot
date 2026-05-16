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
import { DEFAULT_OLLAMA_MODEL } from "./ollama-config.js";

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
    } else if (intent === "project-search") {
      this.db.appendMessage({
        projectId: project.id,
        role: "assistant",
        content: renderProjectSearch(this.db, project.id, request.content),
        metadata: { tool: "project-search" }
      });
    } else if (intent === "state") {
      this.db.appendMessage({
        projectId: project.id,
        role: "assistant",
        content: renderProjectState(this.db, this.jobs, project.id),
        metadata: { tool: "project-state" }
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
      if (this.localAgent && (await this.localAgent.available())) {
        try {
          const agentRun = await this.localAgent.run(project.id, request.content);
          this.db.appendMessage({
            projectId: project.id,
            role: "assistant",
            content: agentRun.content,
            metadata: { agent: "ollama", model: DEFAULT_OLLAMA_MODEL }
          });
        } catch (error) {
          this.db.appendMessage({
            projectId: project.id,
            role: "tool",
            content: `Local Ollama agent failed; falling back to deterministic planner. ${error instanceof Error ? error.message : String(error)}`,
            metadata: { agent: "ollama", status: "failed" }
          });
          this.appendOrientation(project);
        }
      } else {
        this.appendOrientation(project);
      }
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

  private appendOrientation(project: Project): void {
    this.db.appendMessage({
      projectId: project.id,
      role: "assistant",
      content: [
        `Project **${project.title}** is ready.`,
        "",
        "Ask me to crawl a topic, list saved papers, search the project corpus, compare papers, or generate a research brief."
      ].join("\n"),
      metadata: { tool: "orientation" }
    });
  }
}

function classifyIntent(content: string): "crawl" | "brief" | "state" | "project-search" | "chat" {
  const text = content.toLowerCase();
  const asksForNewSourceWork = /\b(crawl|collect|gather)\b/.test(text) || /\b(search|find)\b[\s\S]*\b(papers?|literature|sources?|studies|articles)\b/.test(text);
  const asksAboutSavedState =
    /\b(what|which|show|list|display|do i have|already)\b[\s\S]*\b(papers?|artifacts?|files?|jobs?|project|corpus|database|db)\b/.test(
      text
    ) ||
    /\b(papers?|artifacts?|files?|jobs?)\b[\s\S]*\b(in|inside|for)\b[\s\S]*\b(this|the)\b[\s\S]*\b(project|database|db|corpus)\b/.test(
      text
    );
  if (asksAboutSavedState) return "state";
  if (/\b(search|find|look up|lookup)\b[\s\S]*\b(this|the|my)\b[\s\S]*\b(project|corpus|database|db|saved|stored|existing)\b/.test(text)) {
    return "project-search";
  }
  if (!asksForNewSourceWork && /\b(brief|insight|summarize|synthesis|compare|gap|controvers|timeline|report)\b/.test(text)) return "brief";
  if (/\b(search|find)\b[\s\S]*\b(papers?|literature|sources?|studies|articles)\b/.test(text)) return "crawl";
  if (/\b(crawl|collect|gather)\b/.test(text)) return "crawl";
  if (/\b(papers?|literature|studies|articles)\b\s+(?:about|on|for)\b/.test(text)) return "crawl";
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

function renderProjectState(db: PaperPilotDb, jobs: JobQueue, projectId: string): string {
  const project = db.getProject(projectId);
  const papers = db.listPapers(projectId);
  const artifacts = db.listArtifacts(projectId);
  const recentJobs = jobs.list(projectId).slice(0, 5);
  const lines = [
    `## ${project?.title ?? "Current Project"}`,
    "",
    `Saved papers: **${papers.length}**`,
    `Artifacts: **${artifacts.length}**`,
    `Jobs: **${jobs.list(projectId).length}**`,
    ""
  ];

  if (papers.length) {
    lines.push("### Saved Papers", "");
    for (const paper of papers.slice(0, 10)) {
      lines.push(`- ${paper.title}${paper.year ? ` (${paper.year})` : ""}${paper.source ? ` - ${paper.source}` : ""}`);
    }
    if (papers.length > 10) lines.push(`- ...and ${papers.length - 10} more.`);
    lines.push("");
  } else {
    lines.push("No papers are saved in this Paper Pilot project yet.", "");
  }

  if (artifacts.length) {
    lines.push("### Recent Artifacts", "");
    for (const artifact of artifacts.slice(0, 6)) {
      lines.push(`- ${artifact.title} (${artifact.type})`);
    }
    lines.push("");
  }

  if (recentJobs.length) {
    lines.push("### Recent Jobs", "");
    for (const job of recentJobs) {
      lines.push(`- ${job.title}: ${job.status}${job.detail ? ` - ${job.detail}` : ""}`);
    }
  }

  return lines.join("\n").trim();
}

function renderProjectSearch(db: PaperPilotDb, projectId: string, prompt: string): string {
  const query = inferProjectSearchQuery(prompt);
  const chunks = db.hybridSearchChunks(projectId, query, 6);
  const papers = db
    .listPapers(projectId)
    .filter((paper) => [paper.title, paper.abstract, paper.venue, paper.doi].filter(Boolean).join(" ").toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6);

  if (!chunks.length && !papers.length) {
    return [
      `I searched the Paper Pilot project database for **${query}** and did not find saved matches.`,
      "",
      "No local folders were inspected. To bring in new papers, ask me to crawl the topic."
    ].join("\n");
  }

  const lines = [`I searched the Paper Pilot project database for **${query}**.`, ""];
  if (papers.length) {
    lines.push("### Matching Papers", "");
    for (const paper of papers) {
      lines.push(`- ${paper.title}${paper.year ? ` (${paper.year})` : ""}${paper.source ? ` - ${paper.source}` : ""}`);
    }
    lines.push("");
  }
  if (chunks.length) {
    lines.push("### Matching Artifact Passages", "");
    for (const chunk of chunks) {
      lines.push(`- ${chunk.text.slice(0, 280)}${chunk.text.length > 280 ? "..." : ""}`);
    }
  }
  return lines.join("\n").trim();
}

function inferProjectSearchQuery(prompt: string): string {
  const quoted = prompt.match(/"([^"]+)"/)?.[1] ?? prompt.match(/'([^']+)'/)?.[1];
  if (quoted) return quoted.trim();
  return (
    prompt
      .replace(/\b(search|find|look up|lookup|this|the|my|project|corpus|database|db|saved|stored|existing|for|about|in)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.?!]$/, "") || prompt.trim()
  );
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
