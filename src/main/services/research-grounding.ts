import type { Citation, Message, SourceRef } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { id } from "../utils.js";

export interface ResearchEvidence {
  evidenceId: string;
  sourceType: "paper" | "artifact";
  paperId?: string;
  artifactId?: string;
  chunkId?: string;
  title: string;
  excerpt: string;
  page?: number;
  locator?: string;
  doi?: string;
  url?: string;
  retrievalScore?: number;
}

const trustedArtifactTypes = new Set(["paper-pdf", "metadata-json", "markdown", "table"]);

export function collectResearchEvidence(
  db: PaperPilotDb,
  projectId: string,
  query: string,
  sourceRefs: SourceRef[],
  limit = 12
): ResearchEvidence[] {
  const pinnedPaperIds = new Set(sourceRefs.filter((ref) => ref.type === "paper").map((ref) => ref.id));
  const pinnedArtifactIds = new Set(sourceRefs.filter((ref) => ref.type === "artifact").map((ref) => ref.id));
  const constrained = sourceRefs.length > 0;
  const evidence: Omit<ResearchEvidence, "evidenceId">[] = [];
  const perSource = new Map<string, number>();
  const seen = new Set<string>();
  const projectPapers = db.listPapers(projectId);
  const paperById = new Map(projectPapers.map((paper) => [paper.id, paper]));

  const add = (candidate: Omit<ResearchEvidence, "evidenceId">): void => {
    const sourceKey = candidate.paperId ? `paper:${candidate.paperId}` : `artifact:${candidate.artifactId}`;
    const key = `${sourceKey}:${candidate.chunkId ?? candidate.excerpt.slice(0, 100)}`;
    if (seen.has(key) || (perSource.get(sourceKey) ?? 0) >= 2 || evidence.length >= limit) return;
    seen.add(key);
    perSource.set(sourceKey, (perSource.get(sourceKey) ?? 0) + 1);
    evidence.push(candidate);
  };

  const paperTerms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((term) => term.length > 2);
  const scoredPapers = projectPapers
    .filter((paper) => !constrained || pinnedPaperIds.has(paper.id))
    .map((paper) => ({
      paper,
      score: paperTerms.reduce((sum, term) => {
        const haystack =
          `${paper.title} ${paper.abstract ?? ""} ${paper.authors.join(" ")} ${paper.venue ?? ""}`.toLowerCase();
        return sum + (haystack.includes(term) ? 1 : 0);
      }, 0)
    }))
    .sort((a, b) => b.score - a.score || (b.paper.citationCount ?? 0) - (a.paper.citationCount ?? 0));
  const matchingPapers = scoredPapers.filter(({ score }) => constrained || score > 0);
  const papers = matchingPapers.length || constrained ? matchingPapers : scoredPapers.slice(0, 6);
  for (const { paper, score } of papers.slice(0, 6)) {
    add({
      sourceType: "paper",
      paperId: paper.id,
      title: paper.title,
      excerpt: (paper.abstract || renderPaperMetadata(paper)).slice(0, 1_600),
      locator: paper.abstract ? "Abstract" : "Paper metadata",
      doi: paper.doi,
      url: paper.url,
      retrievalScore: score
    });
  }

  const chunkRows = db.searchIndexedChunks({ query, projectId, limit: Math.max(limit * 3, 24) });
  for (const row of chunkRows) {
    const artifact = db.getArtifact(projectId, row.artifactId);
    if (!artifact || !isTrustedArtifact(artifact.type, artifact.source)) continue;
    if (constrained && !pinnedArtifactIds.has(row.artifactId) && !(row.paperId && pinnedPaperIds.has(row.paperId))) {
      continue;
    }
    const metadata = safeJson(row.metadataJson);
    const linkedPaper = row.paperId ? paperById.get(row.paperId) : undefined;
    add({
      sourceType: "artifact",
      paperId: row.paperId,
      artifactId: row.artifactId,
      chunkId: row.chunkId,
      title: row.paperTitle || row.artifactTitle,
      excerpt: row.text.slice(0, 1_600),
      page: positiveNumber(metadata.page),
      locator: locatorFromMetadata(metadata),
      doi: linkedPaper?.doi,
      url: linkedPaper?.url,
      retrievalScore: row.score
    });
  }

  const fallbackArtifactIds = constrained
    ? [...pinnedArtifactIds]
    : db
        .listArtifacts(projectId)
        .filter((artifact) => isTrustedArtifact(artifact.type, artifact.source))
        .slice(0, 6)
        .map((artifact) => artifact.id);
  for (const artifactId of fallbackArtifactIds) {
    for (const row of db.listArtifactChunks(projectId, artifactId, 2)) {
      const artifact = db.getArtifact(projectId, row.artifactId);
      if (!artifact || !isTrustedArtifact(artifact.type, artifact.source)) continue;
      const metadata = safeJson(row.metadataJson);
      const linkedPaper = row.paperId ? paperById.get(row.paperId) : undefined;
      add({
        sourceType: "artifact",
        paperId: row.paperId,
        artifactId: row.artifactId,
        chunkId: row.chunkId,
        title: row.paperTitle || row.artifactTitle,
        excerpt: row.text.slice(0, 1_600),
        page: positiveNumber(metadata.page),
        locator: locatorFromMetadata(metadata),
        doi: linkedPaper?.doi,
        url: linkedPaper?.url,
        retrievalScore: row.score
      });
    }
  }

  // Vector results supplement lexical retrieval. They intentionally remain artifact-level when
  // sqlite-vec does not return the originating chunk id.
  for (const row of db.hybridSearchChunks(projectId, query, Math.max(limit * 2, 16))) {
    const artifact = db.getArtifact(projectId, row.artifactId);
    if (!artifact || !isTrustedArtifact(artifact.type, artifact.source)) continue;
    if (constrained && !pinnedArtifactIds.has(row.artifactId)) continue;
    add({
      sourceType: "artifact",
      artifactId: row.artifactId,
      title: artifact.title,
      excerpt: row.text.slice(0, 1_600),
      doi: metadataString(artifact.metadata.doi),
      url: metadataUrl(artifact.metadata.url) ?? metadataUrl(artifact.metadata.pdfUrl),
      retrievalScore: row.score
    });
  }

  return evidence.slice(0, limit).map((entry, index) => ({ ...entry, evidenceId: `S${index + 1}` }));
}

export function formatEvidenceBundle(evidence: ResearchEvidence[]): string {
  return evidence
    .map(
      (entry) => `[${entry.evidenceId}] ${entry.title}${entry.locator ? ` — ${entry.locator}` : ""}\n${entry.excerpt}`
    )
    .join("\n\n");
}

export function buildRecentContext(
  messages: Message[],
  provider: "ollama" | "vercel" | "openai-compatible",
  fixedInput: string,
  reservedToolTokens = 0
): { messages: Message[]; included: number; omitted: number } {
  const contextLimit = provider === "ollama" ? 8_192 : 16_384;
  const inputBudget = Math.floor(contextLimit * 0.75);
  let remaining = Math.max(0, inputBudget - estimateTokens(fixedInput) - reservedToolTokens);
  const eligible = messages.filter(
    (message) => message.status === "completed" && (message.role === "user" || message.role === "assistant")
  );
  const turns: Message[][] = [];
  for (const message of eligible) {
    if (message.role === "user") turns.push([message]);
    else if (turns.length) turns.at(-1)!.push(message);
  }
  const includedTurns: Message[][] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const cost = turn.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0);
    if (cost > remaining) break;
    includedTurns.unshift(turn);
    remaining -= cost;
  }
  const included = includedTurns.flat();
  return { messages: included, included: included.length, omitted: eligible.length - included.length };
}

export function validateResearchCitations(
  content: string,
  evidence: ResearchEvidence[],
  requireCoverage: boolean
): { valid: boolean; invalidIds: string[]; uncoveredBlocks: string[]; referencedIds: string[] } {
  const allowed = new Set(evidence.map((entry) => entry.evidenceId));
  const referencedIds = [...content.matchAll(/\[\[(S\d+)\]\]/g)].map((match) => match[1]);
  const invalidIds = [...new Set(referencedIds.filter((value) => !allowed.has(value)))];
  const uncoveredBlocks = requireCoverage
    ? substantiveBlocks(content).filter((block) => !/\[\[S\d+\]\]/.test(block))
    : [];
  return {
    valid: invalidIds.length === 0 && uncoveredBlocks.length === 0,
    invalidIds,
    uncoveredBlocks,
    referencedIds: [...new Set(referencedIds.filter((value) => allowed.has(value)))]
  };
}

export function citationsForAnswer(
  runId: string,
  messageId: string,
  referencedIds: string[],
  evidence: ResearchEvidence[]
): Citation[] {
  const byId = new Map(evidence.map((entry) => [entry.evidenceId, entry]));
  return referencedIds.flatMap((evidenceId) => {
    const entry = byId.get(evidenceId);
    if (!entry) return [];
    return [
      {
        id: id("cite"),
        runId,
        messageId,
        evidenceId,
        sourceType: entry.sourceType,
        paperId: entry.paperId,
        artifactId: entry.artifactId,
        chunkId: entry.chunkId,
        title: entry.title,
        excerpt: entry.excerpt,
        page: entry.page,
        locator: entry.locator,
        doi: entry.doi,
        url: entry.url,
        retrievalScore: entry.retrievalScore
      }
    ];
  });
}

export function answerArtifactMarkdown(input: {
  content: string;
  prompt: string;
  mode: "grounded" | "exploratory";
  provider: string;
  model: string;
  conversationTitle: string;
  citations: Citation[];
  sourceRefs: SourceRef[];
}): string {
  const provenance =
    input.mode === "exploratory"
      ? "> Exploratory answer: this output may include model knowledge not supported by the project corpus."
      : "> Grounded answer: citation markers map to the project evidence listed below.";
  const sources = input.citations.length
    ? input.citations.map(
        (citation) =>
          `- **${citation.evidenceId}: ${citation.title}**${citation.locator ? ` (${citation.locator})` : ""}\n  ${citation.excerpt}`
      )
    : ["- No project sources were cited."];
  return [
    provenance,
    "",
    `Request: ${input.prompt}`,
    "",
    input.content,
    "",
    "---",
    "",
    `Conversation: ${input.conversationTitle}`,
    `Mode: ${input.mode}`,
    `Provider: ${input.provider}`,
    `Model: ${input.model}`,
    `Created: ${new Date().toISOString()}`,
    `Source scope: ${input.sourceRefs.length ? `${input.sourceRefs.length} pinned source(s)` : "trusted project corpus"}`,
    "",
    "## Sources",
    "",
    ...sources
  ].join("\n");
}

export function deriveConversationTitle(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

function substantiveBlocks(content: string): string[] {
  return content
    .split(/\n{2,}|\n(?=- |\* |\d+\. |\|)/)
    .map((block) => block.trim())
    .filter((block) => {
      if (block.length < 15) return false;
      if (/^(#|>|```)/.test(block)) return false;
      if (/^\|?[\s:|-]+$/.test(block) && /-{3,}/.test(block)) return false;
      if (/^(I (?:could not|couldn't)|No project evidence|Insufficient evidence)/i.test(block)) return false;
      return /[A-Za-z]{4}/.test(block);
    });
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isTrustedArtifact(type: string, source?: string): boolean {
  return trustedArtifactTypes.has(type) && source !== "ai-service" && source !== "research-chat";
}

function safeJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function locatorFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const page = positiveNumber(metadata.page);
  if (page) return `Page ${page}`;
  if (typeof metadata.heading === "string" && metadata.heading.trim()) return metadata.heading.trim();
  return undefined;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataUrl(value: unknown): string | undefined {
  const candidate = metadataString(value);
  return candidate && /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

function renderPaperMetadata(paper: ReturnType<PaperPilotDb["listPapers"]>[number]): string {
  return [
    paper.authors.length ? `Authors: ${paper.authors.join(", ")}` : undefined,
    paper.year ? `Year: ${paper.year}` : undefined,
    paper.venue ? `Venue: ${paper.venue}` : undefined,
    paper.doi ? `DOI: ${paper.doi}` : undefined
  ]
    .filter(Boolean)
    .join(". ");
}
