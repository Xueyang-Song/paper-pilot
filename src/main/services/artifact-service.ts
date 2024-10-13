import { copyFile, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Artifact, ArtifactType } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { ensureDir, id, projectDataPath, safeFilename, sha256 } from "../utils.js";

const mimeByType: Record<ArtifactType, string> = {
  "metadata-json": "application/json",
  "paper-pdf": "application/pdf",
  markdown: "text/markdown",
  "crawl-log": "text/plain",
  brief: "text/markdown",
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
    if (input.indexText && typeof input.content === "string") {
      this.db.addDocumentChunks({
        projectId: input.projectId,
        artifactId,
        chunks: chunkText(input.content).map((text, ordinal) => ({ text, metadata: { ordinal } }))
      });
    }
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
    if (input.indexText && input.type !== "paper-pdf") {
      const text = content.toString("utf8");
      this.db.addDocumentChunks({
        projectId: input.projectId,
        artifactId,
        chunks: chunkText(text).map((chunk, ordinal) => ({ text: chunk, metadata: { ordinal } }))
      });
    }
    return artifact;
  }

  async readArtifact(artifact: Artifact): Promise<Buffer> {
    return readFile(artifact.path);
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
