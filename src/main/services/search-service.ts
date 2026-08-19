import type { SearchRequest, SearchResult, ReindexRequest, ReindexResponse } from "../../shared/schemas.js";
import { reindexResponseSchema, searchResponseSchema, type SearchResponse } from "../../shared/schemas.js";
import type { ChunkSearchRow, PaperPilotDb, PaperSearchRow } from "../db.js";
import type { ArtifactService } from "./artifact-service.js";

export class SearchService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly artifacts: ArtifactService
  ) {}

  search(input: SearchRequest): SearchResponse {
    const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
    const projectId = input.scope.type === "project" || input.scope.type === "file" ? input.scope.projectId : undefined;
    const artifactId = input.scope.type === "file" ? input.scope.artifactId : undefined;

    const paperRows =
      input.scope.type === "file"
        ? []
        : this.db.searchIndexedPapers({ query: input.query, projectId, limit: Math.min(limit, 50) });
    const chunkRows = this.db.searchIndexedChunks({
      query: input.query,
      projectId,
      artifactId,
      limit: input.scope.type === "file" ? limit : Math.min(limit * 2, 100)
    });

    const results = [...paperRows.map((row) => paperResult(row)), ...chunkRows.map((row) => chunkResult(row))]
      .sort(compareSearchResults)
      .slice(0, limit);

    return searchResponseSchema.parse({
      query: input.query,
      scope: input.scope,
      results
    });
  }

  async reindex(input: ReindexRequest = {}): Promise<ReindexResponse> {
    const paperCount = this.db.reindexPapers(input.projectId);
    const artifacts = input.projectId ? this.db.listArtifacts(input.projectId) : this.db.listAllArtifacts();
    const warnings: string[] = [];
    let chunkCount = 0;

    for (const artifact of artifacts) {
      const result = await this.artifacts.indexArtifact(artifact, { replace: true });
      chunkCount += result.chunkCount;
      if (result.warning) warnings.push(result.warning);
    }

    return reindexResponseSchema.parse({
      artifactCount: artifacts.length,
      paperCount,
      chunkCount,
      warnings
    });
  }
}

function paperResult(row: PaperSearchRow): SearchResult {
  return {
    id: `paper:${row.paperId}`,
    kind: "paper",
    projectId: row.projectId,
    projectTitle: row.projectTitle,
    artifactId: row.artifactId ?? undefined,
    artifactTitle: row.artifactTitle ?? undefined,
    artifactType: row.artifactType ?? undefined,
    paperId: row.paperId,
    paperTitle: row.paperTitle,
    title: row.paperTitle,
    subtitle: compactSubtitle([row.projectTitle, row.subtitle]),
    snippet: row.snippet,
    score: row.score,
    createdAt: row.updatedAt
  };
}

function chunkResult(row: ChunkSearchRow): SearchResult {
  return {
    id: `chunk:${row.chunkId}`,
    kind: "chunk",
    projectId: row.projectId,
    projectTitle: row.projectTitle,
    artifactId: row.artifactId,
    artifactTitle: row.artifactTitle,
    artifactType: row.artifactType,
    paperId: row.paperId ?? undefined,
    paperTitle: row.paperTitle ?? undefined,
    page: pageFromMetadata(row.metadataJson),
    title: row.artifactTitle,
    subtitle: compactSubtitle([row.projectTitle, row.paperTitle, row.artifactType]),
    snippet: row.snippet,
    score: row.score,
    createdAt: row.artifactCreatedAt
  };
}

function compactSubtitle(parts: Array<string | undefined>): string | undefined {
  const value = parts.filter((part): part is string => Boolean(part?.trim())).join(" / ");
  return value || undefined;
}

function compareSearchResults(left: SearchResult, right: SearchResult): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  const kindDelta = resultKindRank(left.kind) - resultKindRank(right.kind);
  if (kindDelta !== 0) return kindDelta;
  return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
}

function resultKindRank(kind: SearchResult["kind"]): number {
  return kind === "paper" ? 0 : 1;
}

function pageFromMetadata(value: string): number | undefined {
  try {
    const metadata = JSON.parse(value) as { page?: unknown };
    const page =
      typeof metadata.page === "number"
        ? metadata.page
        : typeof metadata.page === "string"
          ? Number(metadata.page)
          : undefined;
    return page && Number.isInteger(page) && page > 0 ? page : undefined;
  } catch {
    return undefined;
  }
}
