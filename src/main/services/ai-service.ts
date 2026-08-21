import { z } from "zod";
import {
  aiModelListSchema,
  aiProviderHealthSchema,
  type AiModelInfo,
  type AiModelList,
  type AiModelListRequest,
  type AiProviderCheckRequest,
  type AiProviderHealth,
  type AppSettings,
  type Paper
} from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import type { ArtifactService } from "./artifact-service.js";
import type { CredentialService } from "./credential-service.js";
import type { JobQueue } from "./job-queue.js";
import type { SettingsService } from "./settings-service.js";

const ollamaTagsResponseSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string().optional(),
        model: z.string().optional(),
        modified_at: z.string().optional(),
        size: z.number().nonnegative().optional(),
        details: z
          .object({
            family: z.string().optional(),
            parameter_size: z.string().optional(),
            quantization_level: z.string().optional()
          })
          .optional()
      })
    )
    .default([])
});

const openAiModelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1) })).default([])
});

export class AiService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly settings: SettingsService,
    private readonly credentials: CredentialService,
    private readonly artifacts: ArtifactService,
    private readonly jobs: JobQueue
  ) {}

  async generateResearchBrief(
    projectId: string,
    prompt: string
  ): Promise<{ content: string; artifactId: string; jobId: string }> {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const job = this.jobs.create({ projectId, kind: "brief", status: "running", title: "Generating research brief" });
    const papers = this.db.listPapers(projectId).slice(0, 40);
    const chunks = this.db.hybridSearchChunks(projectId, prompt, 10);
    const settings = await this.settings.get();
    let content: string;
    let model = "local-structured";
    let aiWarning: string | undefined;
    let providerError: string | undefined;
    const attemptedModel = settings.ai.model;
    if (settings.ai.provider === "ollama") {
      this.jobs.update(job.id, { progress: 0.35, detail: `Calling local Ollama model ${settings.ai.model}.` });
      try {
        content = await this.callOllama(settings, renderBriefPrompt(project.title, prompt, papers, chunks));
        model = settings.ai.model;
      } catch (error) {
        providerError = formatProviderError(error);
        aiWarning = formatOllamaFallbackWarning(error);
        this.jobs.update(job.id, {
          progress: 0.55,
          detail: "Local Ollama model failed; using local structured synthesis."
        });
        content = [aiWarning, "", localBrief(project.title, prompt, papers, chunks)].join("\n");
      }
    } else if (settings.ai.provider === "openai-compatible" || settings.ai.hasApiKey) {
      this.jobs.update(job.id, {
        progress: 0.35,
        detail: `Calling configured ${providerLabel(settings.ai.provider)} model.`
      });
      try {
        content = await this.callGateway(settings, renderBriefPrompt(project.title, prompt, papers, chunks));
        model = settings.ai.model;
      } catch (error) {
        providerError = formatProviderError(error);
        aiWarning = formatAiGatewayFallbackWarning(error);
        this.jobs.update(job.id, {
          progress: 0.55,
          detail: "Configured AI model failed; using local structured synthesis."
        });
        content = [aiWarning, "", localBrief(project.title, prompt, papers, chunks)].join("\n");
      }
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
      metadata: {
        prompt,
        paperCount: papers.length,
        provider: settings.ai.provider,
        model,
        attemptedModel,
        providerError,
        aiWarning
      },
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
    if (settings.ai.provider === "vercel" && !apiKey) throw new Error("AI Gateway API key is not configured.");
    const response = await fetch(openAiCompatibleUrl(settings.ai.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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

  async callOllama(settings: AppSettings, prompt: string): Promise<string> {
    const response = await fetch(`${trimTrailingSlash(settings.ai.baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10 * 60 * 1000),
      body: JSON.stringify({
        model: settings.ai.model,
        stream: false,
        options: {
          temperature: 0.2,
          num_ctx: 8192
        },
        messages: [
          {
            role: "system",
            content:
              "You are Paper Pilot, a careful scientific research agent. Return concise, citation-backed research synthesis in Markdown. Cite papers by bracketed index like [P3]."
          },
          { role: "user", content: prompt }
        ]
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ollama request failed ${response.status}: ${detail.slice(0, 500)}`);
    }
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content ?? "No response content returned by the local Ollama model.";
  }

  async listModels(input: AiModelListRequest): Promise<AiModelList> {
    const models =
      input.provider === "ollama"
        ? await this.listOllamaModels(input.baseUrl)
        : await this.listOpenAiCompatibleModels(input.provider, input.baseUrl);
    return aiModelListSchema.parse({
      provider: input.provider,
      baseUrl: input.baseUrl,
      fetchedAt: new Date().toISOString(),
      models
    });
  }

  async checkProvider(input: AiProviderCheckRequest = {}): Promise<AiProviderHealth> {
    const current = await this.settings.get();
    const ai = { ...current.ai, ...(input ?? {}) };
    const checkedAt = new Date().toISOString();
    const hasApiKey = this.credentials.has("ai-gateway");
    try {
      if (ai.provider === "ollama") {
        const modelList = await this.listModels({ provider: ai.provider, baseUrl: ai.baseUrl });
        const models = modelList.models.map((model) => model.id);
        const status = models.length && models.includes(ai.model) ? "ok" : "warning";
        const detail = !models.length
          ? "Ollama is reachable, but no models are installed."
          : models.includes(ai.model)
            ? "Ollama is reachable."
            : `Ollama is reachable, but ${ai.model} is not installed.`;
        return aiProviderHealthSchema.parse({
          provider: ai.provider,
          baseUrl: ai.baseUrl,
          model: ai.model,
          hasApiKey,
          reachable: true,
          status,
          checkedAt,
          detail,
          models
        });
      }

      if (ai.provider === "vercel" && !hasApiKey) {
        return aiProviderHealthSchema.parse({
          provider: ai.provider,
          baseUrl: ai.baseUrl,
          model: ai.model,
          hasApiKey,
          reachable: false,
          status: "warning",
          checkedAt,
          detail: "No AI API key is stored."
        });
      }

      const modelList = await this.listModels({ provider: ai.provider, baseUrl: ai.baseUrl });
      const models = modelList.models.map((model) => model.id);
      return aiProviderHealthSchema.parse({
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        model: ai.model,
        hasApiKey,
        reachable: true,
        status: "ok",
        checkedAt,
        detail: `${providerLabel(ai.provider)} is reachable.`,
        models
      });
    } catch (error) {
      return aiProviderHealthSchema.parse({
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        model: ai.model,
        hasApiKey,
        reachable: false,
        status: "error",
        checkedAt,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async listOllamaModels(baseUrl: string): Promise<AiModelInfo[]> {
    const response = await fetch(`${trimTrailingSlash(baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Ollama model discovery failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : "."}`
      );
    }
    const parsed = ollamaTagsResponseSchema.parse(await response.json());
    return uniqueModels(
      parsed.models.flatMap((entry) => {
        const id = entry.model?.trim() || entry.name?.trim();
        if (!id) return [];
        return [
          {
            id,
            name: entry.name?.trim() || id,
            modifiedAt: entry.modified_at,
            sizeBytes: entry.size,
            family: entry.details?.family,
            parameterSize: entry.details?.parameter_size,
            quantizationLevel: entry.details?.quantization_level
          }
        ];
      })
    );
  }

  private async listOpenAiCompatibleModels(
    provider: Exclude<AppSettings["ai"]["provider"], "ollama">,
    baseUrl: string
  ): Promise<AiModelInfo[]> {
    const apiKey = this.credentials.get("ai-gateway");
    if (provider === "vercel" && !apiKey) throw new Error("AI Gateway API key is not configured.");
    const response = await fetch(openAiCompatibleUrl(baseUrl, "models"), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Model discovery failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : "."}`);
    }
    const parsed = openAiModelsResponseSchema.parse(await response.json());
    return uniqueModels(parsed.data.map(({ id }) => ({ id, name: id })));
  }
}

function uniqueModels(models: AiModelInfo[]): AiModelInfo[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  return [...byId.values()].sort(
    (left, right) =>
      (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "") || left.name.localeCompare(right.name)
  );
}

function providerLabel(provider: AppSettings["ai"]["provider"]): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "vercel") return "Vercel AI Gateway";
  return "OpenAI-compatible";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function openAiCompatibleUrl(baseUrl: string, resource: string): string {
  const normalizedBase = trimTrailingSlash(baseUrl);
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/${resource.replace(/^\/+/, "")}`;
}

function formatProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAiGatewayFallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const verificationRequired = /customer_verification_required|credit card on file|403/.test(message);
  return [
    "> Note: The configured AI Gateway request failed, so Paper Pilot used local structured synthesis instead.",
    verificationRequired
      ? "> Vercel AI Gateway reported that account verification is required before model requests can be served."
      : `> Gateway error: ${message.slice(0, 300)}`
  ].join("\n");
}

function formatOllamaFallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "> Note: The local Ollama model failed, so Paper Pilot used local structured synthesis instead.",
    `> Ollama error: ${message.slice(0, 300)}`
  ].join("\n");
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
  const cited = top
    .filter((paper) => paper.citationCount)
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
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
    ...(cited
      .slice(0, 5)
      .map(
        (paper) =>
          `- ${paper.title} [P${papers.indexOf(paper) + 1}]${paper.citationCount ? `, ${paper.citationCount} citations` : ""}`
      ) || []),
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
