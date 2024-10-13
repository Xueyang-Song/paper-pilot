import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Artifact,
  artifactSchema,
  type Message,
  messageSchema,
  type Paper,
  paperDedupeKey,
  paperSchema,
  type Project,
  type ProjectPolicy,
  projectSchema
} from "../shared/schemas.js";
import { id, nowIso } from "./utils.js";

type Row = Record<string, unknown>;

const defaultPolicy: ProjectPolicy = {
  autonomy: "project",
  autoApproveSources: false,
  autoApproveScripts: false,
  autoApproveBrowserInstall: false,
  maxCrawlPapers: 50,
  warnOnPaidModelRuns: true
};

export class PaperPilotDb {
  private db: DatabaseSync;
  private vecAvailable = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.loadVectorExtension();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        topic TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        policy_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        policy_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_credentials (
        source_id TEXT NOT NULL,
        label TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, label)
      );

      CREATE TABLE IF NOT EXISTS papers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        dedupe_key TEXT NOT NULL,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        abstract TEXT,
        authors_json TEXT NOT NULL,
        year INTEGER,
        published_at TEXT,
        doi TEXT,
        url TEXT,
        pdf_url TEXT,
        source TEXT NOT NULL,
        source_paper_id TEXT,
        venue TEXT,
        citation_count INTEGER,
        is_open_access INTEGER NOT NULL,
        license TEXT,
        fields_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, dedupe_key)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL,
        mime TEXT NOT NULL,
        hash TEXT NOT NULL,
        source TEXT,
        parent_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_fts USING fts5(
        text,
        chunk_id UNINDEXED,
        project_id UNINDEXED,
        artifact_id UNINDEXED
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
        vec_rowid INTEGER UNIQUE,
        model TEXT NOT NULL,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chunk_id, model)
      );

      CREATE TABLE IF NOT EXISTS crawl_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    if (this.vecAvailable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings_vec USING vec0(
          embedding float[384],
          +chunk_id text
        );
      `);
    }
  }

  vectorSearchAvailable(): boolean {
    return this.vecAvailable;
  }

  createProject(title: string, topic?: string, policy: Partial<ProjectPolicy> = {}): Project {
    const createdAt = nowIso();
    const project: Project = {
      id: id("proj"),
      title,
      topic,
      createdAt,
      updatedAt: createdAt,
      policy: { ...defaultPolicy, ...policy }
    };
    const policyJson = JSON.stringify(project.policy);
    this.db
      .prepare(
        `INSERT INTO projects (id, title, topic, created_at, updated_at, policy_json)
         VALUES (@id, @title, @topic, @createdAt, @updatedAt, @policyJson)`
      )
      .run({
        id: project.id,
        title: project.title,
        topic: project.topic ?? null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        policyJson
      });
    this.db
      .prepare(`INSERT INTO project_policies (project_id, policy_json, updated_at) VALUES (?, ?, ?)`)
      .run(project.id, policyJson, createdAt);
    return projectSchema.parse(project);
  }

  listProjects(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
      .all()
      .map((row) => this.projectFromRow(row as Row));
  }

  getProject(projectId: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Row | undefined;
    return row ? this.projectFromRow(row) : undefined;
  }

  touchProject(projectId: string, title?: string): void {
    const updatedAt = nowIso();
    if (title) {
      this.db.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, projectId);
    } else {
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, projectId);
    }
  }

  updateProjectPolicy(projectId: string, patch: Partial<ProjectPolicy>): ProjectPolicy {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const policy = { ...defaultPolicy, ...project.policy, ...patch };
    const updatedAt = nowIso();
    const policyJson = JSON.stringify(policy);
    this.db.prepare("UPDATE projects SET policy_json = ?, updated_at = ? WHERE id = ?").run(policyJson, updatedAt, projectId);
    this.db
      .prepare(
        `INSERT INTO project_policies (project_id, policy_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`
      )
      .run(projectId, policyJson, updatedAt);
    return policy;
  }

  appendMessage(input: Omit<Message, "id" | "createdAt"> & { id?: string; createdAt?: string }): Message {
    const message: Message = {
      id: input.id ?? id("msg"),
      projectId: input.projectId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, project_id, role, content, metadata_json, created_at)
         VALUES (@id, @projectId, @role, @content, @metadataJson, @createdAt)`
      )
      .run({
        id: message.id,
        projectId: message.projectId,
        role: message.role,
        content: message.content,
        metadataJson: JSON.stringify(message.metadata),
        createdAt: message.createdAt
      });
    this.touchProject(message.projectId);
    return messageSchema.parse(message);
  }

  listMessages(projectId: string): Message[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC")
      .all(projectId)
      .map((row) => this.messageFromRow(row as Row));
  }

  savePaper(projectId: string, paperInput: Paper): Paper {
    const paper = paperSchema.parse({ ...paperInput, projectId });
    const createdAt = nowIso();
    const dedupeKey = paperDedupeKey(paper);
    const normalizedTitle = dedupeKey.startsWith("title:") ? dedupeKey.slice(6) : paper.title.toLowerCase();
    const row = {
      id: paper.id || id("paper"),
      projectId,
      dedupeKey,
      title: paper.title,
      normalizedTitle,
      abstract: paper.abstract ?? null,
      authorsJson: JSON.stringify(paper.authors),
      year: paper.year ?? null,
      publishedAt: paper.publishedAt ?? null,
      doi: paper.doi ?? null,
      url: paper.url ?? null,
      pdfUrl: paper.pdfUrl ?? null,
      source: paper.source,
      sourcePaperId: paper.sourcePaperId ?? null,
      venue: paper.venue ?? null,
      citationCount: paper.citationCount ?? null,
      isOpenAccess: paper.isOpenAccess ? 1 : 0,
      license: paper.license ?? null,
      fieldsJson: JSON.stringify(paper.fieldsOfStudy),
      rawJson: JSON.stringify(paper.raw ?? {}),
      createdAt,
      updatedAt: createdAt
    };
    this.db
      .prepare(
        `INSERT INTO papers (
          id, project_id, dedupe_key, title, normalized_title, abstract, authors_json, year,
          published_at, doi, url, pdf_url, source, source_paper_id, venue, citation_count,
          is_open_access, license, fields_json, raw_json, created_at, updated_at
        ) VALUES (
          @id, @projectId, @dedupeKey, @title, @normalizedTitle, @abstract, @authorsJson, @year,
          @publishedAt, @doi, @url, @pdfUrl, @source, @sourcePaperId, @venue, @citationCount,
          @isOpenAccess, @license, @fieldsJson, @rawJson, @createdAt, @updatedAt
        )
        ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
          abstract = COALESCE(excluded.abstract, papers.abstract),
          pdf_url = COALESCE(excluded.pdf_url, papers.pdf_url),
          citation_count = COALESCE(excluded.citation_count, papers.citation_count),
          is_open_access = MAX(excluded.is_open_access, papers.is_open_access),
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at`
      )
      .run(row);
    const saved = this.db
      .prepare("SELECT * FROM papers WHERE project_id = ? AND dedupe_key = ?")
      .get(projectId, dedupeKey) as Row;
    this.touchProject(projectId);
    return this.paperFromRow(saved);
  }

  listPapers(projectId: string): Paper[] {
    return this.db
      .prepare("SELECT * FROM papers WHERE project_id = ? ORDER BY citation_count DESC NULLS LAST, year DESC NULLS LAST")
      .all(projectId)
      .map((row) => this.paperFromRow(row as Row));
  }

  saveArtifact(artifact: Artifact): Artifact {
    const parsed = artifactSchema.parse(artifact);
    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, project_id, type, title, path, mime, hash, source, parent_artifact_id, metadata_json, created_at
        ) VALUES (
          @id, @projectId, @type, @title, @path, @mime, @hash, @source, @parentArtifactId, @metadataJson, @createdAt
        )`
      )
      .run({
        id: parsed.id,
        projectId: parsed.projectId,
        type: parsed.type,
        title: parsed.title,
        path: parsed.path,
        mime: parsed.mime,
        hash: parsed.hash,
        source: parsed.source ?? null,
        parentArtifactId: parsed.parentArtifactId ?? null,
        metadataJson: JSON.stringify(parsed.metadata),
        createdAt: parsed.createdAt
      });
    this.touchProject(parsed.projectId);
    return parsed;
  }

  listArtifacts(projectId: string): Artifact[] {
    return this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId)
      .map((row) => this.artifactFromRow(row as Row));
  }

  upsertEncryptedCredential(sourceId: string, label: string, secretCiphertext: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO source_credentials (source_id, label, secret_ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source_id, label) DO UPDATE SET
           secret_ciphertext = excluded.secret_ciphertext,
           updated_at = excluded.updated_at`
      )
      .run(sourceId, label, secretCiphertext, timestamp, timestamp);
  }

  getEncryptedCredential(sourceId: string, label = "default"): string | undefined {
    const row = this.db
      .prepare("SELECT secret_ciphertext FROM source_credentials WHERE source_id = ? AND label = ?")
      .get(sourceId, label) as { secret_ciphertext?: string } | undefined;
    return row?.secret_ciphertext;
  }

  listCredentialFlags(): Array<{ sourceId: string; label: string; updatedAt: string }> {
    return this.db
      .prepare("SELECT source_id as sourceId, label, updated_at as updatedAt FROM source_credentials ORDER BY source_id, label")
      .all() as Array<{ sourceId: string; label: string; updatedAt: string }>;
  }

  addDocumentChunks(input: {
    projectId: string;
    artifactId: string;
    paperId?: string;
    chunks: Array<{ text: string; metadata?: Record<string, unknown> }>;
  }): void {
    const insertChunk = this.db.prepare(
      `INSERT INTO document_chunks (
        id, artifact_id, project_id, paper_id, ordinal, text, token_count, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertFts = this.db.prepare(
      "INSERT INTO document_chunks_fts (text, chunk_id, project_id, artifact_id) VALUES (?, ?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      input.chunks.forEach((chunk, index) => {
        const chunkId = id("chunk");
        const tokenCount = Math.ceil(chunk.text.split(/\s+/).filter(Boolean).length * 1.3);
        insertChunk.run(
          chunkId,
          input.artifactId,
          input.projectId,
          input.paperId ?? null,
          index,
          chunk.text,
          tokenCount,
          JSON.stringify(chunk.metadata ?? {})
        );
        insertFts.run(chunk.text, chunkId, input.projectId, input.artifactId);
        this.insertLocalEmbedding(chunkId, chunk.text);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  searchChunks(projectId: string, query: string, limit = 12): Array<{ text: string; artifactId: string; score: number }> {
    const ftsQuery = query
      .split(/\s+/)
      .map((part) => part.replace(/["*]/g, "").trim())
      .filter((part) => part.length > 2)
      .slice(0, 12)
      .map((part) => `"${part}"`)
      .join(" OR ");
    if (!ftsQuery) return [];
    try {
      return this.db
        .prepare(
          `SELECT text, artifact_id as artifactId, bm25(document_chunks_fts) as score
           FROM document_chunks_fts
           WHERE document_chunks_fts MATCH ? AND project_id = ?
           ORDER BY score
           LIMIT ?`
        )
        .all(ftsQuery, projectId, limit) as Array<{ text: string; artifactId: string; score: number }>;
    } catch {
      return [];
    }
  }

  searchVectorChunks(projectId: string, query: string, limit = 12): Array<{ text: string; artifactId: string; score: number }> {
    if (!this.vecAvailable) return [];
    const vector = textEmbedding384(query);
    try {
      return this.db
        .prepare(
          `SELECT c.text as text, c.artifact_id as artifactId, v.distance as score
           FROM chunk_embeddings_vec v
           JOIN embeddings e ON e.vec_rowid = v.rowid
           JOIN document_chunks c ON c.id = e.chunk_id
           WHERE v.embedding MATCH ? AND k = ? AND c.project_id = ?
           ORDER BY v.distance
           LIMIT ?`
        )
        .all(JSON.stringify(vector), Math.max(limit * 4, limit), projectId, limit) as Array<{
        text: string;
        artifactId: string;
        score: number;
      }>;
    } catch {
      return [];
    }
  }

  hybridSearchChunks(projectId: string, query: string, limit = 12): Array<{ text: string; artifactId: string; score: number; mode: string }> {
    const vectorResults = this.searchVectorChunks(projectId, query, limit).map((result) => ({ ...result, mode: "vector" }));
    const ftsResults = this.searchChunks(projectId, query, limit).map((result) => ({ ...result, mode: "fts" }));
    const seen = new Set<string>();
    const merged: Array<{ text: string; artifactId: string; score: number; mode: string }> = [];
    for (const result of [...vectorResults, ...ftsResults]) {
      const key = `${result.artifactId}:${result.text.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(result);
      if (merged.length >= limit) break;
    }
    return merged;
  }

  private loadVectorExtension(): void {
    try {
      this.db.enableLoadExtension(true);
      loadSqliteVec(this.db);
      this.db.enableLoadExtension(false);
      this.vecAvailable = true;
    } catch {
      this.vecAvailable = false;
    }
  }

  private insertLocalEmbedding(chunkId: string, text: string): void {
    if (!this.vecAvailable) return;
    const vector = textEmbedding384(text);
    const row = this.db.prepare("SELECT vec_rowid FROM embeddings WHERE chunk_id = ? AND model = ?").get(chunkId, "local-hash-384") as
      | { vec_rowid?: number }
      | undefined;
    if (row?.vec_rowid) {
      this.db.prepare("DELETE FROM chunk_embeddings_vec WHERE rowid = ?").run(Number(row.vec_rowid));
    }
    const insertVec = this.db
      .prepare("INSERT INTO chunk_embeddings_vec(embedding, chunk_id) VALUES (?, ?)")
      .run(JSON.stringify(vector), chunkId);
    const vecRowId = Number(insertVec.lastInsertRowid);
    this.db
      .prepare(
        `INSERT INTO embeddings (id, chunk_id, vec_rowid, model, vector_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id, model) DO UPDATE SET vector_json = excluded.vector_json`
      )
      .run(id("emb"), chunkId, vecRowId, "local-hash-384", JSON.stringify(vector), nowIso());
  }

  private projectFromRow(row: Row): Project {
    return projectSchema.parse({
      id: row.id,
      title: row.title,
      topic: row.topic ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      policy: { ...defaultPolicy, ...JSON.parse(String(row.policy_json)) }
    });
  }

  private messageFromRow(row: Row): Message {
    return messageSchema.parse({
      id: row.id,
      projectId: row.project_id,
      role: row.role,
      content: row.content,
      metadata: JSON.parse(String(row.metadata_json)),
      createdAt: row.created_at
    });
  }

  private paperFromRow(row: Row): Paper {
    return paperSchema.parse({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      abstract: row.abstract ?? undefined,
      authors: JSON.parse(String(row.authors_json)),
      year: row.year ?? undefined,
      publishedAt: row.published_at ?? undefined,
      doi: row.doi ?? undefined,
      url: row.url ?? undefined,
      pdfUrl: row.pdf_url ?? undefined,
      source: row.source,
      sourcePaperId: row.source_paper_id ?? undefined,
      venue: row.venue ?? undefined,
      citationCount: row.citation_count ?? undefined,
      isOpenAccess: Boolean(row.is_open_access),
      license: row.license ?? undefined,
      fieldsOfStudy: JSON.parse(String(row.fields_json)),
      raw: JSON.parse(String(row.raw_json))
    });
  }

  private artifactFromRow(row: Row): Artifact {
    return artifactSchema.parse({
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      title: row.title,
      path: row.path,
      mime: row.mime,
      hash: row.hash,
      source: row.source ?? undefined,
      parentArtifactId: row.parent_artifact_id ?? undefined,
      metadata: JSON.parse(String(row.metadata_json)),
      createdAt: row.created_at
    });
  }
}

export function createDefaultProjectPolicy(): ProjectPolicy {
  return { ...defaultPolicy };
}

export function textEmbedding384(text: string): number[] {
  const vector = new Array<number>(384).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % vector.length;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
