import type { AppSettings, Paper } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import type { ArtifactService } from "./artifact-service.js";
import type { CredentialService } from "./credential-service.js";
import type { JobQueue } from "./job-queue.js";
import type { SettingsService } from "./settings-service.js";

export class AiService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly settings: SettingsService,
    private readonly credentials: CredentialService,
    private readonly artifacts: ArtifactService,
    private readonly jobs: JobQueue
  ) {}

  async generateResearchBrief(projectId: string, prompt: string): Promise<{ content: string; artifactId: string; jobId: string }> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const job = this.jobs.create({ projectId, kind: "brief", status: "running", title: "Generating research brief" });
    const papers = this.db.listPapers(projectId).slice(0, 40);
    const chunks = this.db.hybridSearchChunks(projectId, prompt, 10);
    const settings = await this.settings.get();
    let content: string;
    if (settings.ai.hasApiKey) {
      this.jobs.update(job.id, { progress: 0.35, detail: "Calling configured frontier model." });
      content = await this.callGateway(settings, renderBriefPrompt(project.title, prompt, papers, chunks));
    } else {
      this.jobs.update(job.id, { progress: 0.35, detail: "No AI key configured; using local structured synthesis." });
      content = localBrief(project.title, prompt, papers, chunks);
    }
    const artifact = await this.artifacts.writeArtifact({
      projectId,
      type: "brief",
      title: `Research brief - ${project.title}`,
      content,
      source: "ai-service",
      metadata: { prompt, paperCount: papers.length, model: settings.ai.hasApiKey ? settings.ai.model : "local-structured" },
      indexText: true
    });
    this.jobs.update(job.id, {
      status: "completed",
      progress: 1,
      detail: "Research brief ready.",
      result: { artifactId: artifact.id }
    });
    return { content, artifactId: artifact.id, jobId: job.id };
  }

  async callGateway(settings: AppSettings, prompt: string): Promise<string> {
    const apiKey = this.credentials.get("ai-gateway");
    if (!apiKey) throw new Error("AI Gateway API key is not configured.");
    const url = new URL("/v1/chat/completions", settings.ai.baseUrl.endsWith("/v1") ? settings.ai.baseUrl.slice(0, -3) : settings.ai.baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.ai.model,
        messages: [
          {
            role: "system",
            content:
              "You are Paper Pilot, a careful scientific research agent. Return concise, citation-backed research synthesis in Markdown. Cite papers by bracketed index like [P3]."
          },
          { role: "user", content: prompt }
        ],
        stream: false,
        reasoning: settings.ai.reasoningEnabled ? { effort: "medium" } : undefined
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`AI Gateway request failed ${response.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "No response content returned by the configured model.";
  }
}

function renderBriefPrompt(
  projectTitle: string,
  prompt: string,
  papers: Paper[],
  chunks: Array<{ text: string; artifactId: string }>
): string {
  return [
    `Project: ${projectTitle}`,
    `User request: ${prompt}`,
    "",
    "Papers:",
    ...papers.map((paper, index) => renderPaperCitation(paper, index)),
    "",
    "Retrieved context:",
    ...chunks.map((chunk, index) => `[C${index + 1}] ${chunk.text.slice(0, 1600)}`),
    "",
    "Write a research brief with: executive summary, strongest findings, comparison table, research gaps, controversies, and suggested next reads."
  ].join("\n");
}

function localBrief(
  projectTitle: string,
  prompt: string,
  papers: Paper[],
  chunks: Array<{ text: string; artifactId: string }>
): string {
  const top = papers.slice(0, 12);
  const byYear = top.filter((paper) => paper.year).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  const cited = top.filter((paper) => paper.citationCount).sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
  return [
    `# Research Brief: ${projectTitle}`,
    "",
    `Request: ${prompt}`,
    "",
    "## Executive Summary",
    "",
    top.length
      ? `The current corpus contains ${papers.length} papers. The most useful first pass is to compare the highest-cited work with the newest open-access papers, then inspect abstracts for methods, datasets, and unresolved limitations.`
      : "No papers have been crawled yet. Start a crawl before asking for deeper synthesis.",
    "",
    "## Strongest Signals",
    "",
    ...(cited.slice(0, 5).map((paper, index) => `- ${paper.title} [P${papers.indexOf(paper) + 1}]${paper.citationCount ? `, ${paper.citationCount} citations` : ""}`) || []),
    "",
    "## Recent Work",
    "",
    ...(byYear.slice(0, 5).map((paper) => `- ${paper.title} [P${papers.indexOf(paper) + 1}], ${paper.year}`) || []),
    "",
    "## Comparison Table",
    "",
    "| Ref | Year | Venue | Signal |",
    "| --- | ---: | --- | --- |",
    ...top
      .slice(0, 8)
      .map(
        (paper, index) =>
          `| [P${index + 1}] | ${paper.year ?? ""} | ${escapeTable(paper.venue ?? paper.source)} | ${escapeTable((paper.abstract ?? "Metadata-only result").slice(0, 120))} |`
      ),
    "",
    "## Research Gaps",
    "",
    "- Verify whether high-citation results still reflect the latest methods.",
    "- Separate review papers from primary empirical work before drawing conclusions.",
    "- Prefer papers with available full text for claims that require methods or limitations analysis.",
    "",
    "## Retrieved Context",
    "",
    ...chunks.slice(0, 4).map((chunk, index) => `> [C${index + 1}] ${chunk.text.slice(0, 500)}`),
    "",
    "## References",
    "",
    ...papers.slice(0, 20).map((paper, index) => renderPaperCitation(paper, index))
  ].join("\n");
}

function renderPaperCitation(paper: Paper, index: number): string {
  return [
    `[P${index + 1}] ${paper.title}`,
    paper.authors.length ? paper.authors.slice(0, 6).join(", ") : undefined,
    paper.year,
    paper.venue,
    paper.doi ? `doi:${paper.doi}` : undefined,
    paper.url
  ]
    .filter(Boolean)
    .join(" | ");
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
