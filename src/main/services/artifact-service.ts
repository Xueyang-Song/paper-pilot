import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { PDFParse } from "pdf-parse";
import type { Artifact, ArtifactType } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { ensureDir, id, projectDataPath, safeFilename, sha256 } from "../utils.js";

interface IndexChunk {
  text: string;
  metadata?: Record<string, unknown>;
}

const mimeByType: Record<ArtifactType, string> = {
  "metadata-json": "application/json",
  "paper-pdf": "application/pdf",
  markdown: "text/markdown",
  "crawl-log": "text/plain",
  brief: "text/markdown",
  "chat-answer": "text/markdown",
  script: "text/x-python",
  table: "text/csv"
};

export class ArtifactService {
  constructor(
    private readonly db: PaperPilotDb,
    private readonly dataRoot: string
  ) {}

  async writeArtifact(input: {
    projectId: string;
    type: ArtifactType;
    title: string;
    content: Buffer | string;
    extension?: string;
    source?: string;
    parentArtifactId?: string;
    metadata?: Record<string, unknown>;
    indexText?: boolean;
  }): Promise<Artifact> {
    const createdAt = new Date().toISOString();
    const artifactId = id("art");
    const extension = input.extension ?? defaultExtension(input.type);
    const artifactDir = projectDataPath(this.dataRoot, input.projectId, "artifacts");
    await ensureDir(artifactDir);
    const filename = `${createdAt.replace(/[:.]/g, "-")}-${safeFilename(input.title)}-${artifactId}${extension}`;
    const path = join(artifactDir, filename);
    await writeFile(path, input.content);
    const artifact: Artifact = {
      id: artifactId,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      path,
      mime: mimeByType[input.type] ?? mimeFromExtension(path),
      hash: sha256(input.content),
      source: input.source,
      parentArtifactId: input.parentArtifactId,
      metadata: input.metadata ?? {},
      createdAt
    };
    this.db.saveArtifact(artifact);
    if (input.indexText !== false) await this.indexArtifactContent(artifact, input.content);
    return artifact;
  }

  async importFile(input: {
    projectId: string;
    type: ArtifactType;
    title: string;
    sourcePath: string;
    source?: string;
    parentArtifactId?: string;
    metadata?: Record<string, unknown>;
    indexText?: boolean;
  }): Promise<Artifact> {
    const content = await readFile(input.sourcePath);
    const createdAt = new Date().toISOString();
    const artifactId = id("art");
    const artifactDir = projectDataPath(this.dataRoot, input.projectId, "artifacts");
    await ensureDir(artifactDir);
    const extension = extname(input.sourcePath) || defaultExtension(input.type);
    const path = join(
      artifactDir,
      `${createdAt.replace(/[:.]/g, "-")}-${safeFilename(input.title)}-${artifactId}${extension}`
    );
    await copyFile(input.sourcePath, path);
    const artifact: Artifact = {
      id: artifactId,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      path,
      mime: mimeByType[input.type] ?? mimeFromExtension(path),
      hash: sha256(content),
      source: input.source,
      parentArtifactId: input.parentArtifactId,
      metadata: input.metadata ?? {},
      createdAt
    };
    this.db.saveArtifact(artifact);
    if (input.indexText !== false) await this.indexArtifactContent(artifact, content);
    return artifact;
  }

  async readArtifact(artifact: Artifact): Promise<Buffer> {
    return readFile(artifact.path);
  }

  renameArtifact(projectId: string, artifactId: string, title: string): Artifact {
    return this.db.updateArtifact(projectId, artifactId, { title });
  }

  async deleteArtifact(projectId: string, artifactId: string): Promise<Artifact> {
    const artifact = this.db.deleteArtifact(projectId, artifactId);
    await unlink(artifact.path).catch(() => undefined);
    return artifact;
  }

  async exportArtifacts(input: {
    projectId: string;
    artifactIds: string[];
    targetDir: string;
  }): Promise<{ exported: number; paths: string[] }> {
    const artifacts = input.artifactIds
      .map((artifactId) => this.db.getArtifact(input.projectId, artifactId))
      .filter((artifact): artifact is Artifact => Boolean(artifact));
    const paths: string[] = [];
    await ensureDir(input.targetDir);
    for (const artifact of artifacts) {
      const targetPath = join(
        input.targetDir,
        `${safeFilename(artifact.title)}-${artifact.id}${extname(artifact.path) || defaultExtension(artifact.type)}`
      );
      await copyFile(artifact.path, targetPath);
      paths.push(targetPath);
    }
    return { exported: paths.length, paths };
  }

  async importUnknownFile(input: {
    projectId: string;
    sourcePath: string;
    title?: string;
    source?: string;
  }): Promise<Artifact> {
    const type = artifactTypeFromPath(input.sourcePath);
    return this.importFile({
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      title: input.title?.trim() || basename(input.sourcePath),
      type,
      source: input.source ?? "manual-import",
      metadata: { sourcePath: input.sourcePath }
    });
  }

  async indexArtifact(
    artifact: Artifact,
    options: { replace?: boolean } = {}
  ): Promise<{ chunkCount: number; warning?: string }> {
    if (artifact.type === "chat-answer" || artifact.source === "research-chat") {
      this.db.clearDocumentChunksForArtifact(artifact.id);
      return { chunkCount: 0, warning: `${artifact.title}: generated answers are intentionally not indexed.` };
    }
    const content = await readFile(artifact.path);
    return this.indexArtifactContent(artifact, content, options);
  }

  private async indexArtifactContent(
    artifact: Artifact,
    content: Buffer | string,
    options: { replace?: boolean } = {}
  ): Promise<{ chunkCount: number; warning?: string }> {
    try {
      const chunks = await buildIndexChunks(artifact, content);
      if (!chunks.length) return { chunkCount: 0, warning: `${artifact.title}: no indexable text found.` };
      if (options.replace) this.db.clearDocumentChunksForArtifact(artifact.id);
      this.db.addDocumentChunks({
        projectId: artifact.projectId,
        artifactId: artifact.id,
        paperId: metadataString(artifact.metadata.paperId),
        chunks
      });
      return { chunkCount: chunks.length };
    } catch (error) {
      return {
        chunkCount: 0,
        warning: `${artifact.title}: indexing failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}

export function chunkText(text: string, targetWords = 650): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  for (let index = 0; index < words.length; index += targetWords) {
    chunks.push(words.slice(index, index + targetWords).join(" "));
  }
  return chunks;
}

function defaultExtension(type: ArtifactType): string {
  switch (type) {
    case "metadata-json":
      return ".json";
    case "paper-pdf":
      return ".pdf";
    case "script":
      return ".py";
    case "table":
      return ".csv";
    default:
      return ".md";
  }
}

function artifactTypeFromPath(path: string): ArtifactType {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "metadata-json";
    case ".pdf":
      return "paper-pdf";
    case ".md":
    case ".markdown":
    case ".txt":
      return "markdown";
    case ".py":
      return "script";
    case ".csv":
    case ".tsv":
      return "table";
    default:
      return "markdown";
  }
}

function mimeFromExtension(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".py":
      return "text/x-python";
    default:
      return "application/octet-stream";
  }
}

async function buildIndexChunks(artifact: Artifact, content: Buffer | string): Promise<IndexChunk[]> {
  if (typeof content === "string") return chunksForText(content);
  if (isTextArtifact(artifact)) return chunksForText(content.toString("utf8"));
  if (
    artifact.mime === "application/pdf" ||
    artifact.type === "paper-pdf" ||
    extname(artifact.path).toLowerCase() === ".pdf"
  ) {
    const parser = new PDFParse({ data: content });
    try {
      const result = await parser.getText();
      const chunks: IndexChunk[] = [];
      for (const page of result.pages) {
        const pageNumber = Number(page.num);
        chunksForText(page.text).forEach((chunk, index) => {
          chunks.push({
            text: chunk.text,
            metadata: {
              ...chunk.metadata,
              page: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : undefined,
              pageChunk: index
            }
          });
        });
      }
      return chunks;
    } finally {
      await parser.destroy();
    }
  }
  return [];
}

function chunksForText(text: string): IndexChunk[] {
  return chunkText(text).map((chunk, ordinal) => ({ text: chunk, metadata: { ordinal, source: "artifact-index" } }));
}

function isTextArtifact(artifact: Artifact): boolean {
  return (
    artifact.mime.startsWith("text/") ||
    artifact.mime === "application/json" ||
    ["metadata-json", "markdown", "crawl-log", "brief", "script", "table"].includes(artifact.type)
  );
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
