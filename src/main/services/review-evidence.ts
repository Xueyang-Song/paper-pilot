import type { ReviewStage } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import type { ReviewAgentEvidence } from "./review-agent-utils.js";

const trustedFullTextTypes = new Set(["paper-pdf", "markdown", "table"]);

export function collectReviewPaperEvidence(input: {
  db: PaperPilotDb;
  projectId: string;
  paperId: string;
  stage: ReviewStage;
  query: string;
  limit?: number;
}): ReviewAgentEvidence[] {
  const paper = input.db.getPaper(input.projectId, input.paperId);
  if (!paper) throw new Error(`Paper not found: ${input.paperId}`);
  const limit = Math.max(1, Math.min(input.limit ?? 12, 24));
  if (input.stage === "title-abstract") {
    const metadata = [
      `Title: ${paper.title}`,
      paper.authors.length ? `Authors: ${paper.authors.join("; ")}` : undefined,
      paper.year ? `Year: ${paper.year}` : undefined,
      paper.venue ? `Venue: ${paper.venue}` : undefined,
      paper.doi ? `DOI: ${paper.doi}` : undefined,
      paper.url ? `URL: ${paper.url}` : undefined
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const entries: ReviewAgentEvidence[] = [
      {
        evidenceId: "S1",
        paperId: paper.id,
        sourceType: "paper",
        title: paper.title,
        excerpt: metadata,
        locator: "Paper metadata"
      }
    ];
    const abstract = paper.abstract?.trim();
    if (abstract && limit > 1) {
      entries.push({
        evidenceId: "S2",
        paperId: paper.id,
        sourceType: "paper",
        title: paper.title,
        excerpt: abstract.slice(0, 8_000),
        locator: "Abstract"
      });
    }
    return entries;
  }

  const linkedArtifacts = input.db
    .listArtifacts(input.projectId)
    .filter(
      (artifact) =>
        trustedFullTextTypes.has(artifact.type) &&
        artifact.type !== "chat-answer" &&
        artifact.source !== "research-chat" &&
        metadataString(artifact.metadata.paperId) === paper.id
    );
  const entries: Omit<ReviewAgentEvidence, "evidenceId">[] = [];
  const seen = new Set<string>();
  const add = (entry: Omit<ReviewAgentEvidence, "evidenceId">): void => {
    const key = `${entry.artifactId}:${entry.chunkId ?? entry.excerpt.slice(0, 120)}`;
    if (seen.has(key) || entries.length >= limit) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const artifact of linkedArtifacts) {
    for (const row of input.db.searchIndexedChunks({
      projectId: input.projectId,
      artifactId: artifact.id,
      query: input.query,
      limit
    })) {
      const metadata = safeJson(row.metadataJson);
      add({
        paperId: paper.id,
        sourceType: "artifact",
        artifactId: artifact.id,
        chunkId: row.chunkId,
        title: paper.title,
        excerpt: row.text.slice(0, 4_000),
        page: positiveInteger(metadata.page),
        locator: locatorFromMetadata(metadata)
      });
    }
  }
  for (const artifact of linkedArtifacts) {
    if (entries.length >= limit) break;
    for (const row of input.db.listArtifactChunks(input.projectId, artifact.id, limit)) {
      const metadata = safeJson(row.metadataJson);
      add({
        paperId: paper.id,
        sourceType: "artifact",
        artifactId: artifact.id,
        chunkId: row.chunkId,
        title: paper.title,
        excerpt: row.text.slice(0, 4_000),
        page: positiveInteger(metadata.page),
        locator: locatorFromMetadata(metadata)
      });
    }
  }
  return entries.map((entry, index) => ({ ...entry, evidenceId: `S${index + 1}` }));
}

export function hasIndexedReviewFullText(db: PaperPilotDb, projectId: string, paperId: string): boolean {
  return db.listArtifacts(projectId).some((artifact) => {
    if (!trustedFullTextTypes.has(artifact.type) || metadataString(artifact.metadata.paperId) !== paperId) return false;
    return db.listArtifactChunks(projectId, artifact.id, 1).length > 0;
  });
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function locatorFromMetadata(metadata: Record<string, unknown>): string | undefined {
  if (positiveInteger(metadata.page)) return `Page ${positiveInteger(metadata.page)}`;
  return metadataString(metadata.locator) ?? metadataString(metadata.heading) ?? metadataString(metadata.section);
}
