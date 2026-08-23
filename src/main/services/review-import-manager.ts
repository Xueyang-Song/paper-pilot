import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import {
  MAX_REFERENCE_IMPORT_BYTES,
  MAX_REFERENCE_IMPORT_RECORDS,
  type DiscoveryBatchCounts,
  type Paper,
  type ReferenceImportCommitRequest,
  type ReferenceImportCommitResponse,
  type ReferenceImportFormat,
  type ReferenceImportMapping,
  type ReferenceImportMatch,
  type ReferenceImportPreview,
  type ReferenceImportPreviewItem
} from "../../shared/schemas.js";
import type { PaperPilotDb, ReviewCandidateOriginInput } from "../db.js";
import { id, sha256 } from "../utils.js";
import { mergeAuthoritativeSourceIdentifiers, PaperIdentityResolver, resolvePaperIdentity } from "./paper-identity.js";
import {
  ReferenceImportService,
  type AppliedCsvColumnMapping,
  type ReferenceImportPaper,
  type ReferenceImportRecord
} from "./reference-import-service.js";

interface ImportSession {
  id: string;
  projectId: string;
  reviewId: string;
  filePath: string;
  fileName: string;
  content: Buffer;
  hash: string;
  format: ReferenceImportFormat;
  createdAt: number;
}

const IMPORT_WRITE_BATCH_SIZE = 500;

export class ReviewImportManager {
  private readonly sessions = new Map<string, ImportSession>();

  constructor(
    private readonly db: PaperPilotDb,
    private readonly parser = new ReferenceImportService(),
    private readonly sessionLifetimeMs = 30 * 60 * 1000
  ) {}

  async preview(input: {
    projectId: string;
    reviewId: string;
    filePath: string;
    format?: ReferenceImportFormat;
    mapping?: ReferenceImportMapping;
  }): Promise<ReferenceImportPreview> {
    this.assertReview(input.projectId, input.reviewId);
    const info = await stat(input.filePath);
    if (!info.isFile()) throw new Error("The selected reference import is not a file.");
    if (info.size > MAX_REFERENCE_IMPORT_BYTES) throw new Error("Reference files may not exceed 50 MiB.");
    const content = await readFile(input.filePath);
    const parsed = this.parser.preview({
      content,
      fileName: basename(input.filePath),
      format: input.format,
      csvMapping: toParserMapping(input.mapping)
    });
    if (parsed.format === "unknown") throw new Error(parsed.fileErrors[0] ?? "Unsupported reference import format.");
    if (parsed.totalRecords > MAX_REFERENCE_IMPORT_RECORDS) {
      throw new Error(parsed.fileErrors[0] ?? "Reference files may contain at most 50,000 records.");
    }
    const previewId = id("import_preview");
    const session: ImportSession = {
      id: previewId,
      projectId: input.projectId,
      reviewId: input.reviewId,
      filePath: input.filePath,
      fileName: basename(input.filePath),
      content,
      hash: sha256(content),
      format: parsed.format,
      createdAt: Date.now()
    };
    this.pruneSessions();
    this.sessions.set(previewId, session);
    return this.toSharedPreview(session, parsed);
  }

  async remap(previewId: string, mapping: ReferenceImportMapping): Promise<ReferenceImportPreview> {
    const session = this.requireSession(previewId);
    const parsed = this.parser.preview({
      content: session.content,
      fileName: session.fileName,
      format: session.format,
      csvMapping: toParserMapping(mapping)
    });
    if (parsed.totalRecords > MAX_REFERENCE_IMPORT_RECORDS) {
      throw new Error(parsed.fileErrors[0] ?? "Reference files may contain at most 50,000 records.");
    }
    return this.toSharedPreview(session, parsed);
  }

  async commit(input: ReferenceImportCommitRequest): Promise<ReferenceImportCommitResponse> {
    const session = this.requireSession(input.previewId);
    if (session.projectId !== input.projectId || session.reviewId !== input.reviewId) {
      throw new Error("The reference import preview belongs to a different project or review.");
    }
    this.assertReview(input.projectId, input.reviewId);
    const currentContent = await readFile(session.filePath);
    if (sha256(currentContent) !== session.hash) {
      throw new Error("The reference file changed after preview. Preview it again before importing.");
    }
    const parsed = this.parser.preview({
      content: currentContent,
      fileName: session.fileName,
      format: session.format,
      csvMapping: toParserMapping(input.mapping)
    });
    if (!parsed.canCommit) throw new Error(parsed.fileErrors[0] ?? "The reference import cannot be committed.");

    const result = this.db.transaction(() => {
      const counts: DiscoveryBatchCounts = {
        identified: parsed.totalRecords,
        filtered: 0,
        invalid: parsed.invalidRecords.length,
        duplicates: 0,
        merged: 0,
        newRecords: 0
      };
      let batch = this.db.saveDiscoveryBatch({
        reviewId: input.reviewId,
        kind: "reference-import",
        label: `Reference import — ${session.fileName}`,
        fileName: session.fileName,
        importFormat: session.format,
        status: "running",
        counts,
        historicalCountsAvailable: true,
        config: { mapping: input.mapping ?? null }
      });
      const resolutions = new Map(input.resolutions.map((resolution) => [resolution.recordIndex, resolution]));
      const existing = this.db.listPapers(input.projectId);
      const resolver = new PaperIdentityResolver(existing);
      const previewTargets = new Map<string, string>();
      let pendingOrigins: ReviewCandidateOriginInput[] = [];
      const flushOrigins = (): void => {
        if (!pendingOrigins.length) return;
        this.db.recordReviewCandidateOriginsBulk(pendingOrigins);
        pendingOrigins = [];
      };
      const queueOrigin = (origin: ReviewCandidateOriginInput): void => {
        pendingOrigins.push(origin);
        if (pendingOrigins.length >= IMPORT_WRITE_BATCH_SIZE) flushOrigins();
      };

      for (const invalid of parsed.invalidRecords) {
        queueOrigin({
          reviewId: input.reviewId,
          batchId: batch.id,
          sourceRecordId: String(invalid.recordNumber),
          resolution: "invalid",
          recordSnapshot: { raw: invalid.raw, errors: invalid.errors }
        });
      }

      for (const record of parsed.records) {
        const recordIndex = record.recordNumber - 1;
        const match = resolver.resolve(record.paper);
        const requested = resolutions.get(recordIndex);
        if (match.kind === "ambiguous" && !requested) {
          throw new Error(`Imported record ${record.recordNumber} requires an explicit ambiguous-match resolution.`);
        }
        if (requested?.action === "skip") {
          counts.filtered += 1;
          queueOrigin({
            reviewId: input.reviewId,
            batchId: batch.id,
            sourceRecordId: record.provenance.sourceIdentifier ?? String(record.recordNumber),
            resolution: "skipped",
            recordSnapshot: record
          });
          continue;
        }

        if (requested?.action === "merge") {
          const targetId = requested.paperId ? (previewTargets.get(requested.paperId) ?? requested.paperId) : undefined;
          const target = targetId ? resolver.list().find((candidate) => candidate.id === targetId) : undefined;
          const targetMatches =
            target &&
            (match.kind === "exact"
              ? match.candidate.id === target.id
              : match.kind === "ambiguous" && match.candidates.some((candidate) => candidate.id === target.id));
          if (!targetMatches) {
            throw new Error(`Invalid merge target for imported record ${record.recordNumber}.`);
          }
          const merged = this.mergeIntoPaper(input.projectId, target, record.paper);
          resolver.replace(target, merged);
          counts.merged += 1;
          queueOrigin({
            reviewId: input.reviewId,
            batchId: batch.id,
            paperId: merged.id,
            matchedPaperId: target.id,
            sourceRecordId: record.provenance.sourceIdentifier ?? String(record.recordNumber),
            resolution: "merged",
            paperSnapshot: merged,
            recordSnapshot: record
          });
          previewTargets.set(previewPaperId(record.recordNumber), merged.id);
          continue;
        }

        if (match.kind === "exact") {
          const enriched = wouldEnrich(match.candidate, record.paper);
          const paper = enriched
            ? this.mergeIntoPaper(input.projectId, match.candidate, record.paper)
            : match.candidate;
          if (enriched) resolver.replace(match.candidate, paper);
          if (enriched) counts.merged += 1;
          else counts.duplicates += 1;
          queueOrigin({
            reviewId: input.reviewId,
            batchId: batch.id,
            paperId: paper.id,
            matchedPaperId: match.candidate.id,
            sourceRecordId: record.provenance.sourceIdentifier ?? String(record.recordNumber),
            resolution: enriched ? "merged" : "duplicate",
            paperSnapshot: paper,
            recordSnapshot: record
          });
          previewTargets.set(previewPaperId(record.recordNumber), paper.id);
          continue;
        }

        const created = this.createPaper(input.projectId, record, match.kind === "ambiguous");
        resolver.add(created);
        counts.newRecords += 1;
        queueOrigin({
          reviewId: input.reviewId,
          batchId: batch.id,
          paperId: created.id,
          matchedPaperId: match.kind === "ambiguous" ? match.candidates[0]?.id : undefined,
          sourceRecordId: record.provenance.sourceIdentifier ?? String(record.recordNumber),
          resolution: match.kind === "ambiguous" ? "kept-separate" : "created",
          paperSnapshot: created,
          recordSnapshot: record
        });
        previewTargets.set(previewPaperId(record.recordNumber), created.id);
      }
      flushOrigins();

      batch = this.db.saveDiscoveryBatch({
        ...batch,
        kind: "reference-import",
        status: "completed",
        counts,
        completedAt: new Date().toISOString()
      });
      this.db.appendReviewAuditEvent({
        reviewId: input.reviewId,
        kind: "import-committed",
        actor: "user",
        entityType: "discovery-batch",
        entityId: batch.id,
        payload: { fileName: session.fileName, format: session.format, counts }
      });
      return { batch, counts };
    });
    this.sessions.delete(session.id);
    return result;
  }

  private toSharedPreview(
    session: ImportSession,
    parsed: ReturnType<ReferenceImportService["preview"]>
  ): ReferenceImportPreview {
    const existing = this.db.listPapers(session.projectId);
    const resolver = new PaperIdentityResolver(existing);
    const validItems: ReferenceImportPreviewItem[] = parsed.records.map((record) => {
      const match = resolver.resolve(record.paper);
      if (match.kind === "none") {
        resolver.add({
          ...record.paper,
          id: previewPaperId(record.recordNumber)
        });
      } else if (match.kind === "exact" && wouldEnrich(match.candidate, record.paper)) {
        resolver.replace(match.candidate, {
          ...match.candidate,
          ...mergePaperMetadata(match.candidate, record.paper)
        });
      }
      return {
        recordIndex: record.recordNumber - 1,
        record: toSharedRecord(record.paper),
        rawTitle: record.paper.title,
        valid: true,
        errors: [],
        match: toSharedMatch(match)
      };
    });
    const invalidItems: ReferenceImportPreviewItem[] = parsed.invalidRecords.map((record) => ({
      recordIndex: Math.max(0, record.recordNumber - 1),
      rawTitle: rawTitle(record.raw),
      valid: false,
      errors: record.errors,
      match: { kind: "none", candidatePaperIds: [] }
    }));
    return {
      previewId: session.id,
      projectId: session.projectId,
      reviewId: session.reviewId,
      fileName: session.fileName,
      format: session.format,
      sizeBytes: parsed.sizeBytes,
      totalRecords: parsed.totalRecords,
      validRecords: parsed.records.length,
      invalidRecords: parsed.invalidRecords.length,
      columns: parsed.csv?.headers ?? [],
      suggestedMapping: fromParserMapping(parsed.csv?.suggestedMapping),
      items: [...validItems, ...invalidItems].sort((left, right) => left.recordIndex - right.recordIndex),
      warnings: [...parsed.warnings, ...parsed.fileErrors]
    };
  }

  private createPaper(projectId: string, record: ReferenceImportRecord, keptSeparate: boolean): Paper {
    const paperId = id("paper");
    return this.db.savePaper(projectId, {
      ...record.paper,
      id: paperId,
      raw: {
        ...(record.paper.raw ?? {}),
        referenceImport: record.provenance,
        sourceAuthority: record.paper.sourceAuthority,
        forceSeparateIdentity: keptSeparate ? paperId : undefined
      }
    });
  }

  private mergeIntoPaper(projectId: string, current: Paper, incoming: ReferenceImportPaper): Paper {
    return this.db.updatePaper(projectId, current.id, mergePaperMetadata(current, incoming));
  }

  private assertReview(projectId: string, reviewId: string): void {
    const review = this.db.getReviewById(reviewId);
    if (!review || review.projectId !== projectId) throw new Error("Review not found in the selected project.");
  }

  private requireSession(previewId: string): ImportSession {
    this.pruneSessions();
    const session = this.sessions.get(previewId);
    if (!session) throw new Error("The reference import preview expired. Preview the file again.");
    return session;
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - this.sessionLifetimeMs;
    for (const [sessionId, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(sessionId);
    }
  }
}

function toSharedRecord(paper: ReferenceImportPaper) {
  return {
    title: paper.title,
    authors: paper.authors,
    abstract: paper.abstract,
    year: paper.year,
    doi: paper.doi,
    url: paper.url,
    pdfUrl: paper.pdfUrl,
    venue: paper.venue,
    sourceId: paper.sourcePaperId,
    sourceAuthority: paper.sourceAuthority,
    citationCount: paper.citationCount
  };
}

function toSharedMatch(match: ReturnType<typeof resolvePaperIdentity>): ReferenceImportMatch {
  if (match.kind === "none") return { kind: "none", candidatePaperIds: [] };
  if (match.kind === "exact") {
    return {
      kind: "exact",
      matchedBy:
        match.strategy === "source-identifier"
          ? "source-id"
          : match.strategy === "bibliographic-fingerprint"
            ? "fingerprint"
            : "doi",
      paperId: match.candidate.id,
      candidatePaperIds: []
    };
  }
  return {
    kind: "ambiguous",
    matchedBy:
      match.strategy === "source-identifier"
        ? "source-id"
        : match.strategy === "bibliographic-fingerprint"
          ? "fingerprint"
          : match.strategy === "doi"
            ? "doi"
            : undefined,
    candidatePaperIds: match.candidates.flatMap((candidate) => (candidate.id ? [candidate.id] : []))
  };
}

function previewPaperId(recordNumber: number): string {
  return `preview-paper:${recordNumber}`;
}

function mergePaperMetadata(current: Paper, incoming: ReferenceImportPaper): Partial<Paper> {
  const identity = mergeAuthoritativeSourceIdentifiers(current, incoming);
  return {
    abstract: current.abstract || incoming.abstract,
    authors: current.authors.length ? current.authors : incoming.authors,
    year: current.year ?? incoming.year,
    publishedAt: current.publishedAt,
    doi: current.doi ?? incoming.doi,
    url: current.url ?? incoming.url,
    pdfUrl: current.pdfUrl ?? incoming.pdfUrl,
    venue: current.venue ?? incoming.venue,
    citationCount: Math.max(current.citationCount ?? 0, incoming.citationCount ?? 0) || undefined,
    isOpenAccess: current.isOpenAccess || incoming.isOpenAccess,
    sourcePaperId: identity.sourcePaperId,
    raw: identity.raw
  };
}

function wouldEnrich(current: Paper, incoming: ReferenceImportPaper): boolean {
  const patch = mergePaperMetadata(current, incoming);
  return (
    (!current.abstract && Boolean(patch.abstract)) ||
    (!current.authors.length && Boolean(patch.authors?.length)) ||
    (current.year === undefined && patch.year !== undefined) ||
    (!current.doi && Boolean(patch.doi)) ||
    (!current.url && Boolean(patch.url)) ||
    (!current.pdfUrl && Boolean(patch.pdfUrl)) ||
    (!current.venue && Boolean(patch.venue)) ||
    (patch.citationCount ?? 0) > (current.citationCount ?? 0) ||
    patch.sourcePaperId !== current.sourcePaperId ||
    JSON.stringify(patch.raw ?? {}) !== JSON.stringify(current.raw ?? {})
  );
}

function toParserMapping(mapping: ReferenceImportMapping | undefined): AppliedCsvColumnMapping | undefined {
  if (!mapping) return undefined;
  return {
    title: mapping.title,
    authors: mapping.authors,
    abstract: mapping.abstract,
    year: mapping.year,
    doi: mapping.doi,
    url: mapping.url,
    pdfUrl: mapping.pdfUrl,
    venue: mapping.venue,
    sourcePaperId: mapping.sourceId,
    sourceAuthority: mapping.sourceAuthority,
    citationCount: mapping.citationCount
  };
}

function fromParserMapping(mapping: AppliedCsvColumnMapping | undefined): Partial<ReferenceImportMapping> | undefined {
  if (!mapping) return undefined;
  return {
    title: mapping.title,
    authors: mapping.authors,
    abstract: mapping.abstract,
    year: mapping.year,
    doi: mapping.doi,
    url: mapping.url,
    pdfUrl: mapping.pdfUrl,
    venue: mapping.venue,
    sourceId: mapping.sourcePaperId,
    sourceAuthority: mapping.sourceAuthority,
    citationCount: mapping.citationCount
  };
}

function rawTitle(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = (raw as Record<string, unknown>).title;
  return typeof candidate === "string" ? candidate : undefined;
}
