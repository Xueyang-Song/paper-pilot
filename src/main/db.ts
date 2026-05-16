import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Artifact,
  artifactSchema,
  type Job,
  jobSchema,
  type Message,
  messageSchema,
  type Paper,
  paperDedupeKey,
  type PaperScore,
  paperSchema,
  paperScoreSchema,
  type Project,
  type ProjectPolicy,
  projectSchema
} from "../shared/schemas.js";
import { id, nowIso } from "./utils.js";

type Row = Record<string, unknown>;

export interface ChunkSearchRow {
  chunkId: string;
  projectId: string;
  projectTitle: string;
  artifactId: string;
  artifactTitle: string;
  artifactType: Artifact["type"];
  artifactCreatedAt: string;
  paperId?: string;
  paperTitle?: string;
  text: string;
  metadataJson: string;
  snippet: string;
  score: number;
}

export interface PaperSearchRow {
  paperId: string;
  projectId: string;
  projectTitle: string;
  artifactId?: string;
  artifactTitle?: string;
  artifactType?: Artifact["type"];
  paperTitle: string;
  subtitle: string;
  snippet: string;
  score: number;
  updatedAt: string;
}

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
        description TEXT,
        archived_at TEXT,
        pinned_at TEXT,
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
        score REAL,
        score_json TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        user_status TEXT NOT NULL DEFAULT 'unread',
        tags_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
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

      CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
        title,
        abstract,
        authors,
        venue,
        doi,
        paper_id UNINDEXED,
        project_id UNINDEXED
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

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        progress REAL NOT NULL,
        detail TEXT,
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
    this.ensureColumn("projects", "description", "TEXT");
    this.ensureColumn("projects", "archived_at", "TEXT");
    this.ensureColumn("projects", "pinned_at", "TEXT");
    this.ensureColumn("papers", "score", "REAL");
    this.ensureColumn("papers", "score_json", "TEXT");
    this.ensureColumn("papers", "favorite", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("papers", "user_status", "TEXT NOT NULL DEFAULT 'unread'");
    this.ensureColumn("papers", "tags_json", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("papers", "notes", "TEXT");
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

  createProject(title: string, topic?: string, policy: Partial<ProjectPolicy> = {}, description?: string): Project {
    const createdAt = nowIso();
    const project: Project = {
      id: id("proj"),
      title,
      topic,
      description,
      createdAt,
      updatedAt: createdAt,
      policy: { ...defaultPolicy, ...policy }
    };
    const policyJson = JSON.stringify(project.policy);
    this.db
      .prepare(
        `INSERT INTO projects (id, title, topic, description, created_at, updated_at, policy_json)
         VALUES (@id, @title, @topic, @description, @createdAt, @updatedAt, @policyJson)`
      )
      .run({
        id: project.id,
        title: project.title,
        topic: project.topic ?? null,
        description: project.description ?? null,
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
      .prepare(
        `SELECT * FROM projects
         ORDER BY
           CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
           CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END,
           pinned_at DESC,
           updated_at DESC`
      )
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

  renameProject(projectId: string, title: string): Project {
    const nextTitle = title.trim();
    if (!nextTitle) throw new Error("Project title cannot be empty.");
    this.touchProject(projectId, nextTitle);
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  updateProject(input: { projectId: string; title?: string; topic?: string; description?: string }): Project {
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const title = input.title === undefined ? project.title : input.title.trim();
    if (!title) throw new Error("Project title cannot be empty.");
    const topic = input.topic === undefined ? project.topic : normalizeOptional(input.topic);
    const description = input.description === undefined ? project.description : normalizeOptional(input.description);
    const updatedAt = nowIso();
    this.db
      .prepare("UPDATE projects SET title = ?, topic = ?, description = ?, updated_at = ? WHERE id = ?")
      .run(title, topic ?? null, description ?? null, updatedAt, input.projectId);
    const updated = this.getProject(input.projectId);
    if (!updated) throw new Error(`Project not found: ${input.projectId}`);
    return updated;
  }

  setProjectArchived(projectId: string, archived: boolean): Project {
    const updatedAt = nowIso();
    const archivedAt = archived ? updatedAt : null;
    const result = this.db
      .prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archivedAt, updatedAt, projectId);
    if (result.changes === 0) throw new Error(`Project not found: ${projectId}`);
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  setProjectPinned(projectId: string, pinned: boolean): Project {
    const updatedAt = nowIso();
    const pinnedAt = pinned ? updatedAt : null;
    const result = this.db
      .prepare("UPDATE projects SET pinned_at = ?, updated_at = ? WHERE id = ?")
      .run(pinnedAt, updatedAt, projectId);
    if (result.changes === 0) throw new Error(`Project not found: ${projectId}`);
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  deleteProject(projectId: string): void {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    if (result.changes === 0) throw new Error(`Project not found: ${projectId}`);
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

  clearMessages(projectId: string): number {
    const result = this.db.prepare("DELETE FROM messages WHERE project_id = ?").run(projectId);
    this.touchProject(projectId);
    return Number(result.changes);
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
      score: paper.score?.overall ?? null,
      scoreJson: paper.score ? JSON.stringify(paper.score) : null,
      favorite: paper.favorite ? 1 : 0,
      userStatus: paper.userStatus ?? "unread",
      tagsJson: JSON.stringify(paper.tags ?? []),
      notes: paper.notes ?? null,
      rawJson: JSON.stringify(paper.raw ?? {}),
      createdAt,
      updatedAt: createdAt
    };
    this.db
      .prepare(
        `INSERT INTO papers (
          id, project_id, dedupe_key, title, normalized_title, abstract, authors_json, year,
          published_at, doi, url, pdf_url, source, source_paper_id, venue, citation_count,
          is_open_access, license, fields_json, score, score_json, favorite, user_status, tags_json, notes, raw_json, created_at, updated_at
        ) VALUES (
          @id, @projectId, @dedupeKey, @title, @normalizedTitle, @abstract, @authorsJson, @year,
          @publishedAt, @doi, @url, @pdfUrl, @source, @sourcePaperId, @venue, @citationCount,
          @isOpenAccess, @license, @fieldsJson, @score, @scoreJson, @favorite, @userStatus, @tagsJson, @notes, @rawJson, @createdAt, @updatedAt
        )
        ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
          abstract = COALESCE(excluded.abstract, papers.abstract),
          pdf_url = COALESCE(excluded.pdf_url, papers.pdf_url),
          citation_count = COALESCE(excluded.citation_count, papers.citation_count),
          is_open_access = MAX(excluded.is_open_access, papers.is_open_access),
          score = COALESCE(excluded.score, papers.score),
          score_json = COALESCE(excluded.score_json, papers.score_json),
          raw_json = excluded.raw_json,
          updated_at = excluded.updated_at`
      )
      .run(row);
    const saved = this.db
      .prepare("SELECT * FROM papers WHERE project_id = ? AND dedupe_key = ?")
      .get(projectId, dedupeKey) as Row;
    this.indexPaperRow(saved);
    this.touchProject(projectId);
    return this.paperFromRow(saved);
  }

  listPapers(projectId: string): Paper[] {
    return this.db
      .prepare(
        "SELECT * FROM papers WHERE project_id = ? ORDER BY score DESC NULLS LAST, citation_count DESC NULLS LAST, year DESC NULLS LAST"
      )
      .all(projectId)
      .map((row) => this.paperFromRow(row as Row));
  }

  listAllPapers(): Paper[] {
    return this.db
      .prepare("SELECT * FROM papers ORDER BY score DESC NULLS LAST, citation_count DESC NULLS LAST, year DESC NULLS LAST")
      .all()
      .map((row) => this.paperFromRow(row as Row));
  }

  updatePaperScore(projectId: string, paperId: string, score: PaperScore): Paper {
    const parsed = paperScoreSchema.parse(score);
    const updatedAt = nowIso();
    const result = this.db
      .prepare("UPDATE papers SET score = ?, score_json = ?, updated_at = ? WHERE project_id = ? AND id = ?")
      .run(parsed.overall, JSON.stringify(parsed), updatedAt, projectId, paperId);
    if (result.changes === 0) throw new Error(`Paper not found: ${paperId}`);
    const row = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as Row | undefined;
    if (!row) throw new Error(`Paper not found: ${paperId}`);
    this.touchProject(projectId);
    return this.paperFromRow(row);
  }

  updatePaper(projectId: string, paperId: string, patch: Partial<Paper>): Paper {
    const currentRow = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as Row | undefined;
    if (!currentRow) throw new Error(`Paper not found: ${paperId}`);
    const current = this.paperFromRow(currentRow);
    const next = paperSchema.parse({ ...current, ...patch, projectId, id: paperId });
    const dedupeKey = paperDedupeKey(next);
    const normalizedTitle = dedupeKey.startsWith("title:") ? dedupeKey.slice(6) : next.title.toLowerCase();
    const updatedAt = nowIso();
    this.db
      .prepare(
        `UPDATE papers SET
          dedupe_key = @dedupeKey,
          title = @title,
          normalized_title = @normalizedTitle,
          abstract = @abstract,
          authors_json = @authorsJson,
          year = @year,
          published_at = @publishedAt,
          doi = @doi,
          url = @url,
          pdf_url = @pdfUrl,
          venue = @venue,
          citation_count = @citationCount,
          is_open_access = @isOpenAccess,
          license = @license,
          fields_json = @fieldsJson,
          favorite = @favorite,
          user_status = @userStatus,
          tags_json = @tagsJson,
          notes = @notes,
          updated_at = @updatedAt
         WHERE project_id = @projectId AND id = @paperId`
      )
      .run({
        projectId,
        paperId,
        dedupeKey,
        title: next.title,
        normalizedTitle,
        abstract: next.abstract ?? null,
        authorsJson: JSON.stringify(next.authors),
        year: next.year ?? null,
        publishedAt: next.publishedAt ?? null,
        doi: next.doi ?? null,
        url: next.url ?? null,
        pdfUrl: next.pdfUrl ?? null,
        venue: next.venue ?? null,
        citationCount: next.citationCount ?? null,
        isOpenAccess: next.isOpenAccess ? 1 : 0,
        license: next.license ?? null,
        fieldsJson: JSON.stringify(next.fieldsOfStudy),
        favorite: next.favorite ? 1 : 0,
        userStatus: next.userStatus ?? "unread",
        tagsJson: JSON.stringify(next.tags ?? []),
        notes: next.notes ?? null,
        updatedAt
      });
    const row = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as Row | undefined;
    if (!row) throw new Error(`Paper not found: ${paperId}`);
    this.indexPaperRow(row);
    this.touchProject(projectId);
    return this.paperFromRow(row);
  }

  deletePaper(projectId: string, paperId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM papers_fts WHERE paper_id = ?").run(paperId);
      const result = this.db.prepare("DELETE FROM papers WHERE project_id = ? AND id = ?").run(projectId, paperId);
      if (result.changes === 0) throw new Error(`Paper not found: ${paperId}`);
      this.db.exec("COMMIT");
      this.touchProject(projectId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  listAllArtifacts(): Artifact[] {
    return this.db
      .prepare("SELECT * FROM artifacts ORDER BY created_at DESC")
      .all()
      .map((row) => this.artifactFromRow(row as Row));
  }

  getArtifact(projectId: string, artifactId: string): Artifact | undefined {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE project_id = ? AND id = ?")
      .get(projectId, artifactId) as Row | undefined;
    return row ? this.artifactFromRow(row) : undefined;
  }

  updateArtifact(projectId: string, artifactId: string, patch: Partial<Pick<Artifact, "title" | "metadata">>): Artifact {
    const artifact = this.getArtifact(projectId, artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    const title = patch.title === undefined ? artifact.title : patch.title.trim();
    if (!title) throw new Error("Artifact title cannot be empty.");
    const metadata = patch.metadata === undefined ? artifact.metadata : patch.metadata;
    this.db
      .prepare("UPDATE artifacts SET title = ?, metadata_json = ? WHERE project_id = ? AND id = ?")
      .run(title, JSON.stringify(metadata), projectId, artifactId);
    this.touchProject(projectId);
    const updated = this.getArtifact(projectId, artifactId);
    if (!updated) throw new Error(`Artifact not found: ${artifactId}`);
    return updated;
  }

  deleteArtifact(projectId: string, artifactId: string): Artifact {
    const artifact = this.getArtifact(projectId, artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    this.clearDocumentChunksForArtifact(artifactId);
    const result = this.db.prepare("DELETE FROM artifacts WHERE project_id = ? AND id = ?").run(projectId, artifactId);
    if (result.changes === 0) throw new Error(`Artifact not found: ${artifactId}`);
    this.touchProject(projectId);
    return artifact;
  }

  saveJob(job: Job): Job {
    const parsed = jobSchema.parse(job);
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, project_id, kind, status, title, progress, detail, result_json, error, created_at, updated_at
        ) VALUES (
          @id, @projectId, @kind, @status, @title, @progress, @detail, @resultJson, @error, @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          kind = excluded.kind,
          status = excluded.status,
          title = excluded.title,
          progress = excluded.progress,
          detail = excluded.detail,
          result_json = excluded.result_json,
          error = excluded.error,
          updated_at = excluded.updated_at`
      )
      .run({
        id: parsed.id,
        projectId: parsed.projectId,
        kind: parsed.kind,
        status: parsed.status,
        title: parsed.title,
        progress: parsed.progress,
        detail: parsed.detail ?? null,
        resultJson: parsed.result ? JSON.stringify(parsed.result) : null,
        error: parsed.error ?? null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt
      });
    this.touchProject(parsed.projectId);
    return parsed;
  }

  getJob(jobId: string): Job | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? this.jobFromRow(row) : undefined;
  }

  listJobs(projectId?: string): Job[] {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all() as Row[]);
    return rows.map((row) => this.jobFromRow(row));
  }

  deleteJob(jobId: string): void {
    this.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  }

  clearTerminalJobs(projectId?: string): number {
    const statuses = ["completed", "failed", "cancelled"];
    const placeholders = statuses.map(() => "?").join(", ");
    const result = projectId
      ? this.db.prepare(`DELETE FROM jobs WHERE project_id = ? AND status IN (${placeholders})`).run(projectId, ...statuses)
      : this.db.prepare(`DELETE FROM jobs WHERE status IN (${placeholders})`).run(...statuses);
    return Number(result.changes);
  }

  markInterruptedJobs(): Job[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('queued', 'running')").all() as Row[];
    if (!rows.length) return [];
    const updatedAt = nowIso();
    return rows.map((row) => {
      const job = this.jobFromRow(row);
      const next = jobSchema.parse({
        ...job,
        status: "failed",
        progress: 1,
        detail: job.detail
          ? `${job.detail} Interrupted because Paper Pilot restarted before this job completed.`
          : "Interrupted because Paper Pilot restarted before this job completed.",
        error: job.error ?? "Interrupted by app restart.",
        updatedAt
      });
      return this.saveJob(next);
    });
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

  deleteCredential(sourceId: string, label = "default"): boolean {
    const result = this.db.prepare("DELETE FROM source_credentials WHERE source_id = ? AND label = ?").run(sourceId, label);
    return result.changes > 0;
  }

  addDocumentChunks(input: {
    projectId: string;
    artifactId: string;
    paperId?: string;
    chunks: Array<{ text: string; metadata?: Record<string, unknown> }>;
  }): void {
    if (!input.chunks.length) return;
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

  clearDocumentChunksForArtifact(artifactId: string): void {
    const rows = this.db.prepare("SELECT id FROM document_chunks WHERE artifact_id = ?").all(artifactId) as Array<{ id: string }>;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const embedding = this.db.prepare("SELECT vec_rowid FROM embeddings WHERE chunk_id = ?").get(row.id) as { vec_rowid?: number } | undefined;
        if (embedding?.vec_rowid && this.vecAvailable) {
          this.db.prepare("DELETE FROM chunk_embeddings_vec WHERE rowid = ?").run(Number(embedding.vec_rowid));
        }
        this.db.prepare("DELETE FROM embeddings WHERE chunk_id = ?").run(row.id);
        this.db.prepare("DELETE FROM document_chunks_fts WHERE chunk_id = ?").run(row.id);
      }
      this.db.prepare("DELETE FROM document_chunks WHERE artifact_id = ?").run(artifactId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  reindexPapers(projectId?: string): number {
    const rows = projectId
      ? (this.db.prepare("SELECT * FROM papers WHERE project_id = ?").all(projectId) as Row[])
      : (this.db.prepare("SELECT * FROM papers").all() as Row[]);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        this.indexPaperRow(row, false);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
  }

  searchIndexedPapers(input: { query: string; projectId?: string; limit?: number }): PaperSearchRow[] {
    const ftsQuery = buildFtsQuery(input.query);
    if (!ftsQuery) return [];
    const clauses = ["papers_fts MATCH @query"];
    if (input.projectId) clauses.push("papers_fts.project_id = @projectId");
    const params: Record<string, string | number> = { query: ftsQuery, limit: input.limit ?? 20 };
    if (input.projectId) params.projectId = input.projectId;
    try {
      return this.db
        .prepare(
          `SELECT
             papers_fts.paper_id as paperId,
             papers_fts.project_id as projectId,
             projects.title as projectTitle,
             artifacts.id as artifactId,
             artifacts.title as artifactTitle,
             artifacts.type as artifactType,
             papers.title as paperTitle,
             trim(
               coalesce(papers.venue, '') ||
               CASE WHEN papers.year IS NOT NULL THEN ' (' || papers.year || ')' ELSE '' END ||
               CASE WHEN papers.source IS NOT NULL THEN ' - ' || papers.source ELSE '' END
             ) as subtitle,
             CASE
               WHEN snippet(papers_fts, 1, '[[', ']]', '...', 32) LIKE '%[[%' THEN snippet(papers_fts, 1, '[[', ']]', '...', 32)
               WHEN snippet(papers_fts, 0, '[[', ']]', '...', 16) LIKE '%[[%' THEN snippet(papers_fts, 0, '[[', ']]', '...', 16)
               WHEN snippet(papers_fts, 3, '[[', ']]', '...', 16) LIKE '%[[%' THEN snippet(papers_fts, 3, '[[', ']]', '...', 16)
               ELSE snippet(papers_fts, 2, '[[', ']]', '...', 16)
             END as snippet,
             bm25(papers_fts) as score,
             papers.updated_at as updatedAt
           FROM papers_fts
           JOIN papers ON papers.id = papers_fts.paper_id
           JOIN projects ON projects.id = papers_fts.project_id
           LEFT JOIN artifacts ON artifacts.id = (
             SELECT candidate.id
             FROM artifacts candidate
             WHERE candidate.project_id = papers.project_id
               AND (
                 json_extract(candidate.metadata_json, '$.paperId') = papers.id
                 OR (
                   papers.doi IS NOT NULL
                   AND lower(coalesce(json_extract(candidate.metadata_json, '$.doi'), '')) = lower(papers.doi)
                 )
               )
             ORDER BY
               CASE candidate.type
                 WHEN 'paper-pdf' THEN 0
                 WHEN 'brief' THEN 1
                 WHEN 'markdown' THEN 2
                 ELSE 3
               END,
               candidate.created_at DESC
             LIMIT 1
           )
           WHERE ${clauses.join(" AND ")}
           ORDER BY score
           LIMIT @limit`
        )
        .all(params) as unknown as PaperSearchRow[];
    } catch {
      return [];
    }
  }

  searchIndexedChunks(input: { query: string; projectId?: string; artifactId?: string; limit?: number }): ChunkSearchRow[] {
    const ftsQuery = buildFtsQuery(input.query);
    if (!ftsQuery) return [];
    const clauses = ["document_chunks_fts MATCH @query"];
    if (input.projectId) clauses.push("document_chunks_fts.project_id = @projectId");
    if (input.artifactId) clauses.push("document_chunks_fts.artifact_id = @artifactId");
    const params: Record<string, string | number> = { query: ftsQuery, limit: input.limit ?? 20 };
    if (input.projectId) params.projectId = input.projectId;
    if (input.artifactId) params.artifactId = input.artifactId;
    try {
      return this.db
        .prepare(
          `SELECT
             document_chunks_fts.chunk_id as chunkId,
             document_chunks_fts.project_id as projectId,
             projects.title as projectTitle,
             document_chunks_fts.artifact_id as artifactId,
             artifacts.title as artifactTitle,
             artifacts.type as artifactType,
             artifacts.created_at as artifactCreatedAt,
             document_chunks.paper_id as paperId,
             papers.title as paperTitle,
             document_chunks.text as text,
             document_chunks.metadata_json as metadataJson,
             snippet(document_chunks_fts, 0, '[[', ']]', '...', 40) as snippet,
             bm25(document_chunks_fts) as score
           FROM document_chunks_fts
           JOIN document_chunks ON document_chunks.id = document_chunks_fts.chunk_id
           JOIN artifacts ON artifacts.id = document_chunks_fts.artifact_id
           JOIN projects ON projects.id = document_chunks_fts.project_id
           LEFT JOIN papers ON papers.id = document_chunks.paper_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY score
           LIMIT @limit`
        )
        .all(params) as unknown as ChunkSearchRow[];
    } catch {
      return [];
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

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

  private indexPaperRow(row: Row, wrapTransaction = true): void {
    const run = (): void => {
      const paperId = String(row.id);
      this.db.prepare("DELETE FROM papers_fts WHERE paper_id = ?").run(paperId);
      this.db
        .prepare(
          `INSERT INTO papers_fts (title, abstract, authors, venue, doi, paper_id, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          String(row.title ?? ""),
          String(row.abstract ?? ""),
          parseJsonArray(row.authors_json).join(" "),
          String(row.venue ?? ""),
          String(row.doi ?? ""),
          paperId,
          String(row.project_id)
        );
    };
    if (!wrapTransaction) {
      run();
      return;
    }
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private projectFromRow(row: Row): Project {
    return projectSchema.parse({
      id: row.id,
      title: row.title,
      topic: row.topic ?? undefined,
      description: row.description ?? undefined,
      archivedAt: row.archived_at ?? undefined,
      pinnedAt: row.pinned_at ?? undefined,
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
      score: parsePaperScore(row.score_json),
      favorite: Boolean(row.favorite),
      userStatus: row.user_status ?? "unread",
      tags: parseJsonArray(row.tags_json),
      notes: row.notes ?? undefined,
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

  private jobFromRow(row: Row): Job {
    return jobSchema.parse({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      status: row.status,
      title: row.title,
      progress: Number(row.progress ?? 0),
      detail: row.detail ?? undefined,
      result: parseJsonRecord(row.result_json),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildFtsQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1)
    .slice(0, 12)
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join(" AND ");
}

function parsePaperScore(value: unknown): PaperScore | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return paperScoreSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
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
