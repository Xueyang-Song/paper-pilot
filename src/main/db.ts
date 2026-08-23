import { DatabaseSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Artifact,
  artifactSchema,
  artifactTypeSchema,
  type ChatMode,
  type ChatRun,
  chatRunSchema,
  type Citation,
  citationSchema,
  type Conversation,
  conversationSchema,
  type DiscoveryBatch,
  discoveryBatchSchema,
  type ExtractionField,
  extractionFieldSchema,
  type ExtractionValue,
  extractionValueSchema,
  isBlankExtractionValue,
  type Job,
  jobSchema,
  MAX_EXTRACTION_FIELDS,
  MAX_REVIEW_BATCH_PAPERS,
  type Message,
  messageSchema,
  type Paper,
  type PaperScore,
  paperSchema,
  paperScoreSchema,
  type Project,
  type ProjectPolicy,
  projectSchema,
  type ReviewAuditEvent,
  reviewAuditEventSchema,
  type ReviewCriterion,
  reviewCriterionSchema,
  type ReviewEvidence,
  reviewEvidenceSchema,
  type ReviewFlowSummary,
  reviewFlowSummarySchema,
  type ReviewPaperPage,
  type ReviewPaperQuery,
  reviewPaperQuerySchema,
  reviewPaperSummarySchema,
  type ReviewProtocol,
  reviewProtocolSchema,
  type ReviewProtocolRevision,
  reviewProtocolRevisionSchema,
  type ReviewRun,
  reviewRunSchema,
  type ReviewRunItem,
  reviewRunItemSchema,
  type ScreeningDecision,
  screeningDecisionSchema
} from "../shared/schemas.js";
import { id, nowIso } from "./utils.js";
import {
  bibliographicFingerprint,
  doiIdentityKey,
  normalizeBibliographicTitle,
  sourceIdentifierIdentityKey,
  type PaperIdentityInput
} from "./services/paper-identity.js";

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

export interface ReviewCandidateOrigin {
  id: string;
  reviewId: string;
  batchId: string;
  paperId?: string;
  matchedPaperId?: string;
  sourceRecordId?: string;
  resolution: "created" | "duplicate" | "merged" | "kept-separate" | "skipped" | "invalid" | "filtered";
  paperSnapshot: Record<string, unknown>;
  recordSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface ReviewCandidateOriginInput {
  id?: string;
  reviewId: string;
  batchId: string;
  paperId?: string;
  matchedPaperId?: string;
  sourceRecordId?: string;
  resolution: ReviewCandidateOrigin["resolution"];
  paperSnapshot?: Record<string, unknown>;
  recordSnapshot?: unknown;
  createdAt?: string;
}

export interface ReviewRereviewFlag {
  id: string;
  reviewId: string;
  paperId: string;
  stage: "title-abstract" | "full-text";
  protocolRevisionId: string;
  paperSnapshot: Record<string, unknown>;
  invalidatesDownstream?: boolean;
  createdAt: string;
  resolvedAt?: string;
}

export type PortableDiscoveryBatch = DiscoveryBatch & { config: Record<string, unknown> };
export type PortableScreeningDecision = ScreeningDecision & { paperSnapshot: Record<string, unknown> };
export type PortableExtractionValue = ExtractionValue & { paperSnapshot: Record<string, unknown> };
export type PortableReviewEvidence = ReviewEvidence & { paperSnapshot?: Record<string, unknown> };
export type PortableReviewRunItem = Omit<ReviewRunItem, "evidence"> & {
  evidenceIds: string[];
  paperSnapshot: Record<string, unknown>;
  stale: boolean;
};

export type ExtractionFieldHistoryEntry = ExtractionField & { recordedAt: string };
export type ExtractionValueHistoryEntry = ExtractionValue & {
  changeRevision: number;
  paperSnapshot: Record<string, unknown>;
  recordedAt: string;
};

export interface ReviewPortabilityState {
  review: ReviewProtocol;
  revisions: ReviewProtocolRevision[];
  discoveryBatches: PortableDiscoveryBatch[];
  candidateOrigins: ReviewCandidateOrigin[];
  rereviewFlags: ReviewRereviewFlag[];
  screeningDecisions: PortableScreeningDecision[];
  extractionFields: ExtractionField[];
  extractionFieldHistory?: ExtractionFieldHistoryEntry[];
  extractionValues: PortableExtractionValue[];
  extractionValueHistory?: ExtractionValueHistoryEntry[];
  evidence: PortableReviewEvidence[];
  runs: ReviewRun[];
  runItems: PortableReviewRunItem[];
  auditEvents: ReviewAuditEvent[];
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
  private transactionDepth = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.loadVectorExtension();
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        return operation();
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  migrate(): void {
    const currentVersion = Number(
      (this.db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0
    );
    if (currentVersion > 3) {
      throw new Error(`Database schema version ${currentVersion} is newer than this Paper Pilot build supports.`);
    }
    const migrations: Array<{ version: number; run: () => void }> = [
      { version: 2, run: () => this.migrateToVersion2() },
      { version: 3, run: () => this.migrateToVersion3() }
    ];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of migrations) {
        if (currentVersion < migration.version) migration.run();
      }
      this.ensureVersion3IntegritySchema();
      if (this.vecAvailable) {
        this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings_vec USING vec0(
          embedding float[384],
          +chunk_id text
        );
        `);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateToVersion2(): void {
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

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'grounded',
        created_at TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS chat_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL,
        assistant_message_id TEXT,
        output_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        source_refs_json TEXT NOT NULL,
        included_message_count INTEGER NOT NULL DEFAULT 0,
        omitted_message_count INTEGER NOT NULL DEFAULT 0,
        trace_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_citations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
        message_id TEXT,
        evidence_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        chunk_id TEXT,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        page INTEGER,
        locator TEXT,
        doi TEXT,
        url TEXT,
        retrieval_score REAL
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
    this.ensureColumn("messages", "conversation_id", "TEXT");
    this.ensureColumn("messages", "run_id", "TEXT");
    this.ensureColumn("messages", "status", "TEXT NOT NULL DEFAULT 'completed'");
    this.ensureColumn("tool_runs", "run_id", "TEXT");
    this.backfillConversations();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_project_updated
        ON conversations(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
        ON messages(conversation_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_chat_runs_conversation_created
        ON chat_runs(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_citations_run
        ON chat_citations(run_id, evidence_id);
      PRAGMA user_version = 2;
    `);
  }

  private migrateToVersion3(): void {
    this.db.exec(`
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        template TEXT NOT NULL CHECK (template IN ('blank', 'general-empirical', 'pico')),
        current_protocol_revision_id TEXT,
        historical_counts_available INTEGER NOT NULL DEFAULT 1,
        activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE review_protocol_revisions (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        research_question TEXT NOT NULL,
        objectives_json TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(review_id, revision)
      );

      CREATE TABLE review_criteria (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        protocol_revision_id TEXT NOT NULL REFERENCES review_protocol_revisions(id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK (stage IN ('title-abstract', 'full-text')),
        kind TEXT NOT NULL CHECK (kind IN ('inclusion', 'exclusion')),
        label TEXT NOT NULL,
        description TEXT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(protocol_revision_id, id)
      );

      CREATE TABLE discovery_batches (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('pre-existing', 'reference-import', 'crawl')),
        label TEXT NOT NULL,
        source TEXT,
        file_name TEXT,
        import_format TEXT CHECK (import_format IN ('ris', 'bibtex', 'csv')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        historical_counts_available INTEGER NOT NULL DEFAULT 1,
        identified_count INTEGER NOT NULL DEFAULT 0 CHECK (identified_count >= 0),
        filtered_count INTEGER NOT NULL DEFAULT 0 CHECK (filtered_count >= 0),
        invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
        duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
        merged_count INTEGER NOT NULL DEFAULT 0 CHECK (merged_count >= 0),
        new_records_count INTEGER NOT NULL DEFAULT 0 CHECK (new_records_count >= 0),
        config_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE review_candidate_origins (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        batch_id TEXT NOT NULL REFERENCES discovery_batches(id) ON DELETE CASCADE,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        matched_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        source_record_id TEXT,
        resolution TEXT NOT NULL CHECK (
          resolution IN ('created', 'duplicate', 'merged', 'kept-separate', 'skipped', 'invalid', 'filtered')
        ),
        paper_snapshot_json TEXT NOT NULL,
        record_snapshot_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE review_screening_decisions (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('title-abstract', 'full-text')),
        decision TEXT NOT NULL CHECK (decision IN ('include', 'exclude', 'uncertain')),
        protocol_revision_id TEXT NOT NULL REFERENCES review_protocol_revisions(id) ON DELETE CASCADE,
        reason_criterion_id TEXT,
        custom_reason TEXT,
        run_item_id TEXT REFERENCES review_run_items(id) ON DELETE SET NULL,
        decided_by TEXT NOT NULL DEFAULT 'human' CHECK (decided_by IN ('human', 'system')),
        supersedes_decision_id TEXT REFERENCES review_screening_decisions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        CHECK (
          stage != 'full-text' OR decision != 'exclude' OR reason_criterion_id IS NOT NULL OR length(trim(coalesce(custom_reason, ''))) > 0
        )
      );

      CREATE TABLE review_rereview_flags (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('title-abstract', 'full-text')),
        protocol_revision_id TEXT NOT NULL REFERENCES review_protocol_revisions(id) ON DELETE CASCADE,
        invalidates_downstream INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE extraction_fields (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        field_type TEXT NOT NULL CHECK (
          field_type IN ('short-text', 'long-text', 'number', 'boolean', 'single-select', 'multi-select')
        ),
        options_json TEXT NOT NULL DEFAULT '[]',
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE review_runs (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        protocol_revision_id TEXT NOT NULL REFERENCES review_protocol_revisions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('ollama', 'vercel', 'openai-compatible')),
        model TEXT NOT NULL,
        stage TEXT NOT NULL CHECK (stage IN ('title-abstract', 'full-text', 'extraction')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'cancelled', 'failed')),
        selected_paper_ids_json TEXT NOT NULL,
        extraction_field_ids_json TEXT NOT NULL DEFAULT '[]',
        total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
        completed_items INTEGER NOT NULL DEFAULT 0 CHECK (completed_items >= 0),
        failed_items INTEGER NOT NULL DEFAULT 0 CHECK (failed_items >= 0),
        cancelled_items INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_items >= 0),
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE review_run_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        recommendation_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        stale INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, paper_id)
      );

      CREATE TABLE extraction_values (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL REFERENCES extraction_fields(id) ON DELETE CASCADE,
        field_revision INTEGER NOT NULL CHECK (field_revision > 0),
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL,
        run_item_id TEXT REFERENCES review_run_items(id) ON DELETE SET NULL,
        value_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected', 'not-found', 'needs-review')),
        provenance TEXT NOT NULL CHECK (provenance IN ('manual', 'ai')),
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(review_id, field_id, paper_id)
      );

      CREATE TABLE review_evidence (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        extraction_value_id TEXT REFERENCES extraction_values(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES review_runs(id) ON DELETE SET NULL,
        run_item_id TEXT REFERENCES review_run_items(id) ON DELETE SET NULL,
        evidence_id TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK (source_type IN ('paper-metadata', 'paper-abstract', 'artifact-chunk')),
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL DEFAULT '{}',
        artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
        chunk_id TEXT,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        page INTEGER,
        locator TEXT,
        doi TEXT,
        url TEXT,
        retrieval_score REAL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE review_extraction_value_evidence (
        value_id TEXT NOT NULL REFERENCES extraction_values(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES review_evidence(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(value_id, evidence_id)
      );

      CREATE TABLE review_audit_events (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor TEXT NOT NULL CHECK (actor IN ('user', 'ai', 'system')),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_review_protocol_revisions_review
        ON review_protocol_revisions(review_id, revision DESC);
      CREATE INDEX idx_review_criteria_revision
        ON review_criteria(protocol_revision_id, stage, kind, ordinal);
      CREATE INDEX idx_discovery_batches_review
        ON discovery_batches(review_id, created_at DESC);
      CREATE INDEX idx_review_candidate_origins_batch
        ON review_candidate_origins(batch_id, created_at ASC);
      CREATE INDEX idx_review_candidate_origins_paper
        ON review_candidate_origins(review_id, paper_id);
      CREATE INDEX idx_review_screening_current
        ON review_screening_decisions(review_id, paper_id, stage, created_at DESC);
      CREATE INDEX idx_review_rereview_open
        ON review_rereview_flags(review_id, paper_id, stage, resolved_at);
      CREATE INDEX idx_extraction_fields_review
        ON extraction_fields(review_id, active, ordinal);
      CREATE UNIQUE INDEX idx_review_one_active_run
        ON review_runs(project_id) WHERE status IN ('queued', 'running');
      CREATE INDEX idx_review_runs_review
        ON review_runs(review_id, created_at DESC);
      CREATE INDEX idx_review_run_items_run
        ON review_run_items(run_id, status);
      CREATE INDEX idx_extraction_values_review
        ON extraction_values(review_id, paper_id, field_id);
      CREATE INDEX idx_review_evidence_value
        ON review_evidence(extraction_value_id, evidence_id);
      CREATE INDEX idx_review_audit_events_review
        ON review_audit_events(review_id, created_at ASC);

      PRAGMA user_version = 3;
    `);
    this.backfillPaperIdentityKeys();
  }

  private ensureVersion3IntegritySchema(): void {
    this.ensureColumn(
      "review_screening_decisions",
      "run_item_id",
      "TEXT REFERENCES review_run_items(id) ON DELETE SET NULL"
    );
    this.ensureColumn("review_evidence", "paper_snapshot_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("review_rereview_flags", "invalidates_downstream", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS review_extraction_value_evidence (
        value_id TEXT NOT NULL REFERENCES extraction_values(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES review_evidence(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(value_id, evidence_id)
      );

      CREATE TABLE IF NOT EXISTS extraction_field_revisions (
        field_id TEXT NOT NULL REFERENCES extraction_fields(id) ON DELETE CASCADE,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        name TEXT NOT NULL,
        description TEXT,
        field_type TEXT NOT NULL CHECK (
          field_type IN ('short-text', 'long-text', 'number', 'boolean', 'single-select', 'multi-select')
        ),
        options_json TEXT NOT NULL DEFAULT '[]',
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        active INTEGER NOT NULL DEFAULT 1,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(field_id, revision)
      );

      CREATE TABLE IF NOT EXISTS extraction_value_revisions (
        value_id TEXT NOT NULL REFERENCES extraction_values(id) ON DELETE CASCADE,
        change_revision INTEGER NOT NULL CHECK (change_revision > 0),
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL REFERENCES extraction_fields(id) ON DELETE CASCADE,
        field_revision INTEGER NOT NULL CHECK (field_revision > 0),
        paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
        paper_snapshot_json TEXT NOT NULL,
        run_item_id TEXT REFERENCES review_run_items(id) ON DELETE SET NULL,
        value_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'rejected', 'not-found', 'needs-review')),
        provenance TEXT NOT NULL CHECK (provenance IN ('manual', 'ai')),
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        confirmed_at TEXT,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY(value_id, change_revision)
      );

      CREATE INDEX IF NOT EXISTS idx_extraction_field_revisions_review
        ON extraction_field_revisions(review_id, field_id, revision);
      CREATE INDEX IF NOT EXISTS idx_extraction_value_revisions_review
        ON extraction_value_revisions(review_id, value_id, change_revision);
      CREATE INDEX IF NOT EXISTS idx_review_extraction_value_evidence_evidence
        ON review_extraction_value_evidence(evidence_id, value_id);

      INSERT OR IGNORE INTO review_extraction_value_evidence (value_id, evidence_id, created_at)
      SELECT extraction_value_id, id, created_at FROM review_evidence
      WHERE extraction_value_id IS NOT NULL;

      UPDATE review_evidence SET extraction_value_id = NULL WHERE extraction_value_id IS NOT NULL;

      UPDATE review_evidence
      SET paper_snapshot_json = COALESCE(
        (SELECT paper_snapshot_json FROM review_run_items WHERE id = review_evidence.run_item_id),
        (SELECT paper_snapshot_json FROM extraction_values WHERE id = review_evidence.extraction_value_id),
        (SELECT json_object('id', id, 'title', title) FROM papers WHERE id = review_evidence.paper_id),
        '{}'
      )
      WHERE paper_snapshot_json = '{}';

      INSERT OR IGNORE INTO extraction_field_revisions (
        field_id, review_id, revision, name, description, field_type, options_json,
        ordinal, active, recorded_at
      )
      SELECT id, review_id, revision, name, description, field_type, options_json,
             ordinal, active, updated_at
      FROM extraction_fields;

      INSERT OR IGNORE INTO extraction_value_revisions (
        value_id, change_revision, review_id, field_id, field_revision, paper_id,
        paper_snapshot_json, run_item_id, value_json, status, provenance,
        evidence_ids_json, confirmed_at, recorded_at
      )
      SELECT value.id, 1, value.review_id, value.field_id, value.field_revision, value.paper_id,
             value.paper_snapshot_json, value.run_item_id, value.value_json, value.status, value.provenance,
             COALESCE((
               SELECT json_group_array(link.evidence_id)
               FROM review_extraction_value_evidence link
               WHERE link.value_id = value.id
             ), '[]'),
             value.confirmed_at, value.updated_at
      FROM extraction_values value;
    `);
  }

  private backfillPaperIdentityKeys(): void {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, dedupe_key, title, authors_json, year, doi, source, source_paper_id, raw_json
         FROM papers ORDER BY project_id, created_at, id`
      )
      .all() as Row[];
    const seen = new Set<string>();
    const reserved = new Set(rows.map((row) => `${String(row.project_id)}:${String((row as Row).dedupe_key ?? "")}`));
    const plans: Array<{ id: string; projectId: string; dedupeKey: string; normalizedTitle: string }> = [];
    for (const row of rows) {
      const paper = {
        id: String(row.id),
        title: String(row.title),
        authors: parseJson<string[]>(row.authors_json, []),
        year: row.year == null ? undefined : Number(row.year),
        doi: optionalString(row.doi),
        source: optionalString(row.source),
        sourcePaperId: optionalString(row.source_paper_id),
        raw: parseJson<Record<string, unknown>>(row.raw_json, {})
      };
      let dedupeKey = paperIdentityDedupeKey(paper);
      const projectId = String(row.project_id);
      let scopedKey = `${projectId}:${dedupeKey}`;
      if (seen.has(scopedKey)) {
        dedupeKey = `record:${paper.id}`;
        scopedKey = `${projectId}:${dedupeKey}`;
        let suffix = 1;
        while (seen.has(scopedKey)) {
          dedupeKey = `record:${paper.id}:${suffix}`;
          scopedKey = `${projectId}:${dedupeKey}`;
          suffix += 1;
        }
      }
      seen.add(scopedKey);
      plans.push({
        id: paper.id,
        projectId,
        dedupeKey,
        normalizedTitle: normalizeBibliographicTitle(paper.title)
      });
    }
    const stage = this.db.prepare("UPDATE papers SET dedupe_key = ? WHERE id = ?");
    for (const plan of plans) {
      let temporaryKey = `migration-v3:${plan.id}`;
      let scopedTemporaryKey = `${plan.projectId}:${temporaryKey}`;
      let suffix = 1;
      while (reserved.has(scopedTemporaryKey) || seen.has(scopedTemporaryKey)) {
        temporaryKey = `migration-v3:${plan.id}:${suffix}`;
        scopedTemporaryKey = `${plan.projectId}:${temporaryKey}`;
        suffix += 1;
      }
      reserved.add(scopedTemporaryKey);
      stage.run(temporaryKey, plan.id);
    }
    const finalize = this.db.prepare("UPDATE papers SET dedupe_key = ?, normalized_title = ? WHERE id = ?");
    for (const plan of plans) finalize.run(plan.dedupeKey, plan.normalizedTitle, plan.id);
  }

  private backfillConversations(): void {
    const projects = this.db.prepare("SELECT id, created_at, updated_at FROM projects").all() as Row[];
    const insert = this.db.prepare(
      `INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
       VALUES (?, ?, ?, 'grounded', ?, ?)`
    );
    const updateMessages = this.db.prepare(
      "UPDATE messages SET conversation_id = ? WHERE project_id = ? AND conversation_id IS NULL"
    );
    for (const project of projects) {
      const existing = this.db
        .prepare("SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at ASC LIMIT 1")
        .get(String(project.id)) as Row | undefined;
      const conversationId = existing ? String(existing.id) : id("conv");
      if (!existing) {
        const messageCount = Number(
          (
            this.db
              .prepare("SELECT COUNT(*) AS count FROM messages WHERE project_id = ?")
              .get(String(project.id)) as Row
          ).count ?? 0
        );
        insert.run(
          conversationId,
          String(project.id),
          messageCount ? "Existing conversation" : "New chat",
          String(project.created_at),
          String(project.updated_at)
        );
      }
      updateMessages.run(conversationId, String(project.id));
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
    this.db
      .prepare("UPDATE projects SET policy_json = ?, updated_at = ? WHERE id = ?")
      .run(policyJson, updatedAt, projectId);
    this.db
      .prepare(
        `INSERT INTO project_policies (project_id, policy_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`
      )
      .run(projectId, policyJson, updatedAt);
    return policy;
  }

  getReview(projectId: string): ReviewProtocol | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, pr.revision AS current_revision_number
         FROM reviews r
         JOIN review_protocol_revisions pr ON pr.id = r.current_protocol_revision_id
         WHERE r.project_id = ?`
      )
      .get(projectId) as Row | undefined;
    return row ? this.reviewFromRow(row) : undefined;
  }

  getReviewById(reviewId: string): ReviewProtocol | undefined {
    const row = this.db
      .prepare(
        `SELECT r.*, pr.revision AS current_revision_number
         FROM reviews r
         JOIN review_protocol_revisions pr ON pr.id = r.current_protocol_revision_id
         WHERE r.id = ?`
      )
      .get(reviewId) as Row | undefined;
    return row ? this.reviewFromRow(row) : undefined;
  }

  createReview(input: {
    projectId: string;
    template?: "blank" | "general-empirical" | "pico";
    researchQuestion?: string;
    objectives?: string[];
    criteria?: Array<{
      id?: string;
      stage: "title-abstract" | "full-text";
      type: "inclusion" | "exclusion";
      label: string;
      description?: string;
      order?: number;
    }>;
  }): ReviewProtocol {
    const existing = this.getReview(input.projectId);
    if (existing) return existing;
    const project = this.getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const createdAt = nowIso();
    const reviewId = id("review");
    const revisionId = id("protocol");
    const papers = this.listPapers(input.projectId);
    const historicalCountsAvailable = papers.length === 0;
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (
             id, project_id, template, current_protocol_revision_id,
             historical_counts_available, activated_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reviewId,
          input.projectId,
          input.template ?? "blank",
          revisionId,
          historicalCountsAvailable ? 1 : 0,
          createdAt,
          createdAt,
          createdAt
        );
      this.db
        .prepare(
          `INSERT INTO review_protocol_revisions (
             id, review_id, revision, research_question, objectives_json, created_at
           ) VALUES (?, ?, 1, ?, ?, ?)`
        )
        .run(
          revisionId,
          reviewId,
          input.researchQuestion?.trim() ?? "",
          JSON.stringify(input.objectives ?? []),
          createdAt
        );
      this.insertReviewCriteria(reviewId, revisionId, input.criteria ?? [], createdAt);
      const batchId = id("batch");
      this.db
        .prepare(
          `INSERT INTO discovery_batches (
             id, review_id, kind, label, status, historical_counts_available,
             identified_count, new_records_count, created_at, completed_at
           ) VALUES (?, ?, 'pre-existing', 'Pre-existing project papers', 'completed', ?, ?, ?, ?, ?)`
        )
        .run(batchId, reviewId, historicalCountsAvailable ? 1 : 0, papers.length, papers.length, createdAt, createdAt);
      const insertOrigin = this.db.prepare(
        `INSERT INTO review_candidate_origins (
           id, review_id, batch_id, paper_id, resolution, paper_snapshot_json, record_snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, 'created', ?, '{}', ?)`
      );
      for (const paper of papers) {
        insertOrigin.run(id("origin"), reviewId, batchId, paper.id, JSON.stringify(paper), createdAt);
      }
      this.insertReviewAuditEvent({
        reviewId,
        projectId: input.projectId,
        actor: "system",
        action: "review-activated",
        entityType: "review",
        entityId: reviewId,
        payload: { preExistingPaperCount: papers.length, historicalCountsAvailable },
        createdAt
      });
    });
    return this.getReview(input.projectId)!;
  }

  getReviewProtocolRevision(reviewId: string, revisionId?: string): ReviewProtocolRevision | undefined {
    const review = this.getReviewById(reviewId);
    if (!review) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM review_protocol_revisions
         WHERE review_id = ? AND id = ?`
      )
      .get(reviewId, revisionId ?? review.currentRevisionId) as Row | undefined;
    return row ? this.reviewProtocolRevisionFromRow(row) : undefined;
  }

  listReviewProtocolRevisions(reviewId: string): ReviewProtocolRevision[] {
    return (
      this.db
        .prepare("SELECT * FROM review_protocol_revisions WHERE review_id = ? ORDER BY revision DESC")
        .all(reviewId) as Row[]
    ).map((row) => this.reviewProtocolRevisionFromRow(row));
  }

  listReviewCriteria(reviewId: string, revisionId?: string): ReviewCriterion[] {
    const selectedRevision = revisionId ?? this.getReviewById(reviewId)?.currentRevisionId;
    if (!selectedRevision) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM review_criteria
         WHERE review_id = ? AND protocol_revision_id = ?
         ORDER BY stage, kind, ordinal, id`
        )
        .all(reviewId, selectedRevision) as Row[]
    ).map((row) => this.reviewCriterionFromRow(row));
  }

  reviseReviewProtocol(input: {
    reviewId: string;
    researchQuestion: string;
    objectives?: string[];
    criteria?: Array<{
      id?: string;
      stage: "title-abstract" | "full-text";
      type: "inclusion" | "exclusion";
      label: string;
      description?: string;
      order?: number;
    }>;
    changeNote?: string;
  }): ReviewProtocolRevision {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const createdAt = nowIso();
    const revisionId = id("protocol");
    const revision = review.currentRevisionNumber + 1;
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_protocol_revisions (
             id, review_id, revision, research_question, objectives_json, note, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          revisionId,
          input.reviewId,
          revision,
          input.researchQuestion.trim(),
          JSON.stringify(input.objectives ?? []),
          normalizeOptional(input.changeNote) ?? null,
          createdAt
        );
      this.insertReviewCriteria(input.reviewId, revisionId, input.criteria ?? [], createdAt);
      this.db
        .prepare("UPDATE reviews SET current_protocol_revision_id = ?, updated_at = ? WHERE id = ?")
        .run(revisionId, createdAt, input.reviewId);
      this.db
        .prepare(
          `UPDATE review_run_items
           SET stale = 1, updated_at = ?
           WHERE review_id = ? AND stale = 0
             AND EXISTS (
               SELECT 1 FROM review_runs run
               WHERE run.id = review_run_items.run_id AND run.protocol_revision_id != ?
             )`
        )
        .run(createdAt, input.reviewId, revisionId);
      this.markExtractionValuesNeedsReview(
        `review_id = ? AND run_item_id IN (
           SELECT item.id FROM review_run_items item
           JOIN review_runs run ON run.id = item.run_id
           WHERE item.review_id = ? AND run.protocol_revision_id != ?
         )`,
        [input.reviewId, input.reviewId, revisionId],
        createdAt
      );
      this.insertReviewAuditEvent({
        reviewId: input.reviewId,
        projectId: review.projectId,
        actor: "user",
        action: "protocol-revised",
        entityType: "protocol-revision",
        entityId: revisionId,
        payload: { fromVersion: review.currentRevisionNumber, toVersion: revision },
        createdAt
      });
    });
    return this.getReviewProtocolRevision(input.reviewId, revisionId)!;
  }

  listDiscoveryBatches(reviewId: string): DiscoveryBatch[] {
    return (
      this.db
        .prepare("SELECT * FROM discovery_batches WHERE review_id = ? ORDER BY created_at DESC, id DESC")
        .all(reviewId) as Row[]
    ).map((row) => this.discoveryBatchFromRow(row));
  }

  saveDiscoveryBatch(input: {
    id?: string;
    reviewId: string;
    kind: "pre-existing" | "reference-import" | "crawl";
    label: string;
    sourceId?: string;
    fileName?: string;
    importFormat?: "ris" | "bibtex" | "csv";
    status?: "pending" | "running" | "completed" | "failed" | "cancelled";
    counts?: Partial<{
      identified: number;
      filtered: number;
      invalid: number;
      duplicates: number;
      merged: number;
      newRecords: number;
    }>;
    historicalCountsAvailable?: boolean;
    config?: Record<string, unknown>;
    error?: string;
    createdAt?: string;
    completedAt?: string;
  }): DiscoveryBatch {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const existing = input.id
      ? (this.db.prepare("SELECT * FROM discovery_batches WHERE id = ?").get(input.id) as Row | undefined)
      : undefined;
    if (existing && String(existing.review_id) !== input.reviewId) {
      throw new Error(`Discovery batch belongs to another review: ${input.id}`);
    }
    const batchId = input.id ?? id("batch");
    const counts = input.counts ?? {};
    const createdAt = input.createdAt ?? (existing ? String(existing.created_at) : nowIso());
    this.db
      .prepare(
        `INSERT INTO discovery_batches (
           id, review_id, kind, label, source, file_name, import_format, status,
           historical_counts_available, identified_count, filtered_count, invalid_count,
           duplicate_count, merged_count, new_records_count, config_json, error, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           status = excluded.status,
           identified_count = excluded.identified_count,
           filtered_count = excluded.filtered_count,
           invalid_count = excluded.invalid_count,
           duplicate_count = excluded.duplicate_count,
           merged_count = excluded.merged_count,
           new_records_count = excluded.new_records_count,
           config_json = excluded.config_json,
           error = excluded.error,
           completed_at = excluded.completed_at`
      )
      .run(
        batchId,
        input.reviewId,
        input.kind,
        input.label.trim(),
        input.sourceId ?? null,
        input.fileName ?? null,
        input.importFormat ?? null,
        input.status ?? "pending",
        input.historicalCountsAvailable === false ? 0 : 1,
        counts.identified ?? 0,
        counts.filtered ?? 0,
        counts.invalid ?? 0,
        counts.duplicates ?? 0,
        counts.merged ?? 0,
        counts.newRecords ?? 0,
        JSON.stringify(input.config ?? {}),
        input.error ?? null,
        createdAt,
        input.completedAt ?? null
      );
    return this.listDiscoveryBatches(input.reviewId).find((batch) => batch.id === batchId)!;
  }

  recordReviewCandidateOrigin(input: ReviewCandidateOriginInput): ReviewCandidateOrigin {
    return this.recordReviewCandidateOriginsBulk([input])[0]!;
  }

  recordReviewCandidateOriginsBulk(inputs: ReviewCandidateOriginInput[]): ReviewCandidateOrigin[] {
    if (!inputs.length) return [];
    return this.withTransaction(() => {
      const reviews = new Map<string, ReviewProtocol>();
      const batches = new Set<string>();
      const suppliedIds = new Set<string>();
      const findOrigin = this.db.prepare("SELECT id FROM review_candidate_origins WHERE id = ?");
      const findBatch = this.db.prepare("SELECT id FROM discovery_batches WHERE id = ? AND review_id = ?");
      const insert = this.db.prepare(
        `INSERT INTO review_candidate_origins (
           id, review_id, batch_id, paper_id, matched_paper_id, source_record_id,
           resolution, paper_snapshot_json, record_snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const inserted: ReviewCandidateOrigin[] = [];
      for (const input of inputs) {
        let review = reviews.get(input.reviewId);
        if (!review) {
          review = this.getReviewById(input.reviewId);
          if (!review) throw new Error(`Review not found: ${input.reviewId}`);
          reviews.set(input.reviewId, review);
        }
        const batchKey = `${input.reviewId}:${input.batchId}`;
        if (!batches.has(batchKey)) {
          if (!findBatch.get(input.batchId, input.reviewId)) {
            throw new Error(`Discovery batch not found in review: ${input.batchId}`);
          }
          batches.add(batchKey);
        }
        if (input.id) {
          if (suppliedIds.has(input.id) || findOrigin.get(input.id)) {
            throw new Error(`Review candidate origin already exists: ${input.id}`);
          }
          suppliedIds.add(input.id);
        }
        const paper = input.paperId ? this.getPaper(review.projectId, input.paperId) : undefined;
        if (input.paperId && !paper) throw new Error(`Paper not found in review project: ${input.paperId}`);
        if (input.matchedPaperId && !this.getPaper(review.projectId, input.matchedPaperId)) {
          throw new Error(`Matched paper not found in review project: ${input.matchedPaperId}`);
        }
        const createdAt = input.createdAt ?? nowIso();
        const originId = input.id ?? id("origin");
        const paperSnapshot = input.paperSnapshot ?? paper ?? {};
        const recordSnapshot = parseJsonRecordValue(input.recordSnapshot);
        insert.run(
          originId,
          input.reviewId,
          input.batchId,
          input.paperId ?? null,
          input.matchedPaperId ?? null,
          input.sourceRecordId ?? null,
          input.resolution,
          JSON.stringify(paperSnapshot),
          JSON.stringify(recordSnapshot),
          createdAt
        );
        inserted.push({
          id: originId,
          reviewId: input.reviewId,
          batchId: input.batchId,
          paperId: input.paperId ?? optionalString(paperSnapshot.id),
          matchedPaperId: input.matchedPaperId,
          sourceRecordId: input.sourceRecordId,
          resolution: input.resolution,
          paperSnapshot,
          recordSnapshot,
          createdAt
        });
      }
      return inserted;
    });
  }

  listReviewCandidateOrigins(reviewId: string, batchId?: string): ReviewCandidateOrigin[] {
    const rows = batchId
      ? this.db
          .prepare(
            "SELECT * FROM review_candidate_origins WHERE review_id = ? AND batch_id = ? ORDER BY created_at, id"
          )
          .all(reviewId, batchId)
      : this.db
          .prepare("SELECT * FROM review_candidate_origins WHERE review_id = ? ORDER BY created_at, id")
          .all(reviewId);
    return (rows as Row[]).map((row) => this.reviewCandidateOriginFromRow(row));
  }

  setScreeningDecision(input: {
    reviewId: string;
    paperId: string;
    stage: "title-abstract" | "full-text";
    decision: "include" | "exclude" | "uncertain";
    protocolRevisionId?: string;
    reasonCriterionId?: string;
    customReason?: string;
    runItemId?: string;
  }): ScreeningDecision {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const paper = this.getPaper(review.projectId, input.paperId);
    if (!paper) throw new Error(`Paper not found in review project: ${input.paperId}`);
    if (input.stage === "full-text") {
      const abstractDecision = this.getCurrentScreeningDecision(input.reviewId, input.paperId, "title-abstract");
      if (abstractDecision?.decision !== "include") {
        throw new Error("A paper must be included during title/abstract screening before full-text screening.");
      }
      if (input.decision === "exclude" && !input.reasonCriterionId && !normalizeOptional(input.customReason)) {
        throw new Error("Full-text exclusions require a criterion or custom reason.");
      }
    }
    const protocolRevisionId = input.protocolRevisionId ?? review.currentRevisionId;
    if (!this.getReviewProtocolRevision(input.reviewId, protocolRevisionId)) {
      throw new Error(`Protocol revision not found in review: ${protocolRevisionId}`);
    }
    if (input.reasonCriterionId) {
      const criterion = this.db
        .prepare(
          `SELECT * FROM review_criteria
           WHERE id = ? AND review_id = ? AND protocol_revision_id = ? AND stage = ?`
        )
        .get(input.reasonCriterionId, input.reviewId, protocolRevisionId, input.stage) as Row | undefined;
      if (!criterion) throw new Error("The selected exclusion criterion does not belong to this protocol stage.");
      if (String(criterion.kind) !== "exclusion")
        throw new Error("A screening exclusion reason must use an exclusion criterion.");
    }
    if (input.runItemId) {
      const runItem = this.db
        .prepare(
          `SELECT item.review_id, item.paper_id, item.paper_snapshot_json, run.stage
           FROM review_run_items item
           JOIN review_runs run ON run.id = item.run_id
           WHERE item.id = ?`
        )
        .get(input.runItemId) as Row | undefined;
      if (
        !runItem ||
        String(runItem.review_id) !== input.reviewId ||
        this.reviewPaperIdentity(runItem.paper_id, runItem.paper_snapshot_json) !== input.paperId ||
        String(runItem.stage) !== input.stage
      ) {
        throw new Error("The linked review run item must belong to the same review, paper, and screening stage.");
      }
    }
    const previous = this.getCurrentScreeningDecision(input.reviewId, input.paperId, input.stage);
    const decisionId = id("decision");
    const createdAt = nowIso();
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_screening_decisions (
             id, review_id, paper_id, paper_snapshot_json, stage, decision,
             protocol_revision_id, reason_criterion_id, custom_reason, run_item_id,
             supersedes_decision_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          decisionId,
          input.reviewId,
          input.paperId,
          JSON.stringify(paper),
          input.stage,
          input.decision,
          protocolRevisionId,
          input.reasonCriterionId ?? null,
          normalizeOptional(input.customReason) ?? null,
          input.runItemId ?? null,
          previous?.id ?? null,
          createdAt
        );
      this.db
        .prepare(
          `UPDATE review_rereview_flags SET resolved_at = ?
           WHERE review_id = ? AND paper_id = ? AND stage = ? AND resolved_at IS NULL`
        )
        .run(createdAt, input.reviewId, input.paperId, input.stage);
      if (input.stage === "title-abstract" && input.decision !== "include") {
        this.invalidateDownstreamReviewState(input.reviewId, input.paperId, paper, createdAt);
      }
      this.insertReviewAuditEvent({
        reviewId: input.reviewId,
        projectId: review.projectId,
        actor: "user",
        action: "decision-recorded",
        entityType: "screening-decision",
        entityId: decisionId,
        payload: {
          paperId: input.paperId,
          stage: input.stage,
          decision: input.decision,
          previousDecisionId: previous?.id
        },
        createdAt
      });
    });
    return this.getScreeningDecision(decisionId)!;
  }

  getScreeningDecision(decisionId: string): ScreeningDecision | undefined {
    const row = this.db.prepare("SELECT * FROM review_screening_decisions WHERE id = ?").get(decisionId) as
      Row | undefined;
    return row ? this.screeningDecisionFromRow(row) : undefined;
  }

  getCurrentScreeningDecision(
    reviewId: string,
    paperId: string,
    stage: "title-abstract" | "full-text"
  ): ScreeningDecision | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM review_screening_decisions
         WHERE review_id = ?
           AND COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) = ?
           AND stage = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(reviewId, paperId, stage) as Row | undefined;
    return row ? this.screeningDecisionFromRow(row) : undefined;
  }

  listScreeningDecisionHistory(
    reviewId: string,
    paperId?: string,
    stage?: "title-abstract" | "full-text"
  ): ScreeningDecision[] {
    const conditions = ["review_id = ?"];
    const parameters: Array<string> = [reviewId];
    if (paperId) {
      conditions.push("COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) = ?");
      parameters.push(paperId);
    }
    if (stage) {
      conditions.push("stage = ?");
      parameters.push(stage);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM review_screening_decisions
         WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC, rowid ASC`
        )
        .all(...parameters) as Row[]
    ).map((row) => this.screeningDecisionFromRow(row));
  }

  markScreeningForRereview(input: {
    reviewId: string;
    paperIds: string[];
    stage: "title-abstract" | "full-text";
  }): number {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const createdAt = nowIso();
    let created = 0;
    this.withTransaction(() => {
      const open = this.db.prepare(
        `SELECT id FROM review_rereview_flags
         WHERE review_id = ? AND paper_id = ? AND stage = ? AND resolved_at IS NULL`
      );
      const insert = this.db.prepare(
        `INSERT INTO review_rereview_flags (
           id, review_id, paper_id, paper_snapshot_json, stage, protocol_revision_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const paperId of [...new Set(input.paperIds)]) {
        const paper = this.getPaper(review.projectId, paperId);
        if (!paper) throw new Error(`Paper not found in review project: ${paperId}`);
        if (open.get(input.reviewId, paperId, input.stage)) continue;
        insert.run(
          id("rereview"),
          input.reviewId,
          paperId,
          JSON.stringify(paper),
          input.stage,
          review.currentRevisionId,
          createdAt
        );
        created += 1;
      }
      this.insertReviewAuditEvent({
        reviewId: input.reviewId,
        projectId: review.projectId,
        actor: "user",
        action: "decision-marked-for-review",
        entityType: "screening-stage",
        entityId: input.stage,
        payload: { paperIds: input.paperIds, created },
        createdAt
      });
    });
    return created;
  }

  listReviewRereviewFlags(reviewId: string): ReviewRereviewFlag[] {
    return (
      this.db
        .prepare("SELECT * FROM review_rereview_flags WHERE review_id = ? ORDER BY created_at, rowid")
        .all(reviewId) as Row[]
    ).map((row) => {
      const paperSnapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
      return {
        id: String(row.id),
        reviewId: String(row.review_id),
        paperId: optionalString(row.paper_id) ?? optionalString(paperSnapshot.id) ?? "",
        stage: row.stage as ReviewRereviewFlag["stage"],
        protocolRevisionId: String(row.protocol_revision_id),
        paperSnapshot,
        invalidatesDownstream: Boolean(row.invalidates_downstream),
        createdAt: String(row.created_at),
        resolvedAt: optionalString(row.resolved_at)
      };
    });
  }

  exportReviewPortabilityState(reviewId: string): ReviewPortabilityState {
    const review = this.getReviewById(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    const runs = this.listReviewRuns(reviewId).filter((run) => run.status !== "queued" && run.status !== "running");
    const runItems = runs.flatMap((run) =>
      this.listReviewRunItems(run.id).map(({ evidence, ...item }) => ({
        ...item,
        evidenceIds: evidence.map((entry) => entry.id),
        paperSnapshot: parseJson<Record<string, unknown>>(
          (this.db.prepare("SELECT paper_snapshot_json FROM review_run_items WHERE id = ?").get(item.id) as Row)
            .paper_snapshot_json,
          {}
        ),
        stale: Boolean((this.db.prepare("SELECT stale FROM review_run_items WHERE id = ?").get(item.id) as Row).stale)
      }))
    );
    const discoveryBatches = this.listDiscoveryBatches(reviewId).map((batch) => ({
      ...batch,
      config: parseJson<Record<string, unknown>>(
        (this.db.prepare("SELECT config_json FROM discovery_batches WHERE id = ?").get(batch.id) as Row).config_json,
        {}
      )
    }));
    const screeningDecisions = this.listScreeningDecisionHistory(reviewId).map((decision) => ({
      ...decision,
      paperSnapshot: parseJson<Record<string, unknown>>(
        (
          this.db
            .prepare("SELECT paper_snapshot_json FROM review_screening_decisions WHERE id = ?")
            .get(decision.id) as Row
        ).paper_snapshot_json,
        {}
      )
    }));
    const extractionValues = this.listExtractionValues(reviewId).map((value) => ({
      ...value,
      paperSnapshot: parseJson<Record<string, unknown>>(
        (this.db.prepare("SELECT paper_snapshot_json FROM extraction_values WHERE id = ?").get(value.id) as Row)
          .paper_snapshot_json,
        {}
      )
    }));
    const evidence = this.listReviewEvidence(reviewId).map((entry) => ({
      ...entry,
      paperSnapshot: parseJson<Record<string, unknown>>(
        (this.db.prepare("SELECT paper_snapshot_json FROM review_evidence WHERE id = ?").get(entry.id) as Row)
          .paper_snapshot_json,
        {}
      )
    }));
    const extractionFields = this.listExtractionFields(reviewId, true);
    return {
      review,
      revisions: this.listReviewProtocolRevisions(reviewId),
      discoveryBatches,
      candidateOrigins: this.listReviewCandidateOrigins(reviewId),
      rereviewFlags: this.listReviewRereviewFlags(reviewId),
      screeningDecisions,
      extractionFields,
      extractionFieldHistory: extractionFields.flatMap((field) => this.listExtractionFieldHistory(field.id)),
      extractionValues,
      extractionValueHistory: extractionValues.flatMap((value) => this.listExtractionValueHistory(value.id)),
      evidence,
      runs,
      runItems,
      auditEvents: this.listReviewAuditEvents(reviewId)
    };
  }

  importReviewPortabilityState(projectId: string, state: ReviewPortabilityState): ReviewProtocol {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    if (this.getReview(projectId)) throw new Error(`Project already has a review: ${projectId}`);
    const review = reviewProtocolSchema.parse(state.review);
    if (review.projectId !== projectId)
      throw new Error("Portable review state was not remapped to the target project.");
    const revisions = state.revisions.map((revision) => reviewProtocolRevisionSchema.parse(revision));
    const revisionIds = new Set(revisions.map((revision) => revision.id));
    if (!revisionIds.has(review.currentRevisionId)) {
      throw new Error("Portable review state does not include its current protocol revision.");
    }
    if (revisions.some((revision) => revision.reviewId !== review.id)) {
      throw new Error("Portable protocol revisions must belong to the imported review.");
    }
    const batches = state.discoveryBatches.map((batch) => ({
      ...discoveryBatchSchema.parse(batch),
      config: parseJsonRecordValue(batch.config)
    }));
    const batchIds = new Set(batches.map((batch) => batch.id));
    if (batches.some((batch) => batch.reviewId !== review.id)) {
      throw new Error("Portable discovery batches must belong to the imported review.");
    }
    const decisions = state.screeningDecisions.map((decision) => ({
      ...screeningDecisionSchema.parse(decision),
      paperSnapshot: parseJsonRecordValue(decision.paperSnapshot)
    }));
    const fields = state.extractionFields.map((field) => extractionFieldSchema.parse(field));
    const fieldIds = new Set(fields.map((field) => field.id));
    const fieldHistory = (state.extractionFieldHistory ?? []).map((entry) => ({
      ...extractionFieldSchema.parse(entry),
      recordedAt: entry.recordedAt
    }));
    const values = state.extractionValues.map((value) => ({
      ...extractionValueSchema.parse(value),
      paperSnapshot: parseJsonRecordValue(value.paperSnapshot)
    }));
    const valueIds = new Set(values.map((value) => value.id));
    const valueHistory = (state.extractionValueHistory ?? []).map((entry) => ({
      ...extractionValueSchema.parse(entry),
      changeRevision: entry.changeRevision,
      paperSnapshot: parseJsonRecordValue(entry.paperSnapshot),
      recordedAt: entry.recordedAt
    }));
    const evidenceSnapshots = new Map(
      state.evidence.map((entry) => [entry.id, parseJsonRecordValue(entry.paperSnapshot)])
    );
    const evidence = state.evidence.map((entry) => reviewEvidenceSchema.parse(entry));
    const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
    const runs = state.runs.map((run) => reviewRunSchema.parse(run));
    const runIds = new Set(runs.map((run) => run.id));
    if (runs.some((run) => run.reviewId !== review.id || run.status === "queued" || run.status === "running")) {
      throw new Error("Portable review state may contain only terminal runs from the imported review.");
    }
    const runItems = state.runItems.map((item) => {
      const nestedEvidence = item.evidenceIds.map((evidenceId) => {
        const entry = evidenceById.get(evidenceId);
        if (!entry) throw new Error(`Portable run item references missing evidence: ${evidenceId}`);
        return entry;
      });
      return {
        parsed: reviewRunItemSchema.parse({ ...item, evidence: nestedEvidence }),
        evidenceIds: [...item.evidenceIds],
        paperSnapshot: parseJsonRecordValue(item.paperSnapshot),
        stale: item.stale
      };
    });
    const runItemIds = new Set(runItems.map(({ parsed }) => parsed.id));
    for (const decision of decisions) {
      if (!decision.runItemId) continue;
      const linked = runItems.find(({ parsed }) => parsed.id === decision.runItemId)?.parsed;
      const linkedRun = linked ? runs.find((run) => run.id === linked.runId) : undefined;
      if (
        !linked ||
        !linkedRun ||
        linked.paperId !== decision.paperId ||
        linkedRun.stage !== decision.stage ||
        linkedRun.reviewId !== decision.reviewId
      ) {
        throw new Error(`Portable screening decision has an invalid run item: ${decision.id}`);
      }
    }
    if (fieldHistory.some((entry) => entry.reviewId !== review.id || !fieldIds.has(entry.id))) {
      throw new Error("Portable extraction field history is outside the imported review.");
    }
    if (valueHistory.some((entry) => entry.reviewId !== review.id || !valueIds.has(entry.id))) {
      throw new Error("Portable extraction value history is outside the imported review.");
    }
    const portableFieldHistory = fieldHistory.length
      ? fieldHistory
      : fields.map((field) => ({ ...field, recordedAt: field.updatedAt }));
    const portableValueHistory = valueHistory.length
      ? valueHistory
      : values.map((value) => ({
          ...value,
          changeRevision: 1,
          paperSnapshot: value.paperSnapshot,
          recordedAt: value.updatedAt
        }));
    const auditEvents = state.auditEvents.map((event) => reviewAuditEventSchema.parse(event));
    const paperIds = new Set(this.listPapers(projectId).map((paper) => paper.id));
    const artifactIds = new Set(this.listArtifacts(projectId).map((artifact) => artifact.id));
    const chunks = this.db
      .prepare("SELECT id, artifact_id FROM document_chunks WHERE project_id = ?")
      .all(projectId) as Row[];
    const chunkArtifactIds = new Map(chunks.map((row) => [String(row.id), String(row.artifact_id)]));
    const evidenceValueIds = new Map<string, string[]>();
    for (const value of values) {
      for (const evidenceId of value.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          throw new Error(`Portable extraction value references missing evidence: ${evidenceId}`);
        }
        const linkedValues = evidenceValueIds.get(evidenceId) ?? [];
        if (!linkedValues.includes(value.id)) linkedValues.push(value.id);
        evidenceValueIds.set(evidenceId, linkedValues);
      }
    }
    const evidenceRunItemIds = new Map<string, string>();
    for (const item of runItems) {
      for (const evidenceId of item.evidenceIds) {
        const existingItem = evidenceRunItemIds.get(evidenceId);
        if (existingItem && existingItem !== item.parsed.id) {
          throw new Error(`Portable evidence is associated with multiple run items: ${evidenceId}`);
        }
        evidenceRunItemIds.set(evidenceId, item.parsed.id);
      }
    }
    for (const entry of evidence) {
      const evidencePaperId = entry.paperId ?? optionalString(evidenceSnapshots.get(entry.id)?.id);
      const linkedValues = (evidenceValueIds.get(entry.id) ?? []).map((valueId) =>
        values.find((value) => value.id === valueId)
      );
      const runItemId = evidenceRunItemIds.get(entry.id) ?? entry.runItemId;
      const linkedItem = runItemId ? runItems.find(({ parsed }) => parsed.id === runItemId)?.parsed : undefined;
      if (linkedValues.some((value) => !value || !evidencePaperId || value.paperId !== evidencePaperId)) {
        throw new Error(`Portable extraction evidence belongs to another paper: ${entry.id}`);
      }
      if (linkedItem && (!evidencePaperId || linkedItem.paperId !== evidencePaperId)) {
        throw new Error(`Portable run evidence belongs to another paper: ${entry.id}`);
      }
      if (entry.sourceType === "artifact-chunk") {
        if (!evidencePaperId) {
          throw new Error(`Portable artifact evidence lacks a retained paper identity: ${entry.id}`);
        }
        if (entry.artifactId) {
          if (
            !entry.chunkId ||
            !this.isTrustedReviewArtifactChunk(review.projectId, entry.artifactId, entry.chunkId, evidencePaperId)
          ) {
            throw new Error(`Portable artifact evidence does not reference a trusted paper chunk: ${entry.id}`);
          }
        } else if (
          entry.chunkId &&
          this.db.prepare("SELECT 1 FROM document_chunks WHERE project_id = ? AND id = ?").get(projectId, entry.chunkId)
        ) {
          throw new Error(`Portable artifact evidence omits the owner of a live chunk: ${entry.id}`);
        }
      }
    }
    this.withTransaction(() => {
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.db
        .prepare(
          `INSERT INTO reviews (
             id, project_id, template, current_protocol_revision_id, historical_counts_available,
             activated_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          review.id,
          projectId,
          review.template,
          review.currentRevisionId,
          review.historicalCountsAvailable ? 1 : 0,
          review.activatedAt,
          review.createdAt,
          review.updatedAt
        );
      const insertRevision = this.db.prepare(
        `INSERT INTO review_protocol_revisions (
           id, review_id, revision, research_question, objectives_json, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertCriterion = this.db.prepare(
        `INSERT INTO review_criteria (
           id, review_id, protocol_revision_id, stage, kind, label, description, ordinal, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const revision of revisions) {
        insertRevision.run(
          revision.id,
          review.id,
          revision.version,
          revision.researchQuestion,
          JSON.stringify(revision.objectives),
          revision.changeNote ?? null,
          revision.createdAt
        );
        for (const criterion of revision.criteria) {
          insertCriterion.run(
            criterion.id,
            review.id,
            revision.id,
            criterion.stage,
            criterion.type,
            criterion.label,
            criterion.description ?? null,
            criterion.order,
            revision.createdAt
          );
        }
      }
      const insertBatch = this.db.prepare(
        `INSERT INTO discovery_batches (
           id, review_id, kind, label, source, file_name, import_format, status,
           historical_counts_available, identified_count, filtered_count, invalid_count,
           duplicate_count, merged_count, new_records_count, config_json, error, created_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const batch of batches) {
        insertBatch.run(
          batch.id,
          review.id,
          batch.kind,
          batch.label,
          batch.sourceId ?? null,
          batch.fileName ?? null,
          batch.importFormat ?? null,
          batch.status,
          batch.historicalCountsAvailable ? 1 : 0,
          batch.counts.identified,
          batch.counts.filtered,
          batch.counts.invalid,
          batch.counts.duplicates,
          batch.counts.merged,
          batch.counts.newRecords,
          JSON.stringify(batch.config),
          batch.error ?? null,
          batch.createdAt,
          batch.completedAt ?? null
        );
      }
      const insertOrigin = this.db.prepare(
        `INSERT INTO review_candidate_origins (
           id, review_id, batch_id, paper_id, matched_paper_id, source_record_id,
           resolution, paper_snapshot_json, record_snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const origin of state.candidateOrigins) {
        if (origin.reviewId !== review.id || !batchIds.has(origin.batchId)) {
          throw new Error(`Portable candidate origin is outside the imported review: ${origin.id}`);
        }
        insertOrigin.run(
          origin.id,
          review.id,
          origin.batchId,
          origin.paperId && paperIds.has(origin.paperId) ? origin.paperId : null,
          origin.matchedPaperId && paperIds.has(origin.matchedPaperId) ? origin.matchedPaperId : null,
          origin.sourceRecordId ?? null,
          origin.resolution,
          JSON.stringify(origin.paperSnapshot),
          JSON.stringify(origin.recordSnapshot),
          origin.createdAt
        );
      }
      const insertDecision = this.db.prepare(
        `INSERT INTO review_screening_decisions (
           id, review_id, paper_id, paper_snapshot_json, stage, decision, protocol_revision_id,
           reason_criterion_id, custom_reason, run_item_id, supersedes_decision_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const decision of decisions) {
        if (decision.reviewId !== review.id || !revisionIds.has(decision.protocolRevisionId)) {
          throw new Error(`Portable screening decision is outside the imported review: ${decision.id}`);
        }
        insertDecision.run(
          decision.id,
          review.id,
          paperIds.has(decision.paperId) ? decision.paperId : null,
          JSON.stringify(decision.paperSnapshot),
          decision.stage,
          decision.decision,
          decision.protocolRevisionId,
          decision.reasonCriterionId ?? null,
          decision.customReason ?? null,
          decision.runItemId ?? null,
          decision.previousDecisionId ?? null,
          decision.createdAt
        );
      }
      const insertFlag = this.db.prepare(
        `INSERT INTO review_rereview_flags (
           id, review_id, paper_id, paper_snapshot_json, stage, protocol_revision_id,
           invalidates_downstream, created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const flag of state.rereviewFlags) {
        if (flag.reviewId !== review.id || !revisionIds.has(flag.protocolRevisionId)) {
          throw new Error(`Portable re-review flag is outside the imported review: ${flag.id}`);
        }
        insertFlag.run(
          flag.id,
          review.id,
          paperIds.has(flag.paperId) ? flag.paperId : null,
          JSON.stringify(flag.paperSnapshot),
          flag.stage,
          flag.protocolRevisionId,
          flag.invalidatesDownstream ? 1 : 0,
          flag.createdAt,
          flag.resolvedAt ?? null
        );
      }
      const insertField = this.db.prepare(
        `INSERT INTO extraction_fields (
           id, review_id, name, description, field_type, options_json, ordinal,
           revision, active, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const field of fields) {
        if (field.reviewId !== review.id) throw new Error(`Portable extraction field has wrong review: ${field.id}`);
        insertField.run(
          field.id,
          review.id,
          field.name,
          field.description ?? null,
          field.type,
          JSON.stringify(field.options),
          field.order,
          field.revision,
          field.active ? 1 : 0,
          field.createdAt,
          field.updatedAt
        );
      }
      const insertRun = this.db.prepare(
        `INSERT INTO review_runs (
           id, review_id, project_id, protocol_revision_id, provider, model, stage, status,
           selected_paper_ids_json, extraction_field_ids_json, total_items, completed_items, failed_items, cancelled_items,
           error, started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const run of runs) {
        if (!revisionIds.has(run.protocolRevisionId)) throw new Error(`Portable run has missing protocol: ${run.id}`);
        if (run.fieldIds.some((fieldId) => !fieldIds.has(fieldId))) {
          throw new Error(`Portable run has an extraction field outside the review: ${run.id}`);
        }
        insertRun.run(
          run.id,
          review.id,
          projectId,
          run.protocolRevisionId,
          run.provider,
          run.model,
          run.stage,
          run.status,
          JSON.stringify(run.paperIds),
          JSON.stringify(run.fieldIds),
          run.paperIds.length,
          run.completedCount,
          run.failedCount,
          run.cancelledCount,
          run.error ?? null,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.createdAt,
          run.updatedAt
        );
      }
      const insertRunItem = this.db.prepare(
        `INSERT INTO review_run_items (
           id, run_id, review_id, paper_id, paper_snapshot_json, status, recommendation_json,
           attempts, stale, error, started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const { parsed: item, paperSnapshot, stale } of runItems) {
        if (!runIds.has(item.runId)) throw new Error(`Portable run item has missing run: ${item.id}`);
        const itemRun = runs.find((run) => run.id === item.runId)!;
        insertRunItem.run(
          item.id,
          item.runId,
          review.id,
          paperIds.has(item.paperId) ? item.paperId : null,
          JSON.stringify(paperSnapshot),
          item.status,
          JSON.stringify({
            suggestedDecision: item.suggestedDecision,
            suggestedReasonCriterionId: item.suggestedReasonCriterionId,
            suggestedCustomReason: item.suggestedCustomReason,
            rationale: item.rationale,
            criterionAssessments: item.criterionAssessments,
            extractionSuggestions: item.extractionSuggestions
          }),
          item.attemptCount,
          stale || itemRun.protocolRevisionId !== review.currentRevisionId ? 1 : 0,
          item.error ?? null,
          item.startedAt ?? null,
          item.completedAt ?? null,
          item.createdAt,
          item.updatedAt
        );
      }
      const insertValue = this.db.prepare(
        `INSERT INTO extraction_values (
           id, review_id, field_id, field_revision, paper_id, paper_snapshot_json,
           run_item_id, value_json, status, provenance, confirmed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const value of values) {
        if (value.reviewId !== review.id || !fieldIds.has(value.fieldId)) {
          throw new Error(`Portable extraction value is outside the imported review: ${value.id}`);
        }
        insertValue.run(
          value.id,
          review.id,
          value.fieldId,
          value.fieldRevision,
          paperIds.has(value.paperId) ? value.paperId : null,
          JSON.stringify(value.paperSnapshot),
          value.runItemId && runItemIds.has(value.runItemId) ? value.runItemId : null,
          JSON.stringify(value.value),
          value.status,
          value.origin,
          value.confirmedAt ?? null,
          value.createdAt,
          value.updatedAt
        );
      }
      const insertEvidence = this.db.prepare(
        `INSERT INTO review_evidence (
           id, review_id, extraction_value_id, run_id, run_item_id, evidence_id, source_type,
           paper_id, paper_snapshot_json, artifact_id, chunk_id, title, excerpt, page, locator, doi, url,
           retrieval_score, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const entry of evidence) {
        if (entry.reviewId !== review.id) throw new Error(`Portable evidence has wrong review: ${entry.id}`);
        const runItemId = evidenceRunItemIds.get(entry.id) ?? entry.runItemId;
        const runItem = runItemId ? runItems.find((candidate) => candidate.parsed.id === runItemId)?.parsed : undefined;
        const runId = entry.runId && runIds.has(entry.runId) ? entry.runId : runItem?.runId;
        const artifactId = entry.artifactId && artifactIds.has(entry.artifactId) ? entry.artifactId : undefined;
        const chunkId =
          entry.chunkId && artifactId && chunkArtifactIds.get(entry.chunkId) === artifactId ? entry.chunkId : undefined;
        insertEvidence.run(
          entry.id,
          review.id,
          null,
          runId ?? null,
          runItemId && runItemIds.has(runItemId) ? runItemId : null,
          entry.evidenceId,
          entry.sourceType,
          entry.paperId && paperIds.has(entry.paperId) ? entry.paperId : null,
          JSON.stringify(evidenceSnapshots.get(entry.id) ?? (entry.paperId ? { id: entry.paperId } : {})),
          artifactId ?? null,
          chunkId ?? null,
          entry.title,
          entry.excerpt,
          entry.page ?? null,
          entry.locator ?? null,
          entry.doi ?? null,
          entry.url ?? null,
          entry.retrievalScore ?? null,
          entry.createdAt
        );
      }
      const insertValueEvidence = this.db.prepare(
        `INSERT INTO review_extraction_value_evidence (value_id, evidence_id, created_at)
         VALUES (?, ?, ?)`
      );
      for (const [evidenceId, linkedValueIds] of evidenceValueIds) {
        for (const valueId of linkedValueIds) insertValueEvidence.run(valueId, evidenceId, review.updatedAt);
      }
      const insertFieldHistory = this.db.prepare(
        `INSERT INTO extraction_field_revisions (
           field_id, review_id, revision, name, description, field_type, options_json,
           ordinal, active, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const entry of portableFieldHistory) {
        insertFieldHistory.run(
          entry.id,
          review.id,
          entry.revision,
          entry.name,
          entry.description ?? null,
          entry.type,
          JSON.stringify(entry.options),
          entry.order,
          entry.active ? 1 : 0,
          entry.recordedAt
        );
      }
      const insertValueHistory = this.db.prepare(
        `INSERT INTO extraction_value_revisions (
           value_id, change_revision, review_id, field_id, field_revision, paper_id,
           paper_snapshot_json, run_item_id, value_json, status, provenance,
           evidence_ids_json, confirmed_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const entry of portableValueHistory) {
        insertValueHistory.run(
          entry.id,
          entry.changeRevision,
          review.id,
          entry.fieldId,
          entry.fieldRevision,
          paperIds.has(entry.paperId) ? entry.paperId : null,
          JSON.stringify(entry.paperSnapshot),
          entry.runItemId && runItemIds.has(entry.runItemId) ? entry.runItemId : null,
          JSON.stringify(entry.value),
          entry.status,
          entry.origin,
          JSON.stringify(entry.evidenceIds),
          entry.confirmedAt ?? null,
          entry.recordedAt
        );
      }
      const insertAudit = this.db.prepare(
        `INSERT INTO review_audit_events (
           id, review_id, project_id, actor, action, entity_type, entity_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const event of auditEvents) {
        if (event.reviewId !== review.id) throw new Error(`Portable audit event has wrong review: ${event.id}`);
        insertAudit.run(
          event.id,
          review.id,
          projectId,
          event.actor,
          event.kind,
          event.entityType ?? null,
          event.entityId ?? null,
          JSON.stringify(event.payload),
          event.createdAt
        );
      }
    });
    return this.getReview(projectId)!;
  }

  listReviewPapers(input: ReviewPaperQuery): ReviewPaperPage {
    const query = reviewPaperQuerySchema.parse(input);
    const review = this.getReviewById(query.reviewId);
    if (!review) throw new Error(`Review not found: ${query.reviewId}`);
    const papers = this.listPapers(review.projectId);
    const decisions = this.currentScreeningDecisionRows(query.reviewId);
    const currentDecisions = new Map<string, ScreeningDecision>();
    for (const decision of decisions) currentDecisions.set(`${decision.paperId}:${decision.stage}`, decision);
    const batchIds = new Map(
      (
        this.db
          .prepare(
            `SELECT paper_id, json_group_array(DISTINCT batch_id) AS batch_ids
             FROM review_candidate_origins
             WHERE review_id = ? AND paper_id IS NOT NULL
             GROUP BY paper_id`
          )
          .all(query.reviewId) as Row[]
      ).map((row) => [String(row.paper_id), parseJson<string[]>(row.batch_ids, [])])
    );
    const fullTextIds = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT chunk.paper_id
             FROM document_chunks chunk
             JOIN artifacts artifact ON artifact.id = chunk.artifact_id AND artifact.project_id = chunk.project_id
             WHERE chunk.project_id = ?
               AND chunk.paper_id IS NOT NULL
               AND length(trim(chunk.text)) > 0
               AND artifact.type IN ('paper-pdf', 'markdown', 'table')
               AND COALESCE(artifact.source, '') != 'research-chat'
               AND json_extract(artifact.metadata_json, '$.paperId') = chunk.paper_id`
          )
          .all(review.projectId) as Row[]
      ).map((row) => String(row.paper_id))
    );
    const openRereviewRows = this.db
      .prepare(
        `SELECT paper_id, paper_snapshot_json, stage, invalidates_downstream FROM review_rereview_flags
         WHERE review_id = ? AND resolved_at IS NULL`
      )
      .all(query.reviewId) as Row[];
    const openRereview = new Set(
      openRereviewRows.map(
        (row) => `${this.reviewPaperIdentity(row.paper_id, row.paper_snapshot_json)}:${String(row.stage)}`
      )
    );
    const downstreamInvalidated = new Set(
      openRereviewRows
        .filter((row) => Boolean(row.invalidates_downstream))
        .map((row) => `${this.reviewPaperIdentity(row.paper_id, row.paper_snapshot_json)}:${String(row.stage)}`)
    );
    const activeFieldCount = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS count FROM extraction_fields WHERE review_id = ? AND active = 1")
          .get(query.reviewId) as Row
      ).count ?? 0
    );
    const extractionRows = this.db
      .prepare(
        `SELECT paper_id,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN status IN ('suggested', 'rejected', 'needs-review') THEN 1 ELSE 0 END) AS needs_review
         FROM extraction_values WHERE review_id = ? AND paper_id IS NOT NULL GROUP BY paper_id`
      )
      .all(query.reviewId) as Row[];
    const extractionProgress = new Map(
      extractionRows.map((row) => [
        String(row.paper_id),
        { total: activeFieldCount, confirmed: Number(row.confirmed ?? 0), needsReview: Number(row.needs_review ?? 0) }
      ])
    );
    const latestSuggestionStale = new Map<string, boolean>();
    const suggestionRows = this.db
      .prepare(
        `SELECT item.paper_id, item.paper_snapshot_json, item.recommendation_json, item.stale
         FROM review_run_items item
         JOIN review_runs run ON run.id = item.run_id
         WHERE item.review_id = ? AND run.stage = ? AND item.status = 'completed'
         ORDER BY run.updated_at ASC, run.rowid ASC, item.rowid ASC`
      )
      .all(query.reviewId, query.stage) as Row[];
    for (const row of suggestionRows) {
      const recommendation = parseJson<Record<string, unknown>>(row.recommendation_json, {});
      const isActionable =
        query.stage === "extraction"
          ? Array.isArray(recommendation.extractionSuggestions) && recommendation.extractionSuggestions.length > 0
          : typeof recommendation.suggestedDecision === "string";
      if (!isActionable) continue;
      const paperId = this.reviewPaperIdentity(row.paper_id, row.paper_snapshot_json);
      if (paperId) latestSuggestionStale.set(paperId, Boolean(row.stale));
    }
    const createdRows = this.db
      .prepare("SELECT id, created_at FROM papers WHERE project_id = ?")
      .all(review.projectId) as Row[];
    const createdAtByPaper = new Map(createdRows.map((row) => [String(row.id), String(row.created_at)]));
    const summaries = papers
      .map((paper) => {
        const titleAbstractDecision = currentDecisions.get(`${paper.id}:title-abstract`);
        const fullTextDecision = currentDecisions.get(`${paper.id}:full-text`);
        return {
          reviewId: query.reviewId,
          paperId: paper.id,
          title: paper.title,
          authors: paper.authors,
          abstract: paper.abstract,
          year: paper.year,
          venue: paper.venue,
          doi: paper.doi,
          source: paper.source,
          discoveryBatchIds: batchIds.get(paper.id) ?? [],
          hasFullText: fullTextIds.has(paper.id),
          titleAbstractDecision,
          fullTextDecision,
          extractionProgress: extractionProgress.get(paper.id) ?? {
            total: activeFieldCount,
            confirmed: 0,
            needsReview: 0
          },
          needsReReview: openRereview.has(`${paper.id}:title-abstract`) || openRereview.has(`${paper.id}:full-text`),
          aiSuggestionStale: latestSuggestionStale.get(paper.id) ?? false,
          createdAt: createdAtByPaper.get(paper.id) ?? ""
        };
      })
      .filter((paper) => {
        if (query.stage === "full-text" && paper.titleAbstractDecision?.decision !== "include") return false;
        if (
          query.stage === "extraction" &&
          (paper.titleAbstractDecision?.decision !== "include" ||
            paper.fullTextDecision?.decision !== "include" ||
            downstreamInvalidated.has(`${paper.paperId}:full-text`))
        )
          return false;
        if (query.search) {
          const haystack =
            `${paper.title}\n${paper.abstract ?? ""}\n${paper.authors.join(" ")}\n${paper.doi ?? ""}`.toLowerCase();
          if (!haystack.includes(query.search.toLowerCase())) return false;
        }
        if (query.sources.length && !query.sources.includes(paper.source)) return false;
        if (query.yearFrom !== undefined && (paper.year === undefined || paper.year < query.yearFrom)) return false;
        if (query.yearTo !== undefined && (paper.year === undefined || paper.year > query.yearTo)) return false;
        if (query.fullText === "available" && !paper.hasFullText) return false;
        if (query.fullText === "missing" && paper.hasFullText) return false;
        if (query.needsReReview !== undefined && paper.needsReReview !== query.needsReReview) return false;
        return true;
      });
    const decisionForStage = (paper: (typeof summaries)[number]) =>
      query.stage === "title-abstract" ? paper.titleAbstractDecision?.decision : paper.fullTextDecision?.decision;
    const counts = { pending: 0, include: 0, exclude: 0, uncertain: 0 };
    for (const paper of summaries) counts[decisionForStage(paper) ?? "pending"] += 1;
    const filtered = query.decisions.length
      ? summaries.filter((paper) => query.decisions.includes(decisionForStage(paper) ?? "pending"))
      : summaries;
    filtered.sort((left, right) => {
      let comparison: number;
      if (query.sort === "title") comparison = left.title.localeCompare(right.title);
      else if (query.sort === "year") comparison = (left.year ?? 0) - (right.year ?? 0);
      else comparison = left.createdAt.localeCompare(right.createdAt);
      if (comparison === 0) comparison = left.paperId.localeCompare(right.paperId);
      return query.direction === "asc" ? comparison : -comparison;
    });
    const start = (query.page - 1) * query.pageSize;
    return {
      items: filtered.slice(start, start + query.pageSize).map((paper) => reviewPaperSummarySchema.parse(paper)),
      page: query.page,
      pageSize: query.pageSize,
      total: filtered.length,
      totalPages: filtered.length ? Math.ceil(filtered.length / query.pageSize) : 0,
      counts
    };
  }

  listExtractionFields(reviewId: string, includeInactive = false): ExtractionField[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM extraction_fields WHERE review_id = ? ${includeInactive ? "" : "AND active = 1"}
         ORDER BY ordinal, id`
      )
      .all(reviewId) as Row[];
    return rows.map((row) => this.extractionFieldFromRow(row));
  }

  listExtractionFieldHistory(fieldId: string): ExtractionFieldHistoryEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM extraction_field_revisions WHERE field_id = ? ORDER BY revision")
        .all(fieldId) as Row[]
    ).map((row) => ({
      ...this.extractionFieldFromRevisionRow(row),
      recordedAt: String(row.recorded_at)
    }));
  }

  saveExtractionField(input: {
    id?: string;
    reviewId: string;
    name: string;
    description?: string;
    type: ExtractionField["type"];
    options?: string[];
    order?: number;
    active?: boolean;
  }): ExtractionField {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const existing = input.id
      ? (this.db.prepare("SELECT * FROM extraction_fields WHERE id = ?").get(input.id) as Row | undefined)
      : undefined;
    if (existing && String(existing.review_id) !== input.reviewId) {
      throw new Error(`Extraction field belongs to another review: ${input.id}`);
    }
    const willActivate = (input.active ?? (existing ? Boolean(existing.active) : true)) && !existing?.active;
    if (willActivate) {
      const activeCount = this.listExtractionFields(input.reviewId).length;
      if (activeCount >= MAX_EXTRACTION_FIELDS) {
        throw new Error(`Reviews support at most ${MAX_EXTRACTION_FIELDS} active extraction fields.`);
      }
    }
    const fieldId = input.id ?? id("field");
    const createdAt = existing ? String(existing.created_at) : nowIso();
    const updatedAt = nowIso();
    const options = input.options ?? [];
    const field = extractionFieldSchema.parse({
      id: fieldId,
      reviewId: input.reviewId,
      name: input.name,
      description: input.description,
      type: input.type,
      options,
      order:
        input.order ?? (existing ? Number(existing.ordinal) : this.listExtractionFields(input.reviewId, true).length),
      revision: existing ? Number(existing.revision) : 1,
      active: input.active ?? (existing ? Boolean(existing.active) : true),
      createdAt,
      updatedAt
    });
    const semanticChange =
      !!existing &&
      (String(existing.name) !== field.name ||
        normalizeOptional(existing.description == null ? undefined : String(existing.description)) !==
          field.description ||
        String(existing.field_type) !== field.type ||
        JSON.stringify(parseJson<string[]>(existing.options_json, [])) !== JSON.stringify(field.options));
    if (semanticChange) field.revision = Number(existing!.revision) + 1;
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO extraction_fields (
             id, review_id, name, description, field_type, options_json, ordinal,
             revision, active, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             field_type = excluded.field_type,
             options_json = excluded.options_json,
             ordinal = excluded.ordinal,
             revision = excluded.revision,
             active = excluded.active,
             updated_at = excluded.updated_at`
        )
        .run(
          field.id,
          field.reviewId,
          field.name,
          field.description ?? null,
          field.type,
          JSON.stringify(field.options),
          field.order,
          field.revision,
          field.active ? 1 : 0,
          field.createdAt,
          field.updatedAt
        );
      if (semanticChange) {
        this.markExtractionValuesNeedsReview(
          "review_id = ? AND field_id = ?",
          [input.reviewId, field.id],
          updatedAt,
          field.revision
        );
      }
      if (!existing || semanticChange) this.recordExtractionFieldRevision(field, updatedAt);
      this.insertReviewAuditEvent({
        reviewId: input.reviewId,
        projectId: review.projectId,
        actor: "user",
        action: existing ? "extraction-field-revised" : "extraction-field-created",
        entityType: "extraction-field",
        entityId: field.id,
        payload: { semanticChange, revision: field.revision },
        createdAt: updatedAt
      });
    });
    return this.listExtractionFields(input.reviewId, true).find((candidate) => candidate.id === field.id)!;
  }

  saveExtractionValue(input: {
    id?: string;
    reviewId: string;
    paperId: string;
    fieldId: string;
    value: ExtractionValue["value"];
    status: ExtractionValue["status"];
    origin: ExtractionValue["origin"];
    evidenceIds?: string[];
    runItemId?: string;
    createdAt?: string;
    updatedAt?: string;
    confirmedAt?: string;
  }): ExtractionValue {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const paper = this.getPaper(review.projectId, input.paperId);
    if (!paper) throw new Error(`Paper not found in review project: ${input.paperId}`);
    if (!this.isPaperEligibleForExtraction(input.reviewId, input.paperId)) {
      throw new Error("Extraction values may only be saved for papers currently included at both screening stages.");
    }
    const field = this.listExtractionFields(input.reviewId, true).find((candidate) => candidate.id === input.fieldId);
    if (!field || !field.active) throw new Error(`Active extraction field not found: ${input.fieldId}`);
    this.assertExtractionValueMatchesField(field, input.value, input.status);
    const existing = this.db
      .prepare("SELECT * FROM extraction_values WHERE review_id = ? AND field_id = ? AND paper_id = ?")
      .get(input.reviewId, input.fieldId, input.paperId) as Row | undefined;
    if (input.id && existing && String(existing.id) !== input.id) {
      throw new Error(`Extraction value identity does not match the existing review cell: ${input.id}`);
    }
    if (input.id) {
      const identified = this.db.prepare("SELECT review_id FROM extraction_values WHERE id = ?").get(input.id) as
        Row | undefined;
      if (identified && String(identified.review_id) !== input.reviewId) {
        throw new Error(`Extraction value belongs to another review: ${input.id}`);
      }
    }
    const valueId = input.id ?? (existing ? String(existing.id) : id("value"));
    const evidenceIds = input.evidenceIds ?? (existing ? this.listEvidenceIdsForValue(String(existing.id)) : []);
    let runItemStale = false;
    if (input.runItemId) {
      const runItem = this.db
        .prepare(
          `SELECT item.review_id, item.paper_id, item.paper_snapshot_json, item.stale, run.stage
           FROM review_run_items item
           JOIN review_runs run ON run.id = item.run_id
           WHERE item.id = ?`
        )
        .get(input.runItemId) as Row | undefined;
      if (
        !runItem ||
        String(runItem.review_id) !== input.reviewId ||
        this.reviewPaperIdentity(runItem.paper_id, runItem.paper_snapshot_json) !== input.paperId ||
        String(runItem.stage) !== "extraction"
      ) {
        throw new Error("The linked review run item must belong to the same review, paper, and extraction stage.");
      }
      runItemStale = Boolean(runItem.stale);
    }
    const createdAt = input.createdAt ?? (existing ? String(existing.created_at) : nowIso());
    const updatedAt = input.updatedAt ?? nowIso();
    const effectiveStatus = input.origin === "ai" && runItemStale ? "needs-review" : input.status;
    const confirmedAt = effectiveStatus === "confirmed" ? (input.confirmedAt ?? updatedAt) : undefined;
    const value = extractionValueSchema.parse({
      id: valueId,
      reviewId: input.reviewId,
      paperId: input.paperId,
      fieldId: input.fieldId,
      fieldRevision: field.revision,
      value: input.value,
      status: effectiveStatus,
      origin: input.origin,
      evidenceIds,
      runItemId: input.runItemId,
      createdAt,
      updatedAt,
      confirmedAt
    });
    this.withTransaction(() => {
      if (evidenceIds.length) {
        const placeholders = evidenceIds.map(() => "?").join(", ");
        const evidenceRows = this.db
          .prepare(
            `SELECT id, paper_id, paper_snapshot_json
             FROM review_evidence WHERE review_id = ? AND id IN (${placeholders})`
          )
          .all(input.reviewId, ...evidenceIds) as Row[];
        if (evidenceRows.length !== new Set(evidenceIds).size)
          throw new Error("One or more extraction evidence references are invalid.");
        for (const evidenceRow of evidenceRows) {
          if (this.reviewPaperIdentity(evidenceRow.paper_id, evidenceRow.paper_snapshot_json) !== input.paperId) {
            throw new Error("Extraction evidence must belong to the same paper as the extraction value.");
          }
        }
      }
      this.db
        .prepare(
          `INSERT INTO extraction_values (
             id, review_id, field_id, field_revision, paper_id, paper_snapshot_json,
             run_item_id, value_json, status, provenance, confirmed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(review_id, field_id, paper_id) DO UPDATE SET
             field_revision = excluded.field_revision,
             paper_snapshot_json = excluded.paper_snapshot_json,
             run_item_id = excluded.run_item_id,
             value_json = excluded.value_json,
             status = excluded.status,
             provenance = excluded.provenance,
             confirmed_at = excluded.confirmed_at,
             updated_at = excluded.updated_at`
        )
        .run(
          value.id,
          value.reviewId,
          value.fieldId,
          value.fieldRevision,
          value.paperId,
          JSON.stringify(paper),
          value.runItemId ?? null,
          JSON.stringify(value.value),
          value.status,
          value.origin,
          value.confirmedAt ?? null,
          value.createdAt,
          value.updatedAt
        );
      this.db.prepare("DELETE FROM review_extraction_value_evidence WHERE value_id = ?").run(value.id);
      const linkEvidence = this.db.prepare(
        `INSERT INTO review_extraction_value_evidence (value_id, evidence_id, created_at)
         VALUES (?, ?, ?)`
      );
      for (const evidenceId of evidenceIds) linkEvidence.run(value.id, evidenceId, updatedAt);
      this.recordExtractionValueRevision(value.id, updatedAt);
      if (value.status === "confirmed" || value.status === "rejected" || value.status === "not-found") {
        const action =
          value.status === "confirmed"
            ? "extraction-value-confirmed"
            : value.status === "rejected"
              ? "extraction-value-rejected"
              : "extraction-value-not-found";
        this.insertReviewAuditEvent({
          reviewId: input.reviewId,
          projectId: review.projectId,
          actor: "user",
          action,
          entityType: "extraction-value",
          entityId: value.id,
          payload: {
            paperId: value.paperId,
            fieldId: value.fieldId,
            origin: value.origin,
            runItemId: value.runItemId
          },
          createdAt: updatedAt
        });
      }
    });
    return this.getExtractionValue(value.id)!;
  }

  getExtractionValue(valueId: string): ExtractionValue | undefined {
    const row = this.db.prepare("SELECT * FROM extraction_values WHERE id = ?").get(valueId) as Row | undefined;
    return row ? this.extractionValueFromRow(row) : undefined;
  }

  listExtractionValues(reviewId: string, paperId?: string): ExtractionValue[] {
    const rows = paperId
      ? this.db
          .prepare("SELECT * FROM extraction_values WHERE review_id = ? AND paper_id = ? ORDER BY field_id")
          .all(reviewId, paperId)
      : this.db
          .prepare("SELECT * FROM extraction_values WHERE review_id = ? ORDER BY paper_id, field_id")
          .all(reviewId);
    return (rows as Row[]).map((row) => this.extractionValueFromRow(row));
  }

  listExtractionValueHistory(valueId: string): ExtractionValueHistoryEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM extraction_value_revisions WHERE value_id = ? ORDER BY change_revision")
        .all(valueId) as Row[]
    ).map((row) => this.extractionValueHistoryFromRow(row));
  }

  saveReviewEvidence(evidence: ReviewEvidence, extractionValueId?: string): ReviewEvidence {
    const parsed = reviewEvidenceSchema.parse(evidence);
    const review = this.getReviewById(parsed.reviewId);
    if (!review) throw new Error(`Review not found: ${parsed.reviewId}`);
    const existing = this.db.prepare("SELECT * FROM review_evidence WHERE id = ?").get(parsed.id) as Row | undefined;
    if (existing && String(existing.review_id) !== parsed.reviewId) {
      throw new Error(`Review evidence belongs to another review: ${parsed.id}`);
    }
    const paper = parsed.paperId ? this.getPaper(review.projectId, parsed.paperId) : undefined;
    if (parsed.paperId && !paper) {
      throw new Error(`Paper not found in review project: ${parsed.paperId}`);
    }
    if (parsed.artifactId && !this.getArtifact(review.projectId, parsed.artifactId)) {
      throw new Error(`Artifact not found in review project: ${parsed.artifactId}`);
    }
    if (parsed.runId && this.getReviewRun(parsed.runId)?.reviewId !== parsed.reviewId) {
      throw new Error(`Review run not found in review: ${parsed.runId}`);
    }
    const runItem = parsed.runItemId
      ? (this.db
          .prepare("SELECT review_id, run_id, paper_id, paper_snapshot_json FROM review_run_items WHERE id = ?")
          .get(parsed.runItemId) as Row | undefined)
      : undefined;
    if (parsed.runItemId) {
      if (!runItem || String(runItem.review_id) !== parsed.reviewId) {
        throw new Error(`Review run item not found in review: ${parsed.runItemId}`);
      }
      if (parsed.runId && String(runItem.run_id) !== parsed.runId) {
        throw new Error("Review evidence run and run item must match.");
      }
      if (
        parsed.paperId &&
        this.reviewPaperIdentity(runItem.paper_id, runItem.paper_snapshot_json) !== parsed.paperId
      ) {
        throw new Error("Review evidence must belong to the run item's paper.");
      }
    }
    const extractionValue = extractionValueId
      ? (this.db
          .prepare("SELECT review_id, paper_id, paper_snapshot_json FROM extraction_values WHERE id = ?")
          .get(extractionValueId) as Row | undefined)
      : undefined;
    if (extractionValueId) {
      const value = extractionValue;
      if (!value || String(value.review_id) !== parsed.reviewId) {
        throw new Error(`Extraction value not found in review: ${extractionValueId}`);
      }
      if (parsed.paperId && this.reviewPaperIdentity(value.paper_id, value.paper_snapshot_json) !== parsed.paperId) {
        throw new Error("Review evidence must belong to the extraction value's paper.");
      }
    }
    const paperIdentity =
      parsed.paperId ??
      this.reviewPaperIdentity(runItem?.paper_id, runItem?.paper_snapshot_json) ??
      this.reviewPaperIdentity(extractionValue?.paper_id, extractionValue?.paper_snapshot_json) ??
      this.reviewPaperIdentity(existing?.paper_id, existing?.paper_snapshot_json);
    const existingPaperIdentity = this.reviewPaperIdentity(existing?.paper_id, existing?.paper_snapshot_json);
    if (existingPaperIdentity && paperIdentity && existingPaperIdentity !== paperIdentity) {
      throw new Error("Review evidence paper identity is immutable.");
    }
    const paperSnapshot =
      paper ??
      this.reviewPaperSnapshot(runItem?.paper_snapshot_json) ??
      this.reviewPaperSnapshot(extractionValue?.paper_snapshot_json) ??
      this.reviewPaperSnapshot(existing?.paper_snapshot_json) ??
      (paperIdentity ? { id: paperIdentity } : {});
    if (parsed.sourceType === "artifact-chunk") {
      if (!parsed.artifactId || !parsed.chunkId) {
        throw new Error("Artifact-chunk evidence requires an artifact and chunk.");
      }
      const chunk = this.db
        .prepare(
          `SELECT chunk.paper_id
           FROM document_chunks chunk
           JOIN artifacts artifact ON artifact.id = chunk.artifact_id AND artifact.project_id = chunk.project_id
           WHERE chunk.id = ? AND chunk.artifact_id = ? AND chunk.project_id = ?
             AND length(trim(chunk.text)) > 0
             AND artifact.type IN ('paper-pdf', 'markdown', 'table')
             AND COALESCE(artifact.source, '') != 'research-chat'
             AND json_extract(artifact.metadata_json, '$.paperId') = ?
             AND chunk.paper_id = ?`
        )
        .get(parsed.chunkId, parsed.artifactId, review.projectId, paperIdentity ?? null, paperIdentity ?? null) as
        Row | undefined;
      if (!chunk) throw new Error("Artifact-chunk evidence must reference a trusted indexed chunk.");
    } else if (!paperIdentity) {
      throw new Error("Paper metadata and abstract evidence require a paper.");
    }
    this.db
      .prepare(
        `INSERT INTO review_evidence (
           id, review_id, extraction_value_id, run_id, run_item_id, evidence_id,
           source_type, paper_id, paper_snapshot_json, artifact_id, chunk_id, title, excerpt, page,
           locator, doi, url, retrieval_score, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           extraction_value_id = COALESCE(excluded.extraction_value_id, review_evidence.extraction_value_id),
           paper_snapshot_json = CASE
             WHEN review_evidence.paper_snapshot_json = '{}' THEN excluded.paper_snapshot_json
             ELSE review_evidence.paper_snapshot_json
           END,
           title = excluded.title,
           excerpt = excluded.excerpt,
           page = excluded.page,
           locator = excluded.locator,
           doi = excluded.doi,
           url = excluded.url,
           retrieval_score = excluded.retrieval_score`
      )
      .run(
        parsed.id,
        parsed.reviewId,
        null,
        parsed.runId ?? null,
        parsed.runItemId ?? null,
        parsed.evidenceId,
        parsed.sourceType,
        parsed.paperId ?? null,
        JSON.stringify(paperSnapshot),
        parsed.artifactId ?? null,
        parsed.chunkId ?? null,
        parsed.title,
        parsed.excerpt,
        parsed.page ?? null,
        parsed.locator ?? null,
        parsed.doi ?? null,
        parsed.url ?? null,
        parsed.retrievalScore ?? null,
        parsed.createdAt
      );
    if (extractionValueId) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO review_extraction_value_evidence (value_id, evidence_id, created_at)
           VALUES (?, ?, ?)`
        )
        .run(extractionValueId, parsed.id, nowIso());
      this.recordExtractionValueRevision(extractionValueId, nowIso());
    }
    return this.getReviewEvidence(parsed.id)!;
  }

  getReviewEvidence(evidenceId: string): ReviewEvidence | undefined {
    const row = this.db.prepare("SELECT * FROM review_evidence WHERE id = ?").get(evidenceId) as Row | undefined;
    return row ? this.reviewEvidenceFromRow(row) : undefined;
  }

  listReviewEvidence(
    reviewId: string,
    options: { runId?: string; runItemId?: string; extractionValueId?: string } = {}
  ): ReviewEvidence[] {
    const conditions = ["review_id = ?"];
    const parameters: string[] = [reviewId];
    if (options.runId) {
      conditions.push("run_id = ?");
      parameters.push(options.runId);
    }
    if (options.runItemId) {
      conditions.push("run_item_id = ?");
      parameters.push(options.runItemId);
    }
    if (options.extractionValueId) {
      conditions.push("id IN (SELECT evidence_id FROM review_extraction_value_evidence WHERE value_id = ?)");
      parameters.push(options.extractionValueId);
    }
    return (
      this.db
        .prepare(`SELECT * FROM review_evidence WHERE ${conditions.join(" AND ")} ORDER BY created_at, id`)
        .all(...parameters) as Row[]
    ).map((row) => this.reviewEvidenceFromRow(row));
  }

  saveReviewRun(run: ReviewRun): ReviewRun {
    const parsed = reviewRunSchema.parse(run);
    if (parsed.paperIds.length > MAX_REVIEW_BATCH_PAPERS) {
      throw new Error(`Review runs support at most ${MAX_REVIEW_BATCH_PAPERS} papers.`);
    }
    const review = this.getReviewById(parsed.reviewId);
    if (!review) throw new Error(`Review not found: ${parsed.reviewId}`);
    const existing = this.getReviewRun(parsed.id);
    if (existing && existing.reviewId !== parsed.reviewId) {
      throw new Error(`Review run belongs to another review: ${parsed.id}`);
    }
    const revision = this.getReviewProtocolRevision(parsed.reviewId, parsed.protocolRevisionId);
    if (!revision) throw new Error(`Protocol revision not found in review: ${parsed.protocolRevisionId}`);
    const reviewFieldIds = new Set(this.listExtractionFields(parsed.reviewId, true).map((field) => field.id));
    if (parsed.fieldIds.some((fieldId) => !reviewFieldIds.has(fieldId))) {
      throw new Error("Review run references an extraction field outside its review.");
    }
    for (const paperId of parsed.paperIds) {
      if (!this.getPaper(review.projectId, paperId)) throw new Error(`Paper not found in review project: ${paperId}`);
      if (
        parsed.stage === "full-text" &&
        this.getCurrentScreeningDecision(parsed.reviewId, paperId, "title-abstract")?.decision !== "include"
      ) {
        throw new Error(`Paper must pass title/abstract screening before a full-text run: ${paperId}`);
      }
      if (parsed.stage === "extraction" && !this.isPaperEligibleForExtraction(parsed.reviewId, paperId)) {
        throw new Error(`Paper must currently pass both screening stages before an extraction run: ${paperId}`);
      }
    }
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_runs (
           id, review_id, project_id, protocol_revision_id, provider, model, stage, status,
           selected_paper_ids_json, extraction_field_ids_json, total_items, completed_items, failed_items, cancelled_items,
           error, started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           completed_items = excluded.completed_items,
           failed_items = excluded.failed_items,
           cancelled_items = excluded.cancelled_items,
           error = excluded.error,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           updated_at = excluded.updated_at`
        )
        .run(
          parsed.id,
          parsed.reviewId,
          review.projectId,
          parsed.protocolRevisionId,
          parsed.provider,
          parsed.model,
          parsed.stage,
          parsed.status,
          JSON.stringify(parsed.paperIds),
          JSON.stringify(parsed.fieldIds),
          parsed.paperIds.length,
          parsed.completedCount,
          parsed.failedCount,
          parsed.cancelledCount,
          parsed.error ?? null,
          parsed.startedAt ?? null,
          parsed.completedAt ?? null,
          parsed.createdAt,
          parsed.updatedAt
        );
    });
    return this.getReviewRun(parsed.id)!;
  }

  getReviewRun(runId: string): ReviewRun | undefined {
    const row = this.db.prepare("SELECT * FROM review_runs WHERE id = ?").get(runId) as Row | undefined;
    return row ? this.reviewRunFromRow(row) : undefined;
  }

  listReviewRuns(reviewId: string): ReviewRun[] {
    return (
      this.db
        .prepare("SELECT * FROM review_runs WHERE review_id = ? ORDER BY created_at DESC, id DESC")
        .all(reviewId) as Row[]
    ).map((row) => this.reviewRunFromRow(row));
  }

  markInterruptedReviewRuns(): number {
    const rows = this.db
      .prepare("SELECT id, review_id, project_id FROM review_runs WHERE status IN ('queued', 'running')")
      .all() as Row[];
    if (!rows.length) return 0;
    const updatedAt = nowIso();
    const error = "Interrupted because Paper Pilot restarted before this review run completed.";
    this.transaction(() => {
      for (const row of rows) {
        this.db
          .prepare(
            `UPDATE review_run_items
             SET status = 'cancelled', error = COALESCE(error, ?), completed_at = ?, updated_at = ?
             WHERE run_id = ? AND status IN ('queued', 'running')`
          )
          .run(error, updatedAt, updatedAt, String(row.id));
        this.db
          .prepare(
            `UPDATE review_runs
             SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(error, updatedAt, updatedAt, String(row.id));
        this.insertReviewAuditEvent({
          reviewId: String(row.review_id),
          projectId: String(row.project_id),
          actor: "system",
          action: "run-cancelled",
          entityType: "review-run",
          entityId: String(row.id),
          payload: { interruptedByRestart: true },
          createdAt: updatedAt
        });
      }
    });
    return rows.length;
  }

  updateReviewRun(
    runId: string,
    patch: Partial<
      Pick<
        ReviewRun,
        "status" | "completedCount" | "failedCount" | "cancelledCount" | "error" | "startedAt" | "completedAt"
      >
    >
  ): ReviewRun {
    const current = this.getReviewRun(runId);
    if (!current) throw new Error(`Review run not found: ${runId}`);
    return this.saveReviewRun({ ...current, ...patch, updatedAt: nowIso() });
  }

  saveReviewRunItem(item: ReviewRunItem): ReviewRunItem {
    const parsed = reviewRunItemSchema.parse(item);
    const run = this.getReviewRun(parsed.runId);
    if (!run) throw new Error(`Review run not found: ${parsed.runId}`);
    const review = this.getReviewById(run.reviewId)!;
    const paper = this.getPaper(review.projectId, parsed.paperId);
    if (!paper) throw new Error(`Paper not found in review project: ${parsed.paperId}`);
    const existingById = this.db
      .prepare("SELECT run_id, review_id, paper_id FROM review_run_items WHERE id = ?")
      .get(parsed.id) as Row | undefined;
    if (
      existingById &&
      (String(existingById.run_id) !== parsed.runId ||
        String(existingById.review_id) !== run.reviewId ||
        String(existingById.paper_id) !== parsed.paperId)
    ) {
      throw new Error(`Review run item identity does not match its run and paper: ${parsed.id}`);
    }
    const existingCell = this.db
      .prepare("SELECT id FROM review_run_items WHERE run_id = ? AND paper_id = ?")
      .get(parsed.runId, parsed.paperId) as Row | undefined;
    if (existingCell && String(existingCell.id) !== parsed.id) {
      throw new Error(`A review run item already exists for paper: ${parsed.paperId}`);
    }
    const recommendation = {
      suggestedDecision: parsed.suggestedDecision,
      suggestedReasonCriterionId: parsed.suggestedReasonCriterionId,
      suggestedCustomReason: parsed.suggestedCustomReason,
      rationale: parsed.rationale,
      criterionAssessments: parsed.criterionAssessments,
      extractionSuggestions: parsed.extractionSuggestions
    };
    const stale =
      run.protocolRevisionId !== review.currentRevisionId ||
      (run.stage === "full-text" &&
        this.getCurrentScreeningDecision(run.reviewId, parsed.paperId, "title-abstract")?.decision !== "include") ||
      (run.stage === "extraction" && !this.isPaperEligibleForExtraction(run.reviewId, parsed.paperId));
    this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_run_items (
             id, run_id, review_id, paper_id, paper_snapshot_json, status,
             recommendation_json, attempts, stale, error, started_at, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             recommendation_json = excluded.recommendation_json,
             attempts = excluded.attempts,
             stale = excluded.stale,
             error = excluded.error,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at,
             updated_at = excluded.updated_at`
        )
        .run(
          parsed.id,
          parsed.runId,
          run.reviewId,
          parsed.paperId,
          JSON.stringify(paper),
          parsed.status,
          JSON.stringify(recommendation),
          parsed.attemptCount,
          stale ? 1 : 0,
          parsed.error ?? null,
          parsed.startedAt ?? null,
          parsed.completedAt ?? null,
          parsed.createdAt,
          parsed.updatedAt
        );
      const suppliedEvidenceIds = new Set(parsed.evidence.map((evidence) => evidence.id));
      for (const evidence of parsed.evidence) {
        if (evidence.paperId && evidence.paperId !== parsed.paperId) {
          throw new Error("Review run item evidence must belong to the selected paper.");
        }
        this.saveReviewEvidence({
          ...evidence,
          reviewId: run.reviewId,
          runId: run.id,
          runItemId: parsed.id,
          paperId: parsed.paperId
        });
      }
      const existingEvidence = this.listReviewEvidence(run.reviewId, { runItemId: parsed.id });
      for (const evidence of existingEvidence) {
        if (!suppliedEvidenceIds.has(evidence.id))
          this.db.prepare("DELETE FROM review_evidence WHERE id = ?").run(evidence.id);
      }
      if (stale) {
        this.markExtractionValuesNeedsReview("run_item_id = ?", [parsed.id], parsed.updatedAt);
      }
    });
    return this.getReviewRunItem(parsed.id)!;
  }

  getReviewRunItem(itemId: string): ReviewRunItem | undefined {
    const row = this.db.prepare("SELECT * FROM review_run_items WHERE id = ?").get(itemId) as Row | undefined;
    return row ? this.reviewRunItemFromRow(row) : undefined;
  }

  listReviewRunItems(runId: string): ReviewRunItem[] {
    return (
      this.db.prepare("SELECT * FROM review_run_items WHERE run_id = ? ORDER BY rowid ASC").all(runId) as Row[]
    ).map((row) => this.reviewRunItemFromRow(row));
  }

  updateReviewRunItem(
    itemId: string,
    patch: Partial<Omit<ReviewRunItem, "id" | "runId" | "paperId" | "createdAt">>
  ): ReviewRunItem {
    const current = this.getReviewRunItem(itemId);
    if (!current) throw new Error(`Review run item not found: ${itemId}`);
    return this.saveReviewRunItem({ ...current, ...patch, updatedAt: nowIso() });
  }

  appendReviewAuditEvent(
    input: Omit<ReviewAuditEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }
  ): ReviewAuditEvent {
    const review = this.getReviewById(input.reviewId);
    if (!review) throw new Error(`Review not found: ${input.reviewId}`);
    const event = reviewAuditEventSchema.parse({
      ...input,
      id: input.id ?? id("audit"),
      createdAt: input.createdAt ?? nowIso()
    });
    this.insertReviewAuditEvent({
      reviewId: event.reviewId,
      projectId: review.projectId,
      actor: event.actor,
      action: event.kind,
      entityType: event.entityType,
      entityId: event.entityId,
      payload: event.payload,
      createdAt: event.createdAt,
      id: event.id
    });
    return event;
  }

  listReviewAuditEvents(reviewId: string): ReviewAuditEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM review_audit_events WHERE review_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(reviewId) as Row[]
    ).map((row) => this.reviewAuditEventFromRow(row));
  }

  getReviewFlowSummary(reviewId: string): ReviewFlowSummary {
    const review = this.getReviewById(reviewId);
    if (!review) throw new Error(`Review not found: ${reviewId}`);
    const batchTotals = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(identified_count), 0) AS identified,
           COALESCE(SUM(filtered_count), 0) AS filtered,
           COALESCE(SUM(invalid_count), 0) AS invalid,
           COALESCE(SUM(duplicate_count), 0) AS duplicates,
           COALESCE(SUM(merged_count), 0) AS merged,
           COALESCE(SUM(new_records_count), 0) AS new_records,
           COUNT(*) AS batch_count,
           MIN(historical_counts_available) AS historical_counts_available
         FROM discovery_batches WHERE review_id = ?`
      )
      .get(reviewId) as Row;
    const currentDecisions = this.currentScreeningDecisionRows(reviewId);
    const abstractDecisions = currentDecisions.filter((decision) => decision.stage === "title-abstract");
    const fullTextsSoughtIds = new Set(
      abstractDecisions.filter((decision) => decision.decision === "include").map((decision) => decision.paperId)
    );
    const staleFullTextPaperIds = new Set(
      (
        this.db
          .prepare(
            `SELECT COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) AS paper_identity
             FROM review_rereview_flags
             WHERE review_id = ? AND stage = 'full-text' AND invalidates_downstream = 1 AND resolved_at IS NULL`
          )
          .all(reviewId) as Row[]
      ).map((row) => String(row.paper_identity))
    );
    const fullTextDecisions = currentDecisions.filter(
      (decision) =>
        decision.stage === "full-text" &&
        fullTextsSoughtIds.has(decision.paperId) &&
        !staleFullTextPaperIds.has(decision.paperId)
    );
    const availableFullTextIds = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT chunk.paper_id
             FROM document_chunks chunk
             JOIN artifacts artifact ON artifact.id = chunk.artifact_id AND artifact.project_id = chunk.project_id
             WHERE chunk.project_id = ?
               AND chunk.paper_id IS NOT NULL
               AND length(trim(chunk.text)) > 0
               AND artifact.type IN ('paper-pdf', 'markdown', 'table')
               AND COALESCE(artifact.source, '') != 'research-chat'
               AND json_extract(artifact.metadata_json, '$.paperId') = chunk.paper_id`
          )
          .all(review.projectId) as Row[]
      ).map((row) => String(row.paper_id))
    );
    const exclusionsByReason: Record<string, number> = {};
    for (const decision of fullTextDecisions.filter((candidate) => candidate.decision === "exclude")) {
      const reason = decision.reasonCriterionId
        ? (this.listReviewCriteria(reviewId, decision.protocolRevisionId).find(
            (criterion) => criterion.id === decision.reasonCriterionId
          )?.label ?? "Unknown criterion")
        : (decision.customReason ?? "Custom reason");
      exclusionsByReason[reason] = (exclusionsByReason[reason] ?? 0) + 1;
    }
    const includedPaperIds = new Set(
      fullTextDecisions.filter((decision) => decision.decision === "include").map((decision) => decision.paperId)
    );
    const fieldCount = this.listExtractionFields(reviewId).length;
    const extractionRows = this.listExtractionValues(reviewId).filter((value) => includedPaperIds.has(value.paperId));
    const totalCells = includedPaperIds.size * fieldCount;
    const confirmedCells = extractionRows.filter((value) => value.status === "confirmed").length;
    const notFoundCells = extractionRows.filter((value) => value.status === "not-found").length;
    const needsReviewStatuses = new Set<ExtractionValue["status"]>(["suggested", "rejected", "needs-review"]);
    const needsReviewCells = extractionRows.filter((value) => needsReviewStatuses.has(value.status)).length;
    const completedCells = confirmedCells + notFoundCells;
    const historicalCountsAvailable =
      review.historicalCountsAvailable &&
      (Number(batchTotals.batch_count ?? 0) === 0 || Boolean(batchTotals.historical_counts_available));
    return reviewFlowSummarySchema.parse({
      reviewId,
      identifiedRecords: Number(batchTotals.identified ?? 0),
      filteredRecords: Number(batchTotals.filtered ?? 0),
      invalidRecords: Number(batchTotals.invalid ?? 0),
      duplicateRecords: Number(batchTotals.duplicates ?? 0),
      mergedRecords: Number(batchTotals.merged ?? 0),
      newRecords: Number(batchTotals.new_records ?? 0),
      uniqueRecordsScreened: new Set(abstractDecisions.map((decision) => decision.paperId)).size,
      titleAbstractExclusions: abstractDecisions.filter((decision) => decision.decision === "exclude").length,
      fullTextsSought: fullTextsSoughtIds.size,
      fullTextsUnavailable: [...fullTextsSoughtIds].filter((paperId) => !availableFullTextIds.has(paperId)).length,
      fullTextExclusionsByReason: exclusionsByReason,
      includedPapers: includedPaperIds.size,
      extraction: {
        totalCells,
        confirmedCells,
        notFoundCells,
        needsReviewCells,
        completionPercent: totalCells ? Math.round((completedCells / totalCells) * 10_000) / 100 : 0
      },
      historicalCountsAvailable,
      warnings: historicalCountsAvailable ? [] : ["Historical discovery and duplicate counts are unavailable."],
      generatedAt: nowIso()
    });
  }

  findPaperLinkedArtifactChunks(projectId: string, paperId: string, limit = 100): ChunkSearchRow[] {
    return (
      this.db
        .prepare(
          `SELECT
             dc.id AS chunkId,
             dc.project_id AS projectId,
             p.title AS projectTitle,
             dc.artifact_id AS artifactId,
             a.title AS artifactTitle,
             a.type AS artifactType,
             a.created_at AS artifactCreatedAt,
             dc.paper_id AS paperId,
             pp.title AS paperTitle,
             dc.text,
             dc.metadata_json AS metadataJson,
             substr(dc.text, 1, 240) AS snippet,
             1.0 AS score
         FROM document_chunks dc
         JOIN projects p ON p.id = dc.project_id
         JOIN artifacts a ON a.id = dc.artifact_id
         LEFT JOIN papers pp ON pp.id = dc.paper_id
         WHERE dc.project_id = ? AND dc.paper_id = ? AND length(trim(dc.text)) > 0
         ORDER BY dc.ordinal ASC LIMIT ?`
        )
        .all(projectId, paperId, Math.max(1, Math.min(limit, 500))) as Row[]
    ).map((row) => this.chunkSearchFromRow(row));
  }

  createConversation(projectId: string, title = "New chat", mode: ChatMode = "grounded"): Conversation {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    const createdAt = nowIso();
    const conversation = conversationSchema.parse({
      id: id("conv"),
      projectId,
      title: title.trim() || "New chat",
      mode,
      createdAt,
      updatedAt: createdAt
    });
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, mode, created_at, updated_at)
         VALUES (@id, @projectId, @title, @mode, @createdAt, @updatedAt)`
      )
      .run(conversation);
    this.touchProject(projectId);
    return conversation;
  }

  ensureDefaultConversation(projectId: string): Conversation {
    return this.listConversations(projectId)[0] ?? this.createConversation(projectId);
  }

  listConversations(projectId: string): Conversation[] {
    return (
      this.db
        .prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at ASC")
        .all(projectId) as Row[]
    ).map((row) => this.conversationFromRow(row));
  }

  getConversation(conversationId: string): Conversation | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as Row | undefined;
    return row ? this.conversationFromRow(row) : undefined;
  }

  updateConversation(conversationId: string, patch: { title?: string; mode?: ChatMode }): Conversation {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    const title = patch.title === undefined ? conversation.title : patch.title.trim();
    if (!title) throw new Error("Conversation title cannot be empty.");
    const updatedAt = nowIso();
    this.db
      .prepare("UPDATE conversations SET title = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(title, patch.mode ?? conversation.mode, updatedAt, conversationId);
    this.touchProject(conversation.projectId);
    return this.getConversation(conversationId)!;
  }

  deleteConversation(conversationId: string): Conversation {
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
      this.db
        .prepare("DELETE FROM tool_runs WHERE run_id IN (SELECT id FROM chat_runs WHERE conversation_id = ?)")
        .run(conversationId);
      this.db.prepare("DELETE FROM chat_runs WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.touchProject(conversation.projectId);
    return conversation;
  }

  appendMessage(
    input: Omit<Message, "id" | "createdAt" | "status"> & {
      id?: string;
      createdAt?: string;
      status?: Message["status"];
    }
  ): Message {
    const message: Message = {
      id: input.id ?? id("msg"),
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      role: input.role,
      content: input.content,
      status: input.status ?? "completed",
      metadata: input.metadata ?? {},
      createdAt: input.createdAt ?? nowIso()
    };
    this.db
      .prepare(
        `INSERT INTO messages (
          id, project_id, conversation_id, run_id, role, content, status, metadata_json, created_at
        ) VALUES (
          @id, @projectId, @conversationId, @runId, @role, @content, @status, @metadataJson, @createdAt
        )`
      )
      .run({
        id: message.id,
        projectId: message.projectId,
        conversationId: message.conversationId ?? this.ensureDefaultConversation(message.projectId).id,
        runId: message.runId ?? null,
        role: message.role,
        content: message.content,
        status: message.status,
        metadataJson: JSON.stringify(message.metadata),
        createdAt: message.createdAt
      });
    if (!message.conversationId) message.conversationId = this.ensureDefaultConversation(message.projectId).id;
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(message.createdAt, message.conversationId);
    this.touchProject(message.projectId);
    return messageSchema.parse(message);
  }

  listMessages(projectId: string, conversationId?: string): Message[] {
    const rows = conversationId
      ? this.db
          .prepare("SELECT * FROM messages WHERE project_id = ? AND conversation_id = ? ORDER BY created_at ASC")
          .all(projectId, conversationId)
      : this.db.prepare("SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC").all(projectId);
    return rows.map((row) => this.messageFromRow(row as Row));
  }

  updateMessage(
    messageId: string,
    patch: Partial<Pick<Message, "content" | "status" | "metadata" | "runId">>
  ): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as Row | undefined;
    if (!row) throw new Error(`Message not found: ${messageId}`);
    const current = this.messageFromRow(row);
    const updated = messageSchema.parse({ ...current, ...patch });
    this.db
      .prepare("UPDATE messages SET content = ?, status = ?, metadata_json = ?, run_id = ? WHERE id = ?")
      .run(updated.content, updated.status, JSON.stringify(updated.metadata), updated.runId ?? null, messageId);
    return updated;
  }

  clearMessages(projectId: string, conversationId?: string): number {
    const result = conversationId
      ? this.db
          .prepare("DELETE FROM messages WHERE project_id = ? AND conversation_id = ?")
          .run(projectId, conversationId)
      : this.db.prepare("DELETE FROM messages WHERE project_id = ?").run(projectId);
    this.touchProject(projectId);
    return Number(result.changes);
  }

  saveChatRun(run: ChatRun): ChatRun {
    const parsed = chatRunSchema.parse(run);
    this.db
      .prepare(
        `INSERT INTO chat_runs (
          id, project_id, conversation_id, user_message_id, assistant_message_id, output_artifact_id,
          provider, model, mode, status, source_refs_json, included_message_count,
          omitted_message_count, trace_json, error, created_at, updated_at
        ) VALUES (
          @id, @projectId, @conversationId, @userMessageId, @assistantMessageId, @outputArtifactId,
          @provider, @model, @mode, @status, @sourceRefsJson, @includedMessageCount,
          @omittedMessageCount, @traceJson, @error, @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          assistant_message_id = excluded.assistant_message_id,
          output_artifact_id = excluded.output_artifact_id,
          provider = excluded.provider,
          model = excluded.model,
          mode = excluded.mode,
          status = excluded.status,
          source_refs_json = excluded.source_refs_json,
          included_message_count = excluded.included_message_count,
          omitted_message_count = excluded.omitted_message_count,
          trace_json = excluded.trace_json,
          error = excluded.error,
          updated_at = excluded.updated_at`
      )
      .run({
        id: parsed.id,
        projectId: parsed.projectId,
        conversationId: parsed.conversationId,
        userMessageId: parsed.userMessageId,
        assistantMessageId: parsed.assistantMessageId ?? null,
        outputArtifactId: parsed.outputArtifactId ?? null,
        provider: parsed.provider,
        model: parsed.model,
        mode: parsed.mode,
        status: parsed.status,
        sourceRefsJson: JSON.stringify(parsed.sourceRefs),
        includedMessageCount: parsed.includedMessageCount,
        omittedMessageCount: parsed.omittedMessageCount,
        traceJson: JSON.stringify(parsed.trace),
        error: parsed.error ?? null,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt
      });
    return parsed;
  }

  getChatRun(runId: string): ChatRun | undefined {
    const row = this.db.prepare("SELECT * FROM chat_runs WHERE id = ?").get(runId) as Row | undefined;
    return row ? this.chatRunFromRow(row) : undefined;
  }

  listChatRuns(conversationId: string): ChatRun[] {
    return (
      this.db
        .prepare("SELECT * FROM chat_runs WHERE conversation_id = ? ORDER BY created_at DESC")
        .all(conversationId) as Row[]
    ).map((row) => this.chatRunFromRow(row));
  }

  markInterruptedChatRuns(): number {
    const updatedAt = nowIso();
    const rows = this.db
      .prepare("SELECT id, assistant_message_id FROM chat_runs WHERE status IN ('queued', 'running')")
      .all() as Row[];
    for (const row of rows) {
      this.db
        .prepare("UPDATE chat_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .run("Interrupted because Paper Pilot restarted before the response completed.", updatedAt, String(row.id));
      this.db
        .prepare(
          "UPDATE tool_runs SET status = 'failed', error = ?, updated_at = ? WHERE run_id = ? AND status = 'running'"
        )
        .run("Interrupted by app restart.", updatedAt, String(row.id));
      if (row.assistant_message_id) {
        this.db
          .prepare(
            "UPDATE messages SET status = 'failed', content = CASE WHEN content = '' THEN ? ELSE content END WHERE id = ?"
          )
          .run("This response was interrupted when Paper Pilot restarted.", String(row.assistant_message_id));
      }
    }
    return rows.length;
  }

  createToolRun(projectId: string, runId: string, toolName: string, input: Record<string, unknown>): string {
    const toolRunId = id("tool");
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO tool_runs (
          id, project_id, run_id, tool_name, status, input_json, output_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, ?)`
      )
      .run(toolRunId, projectId, runId, toolName, JSON.stringify(input), timestamp, timestamp);
    return toolRunId;
  }

  finishToolRun(
    toolRunId: string,
    status: "completed" | "waiting" | "failed",
    output?: Record<string, unknown>,
    error?: string
  ): void {
    this.db
      .prepare("UPDATE tool_runs SET status = ?, output_json = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, output ? JSON.stringify(output) : null, error ?? null, nowIso(), toolRunId);
  }

  replaceCitations(runId: string, citations: Citation[]): Citation[] {
    this.db.prepare("DELETE FROM chat_citations WHERE run_id = ?").run(runId);
    const insert = this.db.prepare(
      `INSERT INTO chat_citations (
        id, run_id, message_id, evidence_id, source_type, paper_id, artifact_id, chunk_id,
        title, excerpt, page, locator, doi, url, retrieval_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const citation of citations.map((value) => citationSchema.parse(value))) {
      insert.run(
        citation.id,
        citation.runId,
        citation.messageId ?? null,
        citation.evidenceId,
        citation.sourceType,
        citation.paperId ?? null,
        citation.artifactId ?? null,
        citation.chunkId ?? null,
        citation.title,
        citation.excerpt,
        citation.page ?? null,
        citation.locator ?? null,
        citation.doi ?? null,
        citation.url ?? null,
        citation.retrievalScore ?? null
      );
    }
    return citations;
  }

  listCitations(runId: string): Citation[] {
    return (
      this.db.prepare("SELECT * FROM chat_citations WHERE run_id = ? ORDER BY evidence_id").all(runId) as Row[]
    ).map((row) => this.citationFromRow(row));
  }

  savePaper(projectId: string, paperInput: Paper): Paper {
    const paper = paperSchema.parse({ ...paperInput, projectId });
    const createdAt = nowIso();
    const paperId = paper.id || id("paper");
    const dedupeKey = paperIdentityDedupeKey({ ...paper, id: paperId });
    const normalizedTitle = normalizeBibliographicTitle(paper.title);
    const row = {
      id: paperId,
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

  getPaper(projectId: string, paperId: string): Paper | undefined {
    const row = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as
      Row | undefined;
    return row ? this.paperFromRow(row) : undefined;
  }

  listAllPapers(): Paper[] {
    return this.db
      .prepare(
        "SELECT * FROM papers ORDER BY score DESC NULLS LAST, citation_count DESC NULLS LAST, year DESC NULLS LAST"
      )
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
    const row = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as
      Row | undefined;
    if (!row) throw new Error(`Paper not found: ${paperId}`);
    this.touchProject(projectId);
    return this.paperFromRow(row);
  }

  updatePaper(projectId: string, paperId: string, patch: Partial<Paper>): Paper {
    const currentRow = this.db
      .prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?")
      .get(projectId, paperId) as Row | undefined;
    if (!currentRow) throw new Error(`Paper not found: ${paperId}`);
    const current = this.paperFromRow(currentRow);
    const next = paperSchema.parse({ ...current, ...patch, projectId, id: paperId });
    const dedupeKey = paperIdentityDedupeKey(next);
    const normalizedTitle = normalizeBibliographicTitle(next.title);
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
          source = @source,
          source_paper_id = @sourcePaperId,
          venue = @venue,
          citation_count = @citationCount,
          is_open_access = @isOpenAccess,
          license = @license,
          fields_json = @fieldsJson,
          favorite = @favorite,
          user_status = @userStatus,
          tags_json = @tagsJson,
          notes = @notes,
          raw_json = @rawJson,
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
        source: next.source,
        sourcePaperId: next.sourcePaperId ?? null,
        venue: next.venue ?? null,
        citationCount: next.citationCount ?? null,
        isOpenAccess: next.isOpenAccess ? 1 : 0,
        license: next.license ?? null,
        fieldsJson: JSON.stringify(next.fieldsOfStudy),
        favorite: next.favorite ? 1 : 0,
        userStatus: next.userStatus ?? "unread",
        tagsJson: JSON.stringify(next.tags ?? []),
        notes: next.notes ?? null,
        rawJson: JSON.stringify(next.raw ?? {}),
        updatedAt
      });
    const row = this.db.prepare("SELECT * FROM papers WHERE project_id = ? AND id = ?").get(projectId, paperId) as
      Row | undefined;
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

  updateArtifact(
    projectId: string,
    artifactId: string,
    patch: Partial<Pick<Artifact, "title" | "metadata">>
  ): Artifact {
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
      ? this.db
          .prepare(`DELETE FROM jobs WHERE project_id = ? AND status IN (${placeholders})`)
          .run(projectId, ...statuses)
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
      .prepare(
        "SELECT source_id as sourceId, label, updated_at as updatedAt FROM source_credentials ORDER BY source_id, label"
      )
      .all() as Array<{ sourceId: string; label: string; updatedAt: string }>;
  }

  deleteCredential(sourceId: string, label = "default"): boolean {
    const result = this.db
      .prepare("DELETE FROM source_credentials WHERE source_id = ? AND label = ?")
      .run(sourceId, label);
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
    const rows = this.db.prepare("SELECT id FROM document_chunks WHERE artifact_id = ?").all(artifactId) as Array<{
      id: string;
    }>;
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const embedding = this.db.prepare("SELECT vec_rowid FROM embeddings WHERE chunk_id = ?").get(row.id) as
          { vec_rowid?: number } | undefined;
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

  searchIndexedChunks(input: {
    query: string;
    projectId?: string;
    artifactId?: string;
    limit?: number;
  }): ChunkSearchRow[] {
    const ftsQuery = buildFtsQuery(input.query);
    if (!ftsQuery) return [];
    const clauses = ["document_chunks_fts MATCH @query"];
    if (input.projectId) clauses.push("document_chunks_fts.project_id = @projectId");
    if (input.artifactId) clauses.push("document_chunks_fts.artifact_id = @artifactId");
    const params: Record<string, string | number> = { query: ftsQuery, limit: input.limit ?? 20 };
    if (input.projectId) params.projectId = input.projectId;
    if (input.artifactId) params.artifactId = input.artifactId;
    try {
      const rows = this.db
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
        .all(params) as Row[];
      return rows.map((row) => this.chunkSearchFromRow(row));
    } catch {
      return [];
    }
  }

  listArtifactChunks(projectId: string, artifactId: string, limit = 2): ChunkSearchRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           document_chunks.id as chunkId,
           document_chunks.project_id as projectId,
           projects.title as projectTitle,
           document_chunks.artifact_id as artifactId,
           artifacts.title as artifactTitle,
           artifacts.type as artifactType,
           artifacts.created_at as artifactCreatedAt,
           document_chunks.paper_id as paperId,
           papers.title as paperTitle,
           document_chunks.text as text,
           document_chunks.metadata_json as metadataJson,
           substr(document_chunks.text, 1, 320) as snippet,
           document_chunks.ordinal as score
         FROM document_chunks
         JOIN artifacts ON artifacts.id = document_chunks.artifact_id
         JOIN projects ON projects.id = document_chunks.project_id
         LEFT JOIN papers ON papers.id = document_chunks.paper_id
         WHERE document_chunks.project_id = ? AND document_chunks.artifact_id = ?
         ORDER BY document_chunks.ordinal ASC
         LIMIT ?`
      )
      .all(projectId, artifactId, limit) as Row[];
    return rows.map((row) => this.chunkSearchFromRow(row));
  }

  searchChunks(
    projectId: string,
    query: string,
    limit = 12
  ): Array<{ text: string; artifactId: string; score: number }> {
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

  searchVectorChunks(
    projectId: string,
    query: string,
    limit = 12
  ): Array<{ text: string; artifactId: string; score: number }> {
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

  hybridSearchChunks(
    projectId: string,
    query: string,
    limit = 12
  ): Array<{ text: string; artifactId: string; score: number; mode: string }> {
    const vectorResults = this.searchVectorChunks(projectId, query, limit).map((result) => ({
      ...result,
      mode: "vector"
    }));
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

  private withTransaction<T>(operation: () => T): T {
    return this.transaction(operation);
  }

  private insertReviewCriteria(
    reviewId: string,
    revisionId: string,
    criteria: Array<{
      id?: string;
      stage: "title-abstract" | "full-text";
      type: "inclusion" | "exclusion";
      label: string;
      description?: string;
      order?: number;
    }>,
    createdAt: string
  ): void {
    const requestIds = new Set<string>();
    const stageOrders = new Set<string>();
    for (const [index, criterion] of criteria.entries()) {
      if (criterion.id) {
        if (requestIds.has(criterion.id)) throw new Error(`Duplicate review criterion request ID: ${criterion.id}`);
        requestIds.add(criterion.id);
      }
      const order = criterion.order ?? index;
      const stageOrder = `${criterion.stage}:${criterion.type}:${order}`;
      if (stageOrders.has(stageOrder)) {
        throw new Error(`Duplicate ${criterion.type} criterion order ${order} for stage ${criterion.stage}.`);
      }
      stageOrders.add(stageOrder);
    }
    const insert = this.db.prepare(
      `INSERT INTO review_criteria (
         id, review_id, protocol_revision_id, stage, kind, label, description, ordinal, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    criteria.forEach((criterion, index) => {
      const parsed = reviewCriterionSchema.parse({
        id: id("criterion"),
        stage: criterion.stage,
        type: criterion.type,
        label: criterion.label,
        description: criterion.description,
        order: criterion.order ?? index
      });
      insert.run(
        parsed.id,
        reviewId,
        revisionId,
        parsed.stage,
        parsed.type,
        parsed.label,
        parsed.description ?? null,
        parsed.order,
        createdAt
      );
    });
  }

  private insertReviewAuditEvent(input: {
    id?: string;
    reviewId: string;
    projectId: string;
    actor: "user" | "system" | "ai";
    action: string;
    entityType?: string;
    entityId?: string;
    payload?: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO review_audit_events (
           id, review_id, project_id, actor, action, entity_type, entity_id, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id ?? id("audit"),
        input.reviewId,
        input.projectId,
        input.actor,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        JSON.stringify(input.payload ?? {}),
        input.createdAt
      );
  }

  private reviewFromRow(row: Row): ReviewProtocol {
    return reviewProtocolSchema.parse({
      id: row.id,
      projectId: row.project_id,
      template: row.template,
      currentRevisionId: row.current_protocol_revision_id,
      currentRevisionNumber: Number(row.current_revision_number),
      historicalCountsAvailable: Boolean(row.historical_counts_available),
      activatedAt: row.activated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private reviewProtocolRevisionFromRow(row: Row): ReviewProtocolRevision {
    return reviewProtocolRevisionSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      version: Number(row.revision),
      researchQuestion: row.research_question,
      objectives: parseJson<string[]>(row.objectives_json, []),
      criteria: this.listReviewCriteria(String(row.review_id), String(row.id)),
      changeNote: row.note ?? undefined,
      createdAt: row.created_at
    });
  }

  private reviewCriterionFromRow(row: Row): ReviewCriterion {
    return reviewCriterionSchema.parse({
      id: row.id,
      stage: row.stage,
      type: row.kind,
      label: row.label,
      description: row.description ?? undefined,
      order: Number(row.ordinal)
    });
  }

  private discoveryBatchFromRow(row: Row): DiscoveryBatch {
    return discoveryBatchSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      kind: row.kind,
      label: row.label,
      sourceId: row.source ?? undefined,
      fileName: row.file_name ?? undefined,
      importFormat: row.import_format ?? undefined,
      status: row.status,
      counts: {
        identified: Number(row.identified_count ?? 0),
        filtered: Number(row.filtered_count ?? 0),
        invalid: Number(row.invalid_count ?? 0),
        duplicates: Number(row.duplicate_count ?? 0),
        merged: Number(row.merged_count ?? 0),
        newRecords: Number(row.new_records_count ?? 0)
      },
      historicalCountsAvailable: Boolean(row.historical_counts_available),
      createdAt: row.created_at,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined
    });
  }

  private reviewCandidateOriginFromRow(row: Row): ReviewCandidateOrigin {
    const paperSnapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
    return {
      id: String(row.id),
      reviewId: String(row.review_id),
      batchId: String(row.batch_id),
      paperId: optionalString(row.paper_id) ?? optionalString(paperSnapshot.id),
      matchedPaperId: optionalString(row.matched_paper_id),
      sourceRecordId: optionalString(row.source_record_id),
      resolution: row.resolution as ReviewCandidateOrigin["resolution"],
      paperSnapshot,
      recordSnapshot: parseJson<Record<string, unknown>>(row.record_snapshot_json, {}),
      createdAt: String(row.created_at)
    };
  }

  private screeningDecisionFromRow(row: Row): ScreeningDecision {
    const paperSnapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
    return screeningDecisionSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      paperId: row.paper_id ?? paperSnapshot.id,
      stage: row.stage,
      decision: row.decision,
      protocolRevisionId: row.protocol_revision_id,
      reasonCriterionId: row.reason_criterion_id ?? undefined,
      customReason: row.custom_reason ?? undefined,
      runItemId: row.run_item_id ?? undefined,
      previousDecisionId: row.supersedes_decision_id ?? undefined,
      createdAt: row.created_at
    });
  }

  private extractionFieldFromRow(row: Row): ExtractionField {
    return extractionFieldSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.field_type,
      options: parseJson<string[]>(row.options_json, []),
      order: Number(row.ordinal),
      revision: Number(row.revision),
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private extractionFieldFromRevisionRow(row: Row): ExtractionField {
    return extractionFieldSchema.parse({
      id: row.field_id,
      reviewId: row.review_id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.field_type,
      options: parseJson<string[]>(row.options_json, []),
      order: Number(row.ordinal),
      revision: Number(row.revision),
      active: Boolean(row.active),
      createdAt: row.recorded_at,
      updatedAt: row.recorded_at
    });
  }

  private extractionValueFromRow(row: Row): ExtractionValue {
    const snapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
    return extractionValueSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      paperId: row.paper_id ?? snapshot.id,
      fieldId: row.field_id,
      fieldRevision: Number(row.field_revision),
      value: parseJson<ExtractionValue["value"]>(row.value_json, null),
      status: row.status,
      origin: row.provenance,
      evidenceIds: this.listEvidenceIdsForValue(String(row.id)),
      runItemId: row.run_item_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      confirmedAt: row.confirmed_at ?? undefined
    });
  }

  private extractionValueHistoryFromRow(row: Row): ExtractionValueHistoryEntry {
    const paperSnapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
    return {
      ...extractionValueSchema.parse({
        id: row.value_id,
        reviewId: row.review_id,
        paperId: row.paper_id ?? paperSnapshot.id,
        fieldId: row.field_id,
        fieldRevision: Number(row.field_revision),
        value: parseJson<ExtractionValue["value"]>(row.value_json, null),
        status: row.status,
        origin: row.provenance,
        evidenceIds: parseJson<string[]>(row.evidence_ids_json, []),
        runItemId: row.run_item_id ?? undefined,
        createdAt: row.recorded_at,
        updatedAt: row.recorded_at,
        confirmedAt: row.confirmed_at ?? undefined
      }),
      changeRevision: Number(row.change_revision),
      paperSnapshot,
      recordedAt: String(row.recorded_at)
    };
  }

  private listEvidenceIdsForValue(valueId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT evidence.id
           FROM review_extraction_value_evidence link
           JOIN review_evidence evidence ON evidence.id = link.evidence_id
           WHERE link.value_id = ? ORDER BY evidence.created_at, evidence.id`
        )
        .all(valueId) as Row[]
    ).map((row) => String(row.id));
  }

  private reviewEvidenceFromRow(row: Row): ReviewEvidence {
    return reviewEvidenceSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      evidenceId: row.evidence_id,
      runId: row.run_id ?? undefined,
      runItemId: row.run_item_id ?? undefined,
      paperId: row.paper_id ?? undefined,
      artifactId: row.artifact_id ?? undefined,
      chunkId: row.chunk_id ?? undefined,
      sourceType: row.source_type,
      title: row.title,
      excerpt: row.excerpt,
      locator: row.locator ?? undefined,
      page: row.page == null ? undefined : Number(row.page),
      doi: row.doi ?? undefined,
      url: row.url ?? undefined,
      retrievalScore: row.retrieval_score == null ? undefined : Number(row.retrieval_score),
      createdAt: row.created_at
    });
  }

  private reviewRunFromRow(row: Row): ReviewRun {
    return reviewRunSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      stage: row.stage,
      provider: row.provider,
      model: row.model,
      protocolRevisionId: row.protocol_revision_id,
      status: row.status,
      paperIds: parseJson<string[]>(row.selected_paper_ids_json, []),
      fieldIds: parseJson<string[]>(row.extraction_field_ids_json, []),
      completedCount: Number(row.completed_items ?? 0),
      failedCount: Number(row.failed_items ?? 0),
      cancelledCount: Number(row.cancelled_items ?? 0),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    });
  }

  private reviewRunItemFromRow(row: Row): ReviewRunItem {
    const snapshot = parseJson<Record<string, unknown>>(row.paper_snapshot_json, {});
    const recommendation = parseJson<Record<string, unknown>>(row.recommendation_json, {});
    return reviewRunItemSchema.parse({
      id: row.id,
      runId: row.run_id,
      paperId: row.paper_id ?? snapshot.id,
      status: row.status,
      attemptCount: Number(row.attempts ?? 0),
      suggestedDecision: recommendation.suggestedDecision,
      suggestedReasonCriterionId: recommendation.suggestedReasonCriterionId,
      suggestedCustomReason: recommendation.suggestedCustomReason,
      rationale: recommendation.rationale,
      criterionAssessments: recommendation.criterionAssessments ?? [],
      extractionSuggestions: recommendation.extractionSuggestions ?? [],
      evidence: this.listReviewEvidence(String(row.review_id), { runItemId: String(row.id) }),
      stale: Boolean(row.stale),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    });
  }

  private reviewAuditEventFromRow(row: Row): ReviewAuditEvent {
    return reviewAuditEventSchema.parse({
      id: row.id,
      reviewId: row.review_id,
      kind: row.action,
      actor: row.actor,
      entityType: row.entity_type ?? undefined,
      entityId: row.entity_id ?? undefined,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
      createdAt: row.created_at
    });
  }

  private currentScreeningDecisionRows(reviewId: string): ScreeningDecision[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM (
           SELECT d.*, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(d.paper_id, json_extract(d.paper_snapshot_json, '$.id')), d.stage
             ORDER BY d.created_at DESC, d.rowid DESC
           ) AS decision_rank
           FROM review_screening_decisions d WHERE d.review_id = ?
         ) WHERE decision_rank = 1`
        )
        .all(reviewId) as Row[]
    ).map((row) => this.screeningDecisionFromRow(row));
  }

  private reviewPaperSnapshot(value: unknown): Record<string, unknown> | undefined {
    const snapshot =
      typeof value === "string"
        ? parseJson<Record<string, unknown>>(value, {})
        : value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
    return Object.keys(snapshot).length ? { ...snapshot } : undefined;
  }

  private reviewPaperIdentity(paperId: unknown, snapshotJson: unknown): string | undefined {
    return optionalString(paperId) ?? optionalString(this.reviewPaperSnapshot(snapshotJson)?.id);
  }

  private isTrustedReviewArtifactChunk(
    projectId: string,
    artifactId: string,
    chunkId: string,
    paperId: string
  ): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1
           FROM document_chunks chunk
           JOIN artifacts artifact ON artifact.id = chunk.artifact_id AND artifact.project_id = chunk.project_id
           WHERE chunk.project_id = ? AND chunk.artifact_id = ? AND chunk.id = ?
             AND chunk.paper_id = ?
             AND length(trim(chunk.text)) > 0
             AND artifact.type IN ('paper-pdf', 'markdown', 'table')
             AND COALESCE(artifact.source, '') != 'research-chat'
             AND json_extract(artifact.metadata_json, '$.paperId') = ?
           LIMIT 1`
        )
        .get(projectId, artifactId, chunkId, paperId, paperId)
    );
  }

  private hasOpenFullTextRereviewFlag(reviewId: string, paperId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM review_rereview_flags
           WHERE review_id = ? AND stage = 'full-text' AND resolved_at IS NULL
             AND invalidates_downstream = 1
             AND COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) = ?
           LIMIT 1`
        )
        .get(reviewId, paperId)
    );
  }

  private isPaperEligibleForExtraction(reviewId: string, paperId: string): boolean {
    return (
      this.getCurrentScreeningDecision(reviewId, paperId, "title-abstract")?.decision === "include" &&
      this.getCurrentScreeningDecision(reviewId, paperId, "full-text")?.decision === "include" &&
      !this.hasOpenFullTextRereviewFlag(reviewId, paperId)
    );
  }

  private invalidateDownstreamReviewState(
    reviewId: string,
    paperId: string,
    paperSnapshot: Paper,
    createdAt: string
  ): void {
    const review = this.getReviewById(reviewId)!;
    const fullTextDecision = this.getCurrentScreeningDecision(reviewId, paperId, "full-text");
    if (fullTextDecision && !this.hasOpenFullTextRereviewFlag(reviewId, paperId)) {
      this.db
        .prepare(
          `INSERT INTO review_rereview_flags (
             id, review_id, paper_id, paper_snapshot_json, stage, protocol_revision_id,
             invalidates_downstream, created_at
           ) VALUES (?, ?, ?, ?, 'full-text', ?, 1, ?)`
        )
        .run(id("rereview"), reviewId, paperId, JSON.stringify(paperSnapshot), review.currentRevisionId, createdAt);
      this.insertReviewAuditEvent({
        reviewId,
        projectId: review.projectId,
        actor: "system",
        action: "decision-marked-for-review",
        entityType: "screening-decision",
        entityId: fullTextDecision.id,
        payload: { paperId, stage: "full-text", cause: "title-abstract-no-longer-included" },
        createdAt
      });
    }
    this.db
      .prepare(
        `UPDATE review_run_items
         SET stale = 1, updated_at = ?
         WHERE review_id = ?
           AND COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) = ?
           AND EXISTS (
             SELECT 1 FROM review_runs run
             WHERE run.id = review_run_items.run_id AND run.stage IN ('full-text', 'extraction')
           )`
      )
      .run(createdAt, reviewId, paperId);
    this.markExtractionValuesNeedsReview(
      "review_id = ? AND COALESCE(paper_id, json_extract(paper_snapshot_json, '$.id')) = ?",
      [reviewId, paperId],
      createdAt
    );
  }

  private markExtractionValuesNeedsReview(
    condition: string,
    parameters: Array<string | number>,
    updatedAt: string,
    fieldRevision?: number
  ): void {
    const rows = this.db.prepare(`SELECT * FROM extraction_values WHERE ${condition}`).all(...parameters) as Row[];
    for (const row of rows) {
      if (String(row.status) === "rejected") continue;
      const nextFieldRevision = fieldRevision ?? Number(row.field_revision);
      if (String(row.status) !== "needs-review" || Number(row.field_revision) !== nextFieldRevision) {
        this.db
          .prepare(
            `UPDATE extraction_values
             SET status = 'needs-review', field_revision = ?, confirmed_at = NULL, updated_at = ?
             WHERE id = ?`
          )
          .run(nextFieldRevision, updatedAt, String(row.id));
        this.recordExtractionValueRevision(String(row.id), updatedAt);
      }
    }
  }

  private recordExtractionFieldRevision(field: ExtractionField, recordedAt: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO extraction_field_revisions (
           field_id, review_id, revision, name, description, field_type, options_json,
           ordinal, active, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        field.id,
        field.reviewId,
        field.revision,
        field.name,
        field.description ?? null,
        field.type,
        JSON.stringify(field.options),
        field.order,
        field.active ? 1 : 0,
        recordedAt
      );
  }

  private recordExtractionValueRevision(valueId: string, recordedAt: string): void {
    const row = this.db.prepare("SELECT * FROM extraction_values WHERE id = ?").get(valueId) as Row | undefined;
    if (!row) return;
    const evidenceIds = this.listEvidenceIdsForValue(valueId);
    const latest = this.db
      .prepare(
        `SELECT * FROM extraction_value_revisions
         WHERE value_id = ? ORDER BY change_revision DESC LIMIT 1`
      )
      .get(valueId) as Row | undefined;
    if (
      latest &&
      Number(latest.field_revision) === Number(row.field_revision) &&
      String(latest.value_json ?? "null") === String(row.value_json ?? "null") &&
      String(latest.status) === String(row.status) &&
      String(latest.provenance) === String(row.provenance) &&
      optionalString(latest.run_item_id) === optionalString(row.run_item_id) &&
      optionalString(latest.confirmed_at) === optionalString(row.confirmed_at) &&
      JSON.stringify(parseJson<string[]>(latest.evidence_ids_json, [])) === JSON.stringify(evidenceIds)
    ) {
      return;
    }
    const changeRevision = latest ? Number(latest.change_revision) + 1 : 1;
    this.db
      .prepare(
        `INSERT INTO extraction_value_revisions (
           value_id, change_revision, review_id, field_id, field_revision, paper_id,
           paper_snapshot_json, run_item_id, value_json, status, provenance,
           evidence_ids_json, confirmed_at, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        valueId,
        changeRevision,
        String(row.review_id),
        String(row.field_id),
        Number(row.field_revision),
        optionalString(row.paper_id) ?? null,
        String(row.paper_snapshot_json),
        optionalString(row.run_item_id) ?? null,
        row.value_json == null ? null : String(row.value_json),
        String(row.status),
        String(row.provenance),
        JSON.stringify(evidenceIds),
        optionalString(row.confirmed_at) ?? null,
        recordedAt
      );
  }

  private assertExtractionValueMatchesField(
    field: ExtractionField,
    value: ExtractionValue["value"],
    status: ExtractionValue["status"]
  ): void {
    if (status === "not-found") {
      if (value !== null) throw new Error("Not-found extraction values must be null.");
      return;
    }
    if (status === "confirmed" && isBlankExtractionValue(value)) {
      throw new Error("Confirmed extraction values cannot be blank. Use Not found instead.");
    }
    if (value === null) return;
    const invalid = () => new Error(`Extraction value does not match ${field.type} field ${field.name}.`);
    if ((field.type === "short-text" || field.type === "long-text") && typeof value !== "string") throw invalid();
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw invalid();
    if (field.type === "boolean" && typeof value !== "boolean") throw invalid();
    if (field.type === "single-select") {
      if (typeof value !== "string" || !field.options.includes(value)) throw invalid();
    }
    if (field.type === "multi-select") {
      if (!Array.isArray(value) || value.some((entry) => !field.options.includes(entry))) throw invalid();
    }
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
    const row = this.db
      .prepare("SELECT vec_rowid FROM embeddings WHERE chunk_id = ? AND model = ?")
      .get(chunkId, "local-hash-384") as { vec_rowid?: number } | undefined;
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
    if (!wrapTransaction || this.transactionDepth > 0) {
      run();
      return;
    }
    this.transaction(run);
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

  private conversationFromRow(row: Row): Conversation {
    return conversationSchema.parse({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      mode: row.mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private messageFromRow(row: Row): Message {
    return messageSchema.parse({
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id ?? undefined,
      runId: row.run_id ?? undefined,
      role: row.role,
      content: row.content,
      status: row.status ?? "completed",
      metadata: JSON.parse(String(row.metadata_json)),
      createdAt: row.created_at
    });
  }

  private chatRunFromRow(row: Row): ChatRun {
    return chatRunSchema.parse({
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      assistantMessageId: row.assistant_message_id ?? undefined,
      outputArtifactId: row.output_artifact_id ?? undefined,
      provider: row.provider,
      model: row.model,
      mode: row.mode,
      status: row.status,
      sourceRefs: JSON.parse(String(row.source_refs_json)),
      includedMessageCount: Number(row.included_message_count ?? 0),
      omittedMessageCount: Number(row.omitted_message_count ?? 0),
      trace: JSON.parse(String(row.trace_json)),
      error: row.error ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private citationFromRow(row: Row): Citation {
    return citationSchema.parse({
      id: row.id,
      runId: row.run_id,
      messageId: row.message_id ?? undefined,
      evidenceId: row.evidence_id,
      sourceType: row.source_type,
      paperId: row.paper_id ?? undefined,
      artifactId: row.artifact_id ?? undefined,
      chunkId: row.chunk_id ?? undefined,
      title: row.title,
      excerpt: row.excerpt,
      page: row.page === null || row.page === undefined ? undefined : Number(row.page),
      locator: row.locator ?? undefined,
      doi: row.doi ?? undefined,
      url: row.url ?? undefined,
      retrievalScore:
        row.retrieval_score === null || row.retrieval_score === undefined ? undefined : Number(row.retrieval_score)
    });
  }

  private chunkSearchFromRow(row: Row): ChunkSearchRow {
    return {
      chunkId: String(row.chunkId),
      projectId: String(row.projectId),
      projectTitle: String(row.projectTitle),
      artifactId: String(row.artifactId),
      artifactTitle: String(row.artifactTitle),
      artifactType: artifactTypeSchema.parse(row.artifactType),
      artifactCreatedAt: String(row.artifactCreatedAt),
      paperId: optionalString(row.paperId),
      paperTitle: optionalString(row.paperTitle),
      text: String(row.text),
      metadataJson: String(row.metadataJson),
      snippet: String(row.snippet),
      score: Number(row.score)
    };
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function paperIdentityDedupeKey(paper: PaperIdentityInput & { id: string }): string {
  const forcedIdentity = paper.raw?.forceSeparateIdentity;
  if (typeof forcedIdentity === "string" && forcedIdentity.trim()) return `record:${forcedIdentity.trim()}`;
  return (
    doiIdentityKey(paper) ??
    sourceIdentifierIdentityKey(paper) ??
    bibliographicFingerprint(paper) ??
    `record:${paper.id}`
  );
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptional(value) : undefined;
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
