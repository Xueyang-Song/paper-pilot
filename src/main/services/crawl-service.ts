import {
  type Artifact,
  type CrawlConfig,
  crawlConfigSchema,
  type Paper,
  paperDedupeKey,
  type SourceId
} from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { SourceRegistry } from "../sources/registry.js";
import type { CrawlResult } from "../sources/types.js";
import type { ArtifactService } from "./artifact-service.js";
import type { BrowserCrawlerService } from "./browser-crawler-service.js";
import type { CredentialService } from "./credential-service.js";
import type { FullTextService } from "./full-text-service.js";
import type { JobQueue } from "./job-queue.js";
import { requiresApproval } from "./policy.js";

export interface CrawlRunResult {
  jobId: string;
  papers: Paper[];
  artifacts: Artifact[];
  warnings: string[];
}

export class CrawlService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly registry: SourceRegistry,
    private readonly credentials: CredentialService,
    private readonly artifacts: ArtifactService,
    private readonly jobs: JobQueue,
    private readonly browserCrawler?: BrowserCrawlerService,
    private readonly fullText?: FullTextService
  ) {}

  async runCrawl(
    projectId: string,
    input: Partial<CrawlConfig>,
    options: { approved?: boolean; jobId?: string } = {}
  ): Promise<CrawlRunResult> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const config = crawlConfigSchema.parse({
      topic: project.topic ?? input.topic ?? "scientific literature",
      ...input,
      maxPapers: Math.min(input.maxPapers ?? project.policy.maxCrawlPapers, project.policy.maxCrawlPapers)
    });
    const browserSelected = config.sourceIds.includes("google-scholar");
    if (!options.approved && (requiresApproval(project.policy, "source-crawl") || browserSelected)) {
      const waiting = this.jobs.create({
        projectId,
        kind: "crawl",
        status: "waiting-approval",
        title: `Approve crawl: ${config.topic}`,
        detail: browserSelected
          ? "This crawl includes an experimental browser source."
          : "Project policy asks before external source crawls.",
        result: {
          approval: {
            action: "crawl",
            config
          }
        }
      });
      return { jobId: waiting.id, papers: [], artifacts: [], warnings: [waiting.detail ?? "Waiting for approval."] };
    }

    const job = options.jobId
      ? this.jobs.update(options.jobId, {
          status: "running",
          title: `Crawling ${config.topic}`,
          progress: 0,
          detail: "Approval received. Starting crawl.",
          result: { approval: undefined }
        })
      : this.jobs.create({ projectId, kind: "crawl", status: "running", title: `Crawling ${config.topic}` });
    const warnings: string[] = [];
    const connectorResults: Array<{ sourceId: SourceId; result?: CrawlResult; error?: string }> = [];
    const saved = new Map<string, Paper>();
    const sourceIds = config.sourceIds;
    const credentialMap = this.credentials.getMany(sourceIds);

    for (let index = 0; index < sourceIds.length; index += 1) {
      const sourceId = sourceIds[index];
      this.jobs.update(job.id, {
        progress: index / Math.max(sourceIds.length, 1),
        detail: `Running ${this.registry.get(sourceId).definition.displayName}`
      });
      try {
        const result =
          sourceId === "google-scholar" && this.browserCrawler
            ? {
                ...(await this.browserCrawler.runGoogleScholar(projectId, config)),
                provenance: { mode: "playwright" }
              }
            : await this.registry.run(sourceId, config, {
                credentials: credentialMap,
                userAgent: "PaperPilot/0.1 research-crawler"
              });
        connectorResults.push({ sourceId, result });
        warnings.push(...result.warnings.map((warning) => `${this.registry.get(sourceId).definition.displayName}: ${warning}`));
        for (const paper of result.papers) {
          if (config.openAccessOnly && !paper.isOpenAccess && !paper.pdfUrl) continue;
          const savedPaper = this.db.savePaper(projectId, paper);
          saved.set(paperDedupeKey(savedPaper), savedPaper);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        connectorResults.push({ sourceId, error: message });
        warnings.push(`${this.registry.get(sourceId).definition.displayName}: ${message}`);
      }
    }

    const papers = Array.from(saved.values());
    const fullTextArtifacts: Artifact[] = [];
    if (this.fullText) {
      for (let index = 0; index < papers.length; index += 1) {
        const paper = papers[index];
        this.jobs.update(job.id, {
          progress: 0.85 + (index / Math.max(papers.length, 1)) * 0.1,
          detail: `Fetching open-access full text (${index + 1}/${papers.length})`
        });
        const fullText = await this.fullText.fetchOpenAccessPdf(projectId, paper);
        if (fullText.artifact) fullTextArtifacts.push(fullText.artifact);
        if (fullText.warning) warnings.push(fullText.warning);
      }
    }
    const metadataArtifact = await this.artifacts.writeArtifact({
      projectId,
      type: "metadata-json",
      title: `Crawl metadata - ${config.topic}`,
      content: JSON.stringify(
        { config, papers, warnings, connectorResults, fullTextArtifactIds: fullTextArtifacts.map((artifact) => artifact.id) },
        null,
        2
      ),
      source: "crawl-service",
      metadata: { paperCount: papers.length, sources: sourceIds },
      indexText: false
    });
    const markdown = renderCrawlMarkdown(config, papers, warnings);
    const markdownArtifact = await this.artifacts.writeArtifact({
      projectId,
      type: "markdown",
      title: `Crawl digest - ${config.topic}`,
      content: markdown,
      source: "crawl-service",
      metadata: { paperCount: papers.length, sources: sourceIds },
      indexText: true
    });
    this.jobs.update(job.id, {
      status: "completed",
      progress: 1,
      detail: `Found ${papers.length} open-access papers and downloaded ${fullTextArtifacts.length} PDFs.`,
      result: { paperCount: papers.length, artifactIds: [metadataArtifact.id, markdownArtifact.id, ...fullTextArtifacts.map((artifact) => artifact.id)] }
    });
    return { jobId: job.id, papers, artifacts: [metadataArtifact, markdownArtifact, ...fullTextArtifacts], warnings };
  }

  async approvePendingCrawl(jobId: string): Promise<CrawlRunResult> {
    const job = this.jobs.get(jobId);
    const approval = job?.result?.approval as { action?: string; config?: Partial<CrawlConfig> } | undefined;
    if (!job || job.status !== "waiting-approval" || approval?.action !== "crawl" || !approval.config) {
      throw new Error(`No pending crawl approval found for job ${jobId}.`);
    }
    return this.runCrawl(job.projectId, approval.config, { approved: true, jobId });
  }
}

function renderCrawlMarkdown(config: CrawlConfig, papers: Paper[], warnings: string[]): string {
  const lines = [
    `# Crawl Digest: ${config.topic}`,
    "",
    `Sources: ${config.sourceIds.join(", ")}`,
    `Open access only: ${config.openAccessOnly ? "yes" : "no"}`,
    `Papers retained: ${papers.length}`,
    ""
  ];
  if (warnings.length) {
    lines.push("## Warnings", "", ...warnings.map((warning) => `- ${warning}`), "");
  }
  lines.push("## Papers", "");
  for (const paper of papers) {
    lines.push(
      `### ${paper.title}`,
      "",
      [
        paper.authors.length ? `Authors: ${paper.authors.slice(0, 8).join(", ")}` : undefined,
        paper.year ? `Year: ${paper.year}` : undefined,
        paper.venue ? `Venue: ${paper.venue}` : undefined,
        paper.doi ? `DOI: ${paper.doi}` : undefined,
        paper.url ? `URL: ${paper.url}` : undefined,
        paper.pdfUrl ? `PDF: ${paper.pdfUrl}` : undefined
      ]
        .filter(Boolean)
        .join(" | "),
      "",
      paper.abstract ?? "_No abstract available._",
      ""
    );
  }
  return lines.join("\n");
}
