import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb, type ReviewPortabilityState } from "../src/main/db";

let dir: string;
const openDatabases: PaperPilotDb[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-review-db-"));
});

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await rm(dir, { recursive: true, force: true });
});

function open(name = "review.db"): PaperPilotDb {
  const database = new PaperPilotDb(join(dir, name));
  openDatabases.push(database);
  return database;
}

function addPaper(database: PaperPilotDb, projectId: string, paperId: string, title = paperId) {
  return database.savePaper(projectId, {
    id: paperId,
    title,
    abstract: `${title} abstract`,
    authors: ["Ada Researcher"],
    year: 2025,
    source: "crossref",
    isOpenAccess: false,
    fieldsOfStudy: []
  });
}

function includeThroughFullText(database: PaperPilotDb, reviewId: string, paperId: string): void {
  database.setScreeningDecision({
    reviewId,
    paperId,
    stage: "title-abstract",
    decision: "include"
  });
  database.setScreeningDecision({ reviewId, paperId, stage: "full-text", decision: "include" });
}

function addIndexedArtifact(
  database: PaperPilotDb,
  input: {
    projectId: string;
    artifactId: string;
    artifactType: "paper-pdf" | "markdown" | "table" | "brief" | "chat-answer";
    paperId: string;
    metadataPaperId?: string;
    chunkPaperId?: string;
    source?: string;
  }
): { artifactId: string; chunkId: string } {
  const createdAt = new Date().toISOString();
  database.saveArtifact({
    id: input.artifactId,
    projectId: input.projectId,
    type: input.artifactType,
    title: input.artifactId,
    path: join(dir, `${input.artifactId}.md`),
    mime: "text/markdown",
    hash: `hash-${input.artifactId}`,
    source: input.source,
    metadata: { paperId: input.metadataPaperId ?? input.paperId },
    createdAt
  });
  database.addDocumentChunks({
    projectId: input.projectId,
    artifactId: input.artifactId,
    paperId: input.chunkPaperId ?? input.paperId,
    chunks: [{ text: "Indexed full text evidence.", metadata: { page: 1 } }]
  });
  return {
    artifactId: input.artifactId,
    chunkId: database.listArtifactChunks(input.projectId, input.artifactId, 1)[0].chunkId
  };
}

function downgradeRawDatabase(raw: DatabaseSync): void {
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE extraction_value_revisions;
    DROP TABLE extraction_field_revisions;
    DROP TABLE review_extraction_value_evidence;
    DROP TABLE review_audit_events;
    DROP TABLE review_evidence;
    DROP TABLE extraction_values;
    DROP TABLE review_run_items;
    DROP TABLE review_runs;
    DROP TABLE extraction_fields;
    DROP TABLE review_rereview_flags;
    DROP TABLE review_screening_decisions;
    DROP TABLE review_candidate_origins;
    DROP TABLE discovery_batches;
    DROP TABLE review_criteria;
    DROP TABLE review_protocol_revisions;
    DROP TABLE reviews;
    PRAGMA user_version = 2;
  `);
}

function downgradeFixture(path: string): void {
  const database = new PaperPilotDb(path);
  const project = database.createProject("Version two data");
  addPaper(database, project.id, "paper_v2", "Preserved paper");
  database.close();
  const raw = new DatabaseSync(path);
  downgradeRawDatabase(raw);
  raw.close();
}

describe("review schema migrations", () => {
  it("migrates version two data to version three without loss", () => {
    const path = join(dir, "v2.db");
    downgradeFixture(path);

    const database = new PaperPilotDb(path);
    openDatabases.push(database);

    const [project] = database.listProjects();
    expect(project.title).toBe("Version two data");
    expect(database.listPapers(project.id)[0].title).toBe("Preserved paper");
    expect(database.getReview(project.id)).toBeUndefined();
    const raw = new DatabaseSync(path);
    expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(3);
    raw.close();
  });

  it("rewrites swapped legacy dedupe keys in two phases without unique collisions", () => {
    const path = join(dir, "dedupe-swap.db");
    const seeded = new PaperPilotDb(path);
    const project = seeded.createProject("Dedupe migration");
    seeded.savePaper(project.id, {
      id: "paper_a",
      title: "First identity",
      authors: ["Author A"],
      year: 2024,
      doi: "10.1000/first",
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    seeded.savePaper(project.id, {
      id: "paper_b",
      title: "Second identity",
      authors: ["Author B"],
      year: 2025,
      doi: "10.1000/second",
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    seeded.close();

    const raw = new DatabaseSync(path);
    const originalRows = raw
      .prepare("SELECT id, dedupe_key FROM papers WHERE project_id = ? ORDER BY id")
      .all(project.id) as Array<{ id: string; dedupe_key: string }>;
    const firstKey = originalRows[0].dedupe_key;
    const secondKey = originalRows[1].dedupe_key;
    raw.prepare("UPDATE papers SET dedupe_key = ? WHERE id = 'paper_a'").run("temporary:paper_a");
    raw.prepare("UPDATE papers SET dedupe_key = ? WHERE id = 'paper_b'").run(firstKey);
    raw.prepare("UPDATE papers SET dedupe_key = ? WHERE id = 'paper_a'").run(secondKey);
    downgradeRawDatabase(raw);
    raw.close();

    const migrated = new PaperPilotDb(path);
    openDatabases.push(migrated);
    const migratedRows = new DatabaseSync(path);
    expect(
      migratedRows.prepare("SELECT id, dedupe_key FROM papers WHERE project_id = ? ORDER BY id").all(project.id)
    ).toEqual(originalRows);
    migratedRows.close();
    expect(migrated.listPapers(project.id)).toHaveLength(2);
  });

  it("rolls back the complete version-three migration when a step fails", () => {
    const path = join(dir, "rollback.db");
    downgradeFixture(path);
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE reviews (id INTEGER PRIMARY KEY)");
    raw.close();

    expect(() => new PaperPilotDb(path)).toThrow();

    const inspected = new DatabaseSync(path);
    expect((inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    expect((inspected.prepare("SELECT title FROM projects").get() as { title: string }).title).toBe("Version two data");
    expect(
      (
        inspected
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_runs'")
          .get() as {
          count: number;
        }
      ).count
    ).toBe(0);
    inspected.close();
  });

  it("refuses a database newer than schema version three", () => {
    const path = join(dir, "future.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 4");
    raw.close();

    expect(() => new PaperPilotDb(path)).toThrow(/newer than this Paper Pilot build supports/i);
  });
});

describe("review activation and isolation", () => {
  it("never merges papers on title alone", () => {
    const database = open();
    const project = database.createProject("Conservative identities");
    database.savePaper(project.id, {
      id: "same_title_2024",
      title: "A shared study title",
      authors: ["Ada Alpha"],
      year: 2024,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    database.savePaper(project.id, {
      id: "same_title_2025",
      title: "A shared study title",
      authors: ["Grace Beta"],
      year: 2025,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });

    expect(database.listPapers(project.id).map((paper) => paper.id)).toEqual(["same_title_2025", "same_title_2024"]);

    database.savePaper(project.id, {
      id: "keep_separate_one",
      title: "Ambiguous imported title",
      authors: ["Same Author"],
      year: 2026,
      source: "reference-import",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    database.savePaper(project.id, {
      id: "keep_separate_two",
      title: "Ambiguous imported title",
      authors: ["Same Author"],
      year: 2026,
      source: "reference-import",
      isOpenAccess: false,
      fieldsOfStudy: [],
      raw: { forceSeparateIdentity: "keep_separate_two" }
    });
    expect(database.listPapers(project.id).filter((paper) => paper.title === "Ambiguous imported title")).toHaveLength(
      2
    );
  });

  it("preserves stronger source identity metadata when enriching a paper", () => {
    const database = open();
    const project = database.createProject("Identity enrichment");
    const paper = addPaper(database, project.id, "identity_paper");

    const updated = database.updatePaper(project.id, paper.id, {
      source: "reference-import",
      sourcePaperId: "W-123",
      raw: { sourceAuthority: "openalex", alternateIds: { doi: "10.1000/example" } }
    });

    expect(updated).toMatchObject({
      source: "reference-import",
      sourcePaperId: "W-123",
      raw: { sourceAuthority: "openalex", alternateIds: { doi: "10.1000/example" } }
    });
  });

  it("activates one review per project and records pre-existing paper provenance", () => {
    const database = open();
    const project = database.createProject("Existing corpus");
    addPaper(database, project.id, "paper_one", "First study");
    addPaper(database, project.id, "paper_two", "Second study");

    const review = database.createReview({
      projectId: project.id,
      template: "general-empirical",
      researchQuestion: "Which interventions work?",
      objectives: ["Compare outcomes"],
      criteria: [
        {
          id: "criterion_population",
          stage: "title-abstract",
          type: "inclusion",
          label: "Relevant population"
        }
      ]
    });
    expect(database.createReview({ projectId: project.id }).id).toBe(review.id);
    expect(review).toMatchObject({
      projectId: project.id,
      template: "general-empirical",
      currentRevisionNumber: 1,
      historicalCountsAvailable: false
    });
    expect(database.getReviewProtocolRevision(review.id)).toMatchObject({
      researchQuestion: "Which interventions work?",
      objectives: ["Compare outcomes"]
    });
    expect(database.listDiscoveryBatches(review.id)[0]).toMatchObject({
      kind: "pre-existing",
      label: "Pre-existing project papers",
      counts: { identified: 2, newRecords: 2 },
      historicalCountsAvailable: false
    });
    expect(database.listReviewCandidateOrigins(review.id)).toHaveLength(2);
    const page = database.listReviewPapers({
      reviewId: review.id,
      stage: "title-abstract",
      sources: [],
      decisions: [],
      fullText: "any",
      sort: "title",
      direction: "asc",
      page: 1,
      pageSize: 25
    });
    expect(page.items.map((paper) => paper.title)).toEqual(["First study", "Second study"]);
    expect(page.counts.pending).toBe(2);
  });

  it("records candidate provenance in atomic prepared batches", () => {
    const database = open();
    const project = database.createProject("Bulk provenance");
    const paper = addPaper(database, project.id, "bulk_paper");
    const review = database.createReview({ projectId: project.id });
    const batch = database.saveDiscoveryBatch({
      reviewId: review.id,
      kind: "reference-import",
      label: "Bulk import",
      status: "running"
    });

    const inserted = database.recordReviewCandidateOriginsBulk([
      {
        id: "bulk_origin_one",
        reviewId: review.id,
        batchId: batch.id,
        paperId: paper.id,
        resolution: "created",
        recordSnapshot: { title: paper.title }
      },
      {
        id: "bulk_origin_two",
        reviewId: review.id,
        batchId: batch.id,
        matchedPaperId: paper.id,
        resolution: "skipped",
        recordSnapshot: { title: "Duplicate" }
      }
    ]);
    expect(inserted.map((origin) => origin.id)).toEqual(["bulk_origin_one", "bulk_origin_two"]);

    expect(() =>
      database.recordReviewCandidateOriginsBulk([
        {
          id: "rolled_back_origin",
          reviewId: review.id,
          batchId: batch.id,
          paperId: paper.id,
          resolution: "duplicate"
        },
        {
          id: "invalid_origin",
          reviewId: review.id,
          batchId: "missing_batch",
          resolution: "invalid"
        }
      ])
    ).toThrow(/batch not found/i);
    expect(database.listReviewCandidateOrigins(review.id).map((origin) => origin.id)).not.toContain(
      "rolled_back_origin"
    );
  });

  it("keeps protocols, screening, and queues isolated between projects", () => {
    const database = open();
    const firstProject = database.createProject("First project");
    const secondProject = database.createProject("Second project");
    const firstPaper = addPaper(database, firstProject.id, "first_paper");
    addPaper(database, secondProject.id, "second_paper");
    const firstReview = database.createReview({ projectId: firstProject.id, researchQuestion: "First?" });
    const secondReview = database.createReview({ projectId: secondProject.id, researchQuestion: "Second?" });

    database.setScreeningDecision({
      reviewId: firstReview.id,
      paperId: firstPaper.id,
      stage: "title-abstract",
      decision: "include"
    });

    expect(database.listScreeningDecisionHistory(firstReview.id)).toHaveLength(1);
    expect(database.listScreeningDecisionHistory(secondReview.id)).toHaveLength(0);
    expect(
      database
        .listReviewPapers({
          reviewId: secondReview.id,
          stage: "title-abstract",
          sources: [],
          decisions: [],
          fullText: "any",
          sort: "created",
          direction: "asc",
          page: 1,
          pageSize: 25
        })
        .items.map((paper) => paper.paperId)
    ).toEqual(["second_paper"]);
    expect(() =>
      database.setScreeningDecision({
        reviewId: secondReview.id,
        paperId: firstPaper.id,
        stage: "title-abstract",
        decision: "include"
      })
    ).toThrow(/paper not found in review project/i);
  });

  it("keeps 50,000-record review pagination bounded and counts stable before decision filtering", () => {
    const path = join(dir, "scale.db");
    const seeded = new PaperPilotDb(path);
    const project = seeded.createProject("Scale review");
    const review = seeded.createReview({ projectId: project.id });
    seeded.close();

    const raw = new DatabaseSync(path);
    const insertPaper = raw.prepare(
      `INSERT INTO papers (
         id, project_id, dedupe_key, title, normalized_title, abstract, authors_json,
         year, source, is_open_access, fields_json, raw_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', 2025, 'reference-import', 0, '[]', '{}', ?, ?)`
    );
    const insertDecision = raw.prepare(
      `INSERT INTO review_screening_decisions (
         id, review_id, paper_id, paper_snapshot_json, stage, decision,
         protocol_revision_id, created_at
       ) VALUES (?, ?, ?, ?, 'title-abstract', ?, ?, ?)`
    );
    const timestamp = "2026-01-01T00:00:00.000Z";
    raw.exec("BEGIN");
    for (let index = 0; index < 50_000; index += 1) {
      const paperId = `scale_${index.toString().padStart(5, "0")}`;
      const title = `Scale paper ${index.toString().padStart(5, "0")}`;
      insertPaper.run(
        paperId,
        project.id,
        `record:${paperId}`,
        title,
        title.toLowerCase(),
        "Abstract",
        timestamp,
        timestamp
      );
      if (index < 1_000) {
        insertDecision.run(
          `scale_old_${index}`,
          review.id,
          paperId,
          JSON.stringify({ id: paperId, title }),
          "uncertain",
          review.currentRevisionId,
          "2026-01-01T00:00:01.000Z"
        );
        insertDecision.run(
          `scale_current_${index}`,
          review.id,
          paperId,
          JSON.stringify({ id: paperId, title }),
          "include",
          review.currentRevisionId,
          "2026-01-01T00:00:02.000Z"
        );
      }
    }
    raw.exec("COMMIT");
    raw.close();

    const database = new PaperPilotDb(path);
    openDatabases.push(database);
    const startedAt = performance.now();
    const page = database.listReviewPapers({
      reviewId: review.id,
      stage: "title-abstract",
      sources: [],
      decisions: ["include"],
      fullText: "any",
      sort: "title",
      direction: "asc",
      page: 1,
      pageSize: 25
    });
    const elapsed = performance.now() - startedAt;

    expect(page.items).toHaveLength(25);
    expect(page.total).toBe(1_000);
    expect(page.counts).toEqual({ pending: 49_000, include: 1_000, exclude: 0, uncertain: 0 });
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("review protocol and screening policies", () => {
  it("stores criteria as globally unique revision snapshots and validates duplicate requests", () => {
    const database = open();
    const firstProject = database.createProject("First template review");
    const secondProject = database.createProject("Second template review");
    const templateCriteria = [
      {
        id: "template_population",
        stage: "title-abstract" as const,
        type: "inclusion" as const,
        label: "Eligible population",
        order: 0
      },
      {
        id: "template_wrong_design",
        stage: "title-abstract" as const,
        type: "exclusion" as const,
        label: "Wrong design",
        order: 0
      }
    ];
    const firstReview = database.createReview({ projectId: firstProject.id, criteria: templateCriteria });
    const secondReview = database.createReview({ projectId: secondProject.id, criteria: templateCriteria });
    const firstIds = database.listReviewCriteria(firstReview.id).map((criterion) => criterion.id);
    const secondIds = database.listReviewCriteria(secondReview.id).map((criterion) => criterion.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(4);

    expect(() =>
      database.reviseReviewProtocol({
        reviewId: firstReview.id,
        researchQuestion: "Duplicate request IDs?",
        criteria: [templateCriteria[0], { ...templateCriteria[0], label: "Duplicate" }]
      })
    ).toThrow(/duplicate review criterion request id/i);
    expect(() =>
      database.reviseReviewProtocol({
        reviewId: firstReview.id,
        researchQuestion: "Duplicate order?",
        criteria: [templateCriteria[0], { ...templateCriteria[0], id: "another", label: "Duplicate order" }]
      })
    ).toThrow(/duplicate inclusion criterion order/i);
  });

  it("fails interrupted runs and releases the one-active-run constraint after restart", () => {
    const database = open();
    const project = database.createProject("Interrupted review run");
    const paper = addPaper(database, project.id, "interrupted_paper");
    const review = database.createReview({ projectId: project.id });
    const timestamp = new Date().toISOString();
    database.saveReviewRun({
      id: "interrupted_run",
      reviewId: review.id,
      stage: "title-abstract",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: review.currentRevisionId,
      status: "queued",
      paperIds: [paper.id],
      fieldIds: [],
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    database.saveReviewRunItem({
      id: "interrupted_item",
      runId: "interrupted_run",
      paperId: paper.id,
      status: "queued",
      attemptCount: 0,
      extractionSuggestions: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });

    expect(database.markInterruptedReviewRuns()).toBe(1);
    expect(database.getReviewRun("interrupted_run")).toMatchObject({ status: "failed" });
    expect(database.getReviewRunItem("interrupted_item")).toMatchObject({ status: "cancelled" });
    expect(() =>
      database.saveReviewRun({
        id: "replacement_run",
        reviewId: review.id,
        stage: "title-abstract",
        provider: "ollama",
        model: "test-model",
        protocolRevisionId: review.currentRevisionId,
        status: "queued",
        paperIds: [paper.id],
        fieldIds: [],
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    ).not.toThrow();
  });

  it("requires title inclusion before full text and a reason for full-text exclusions", () => {
    const database = open();
    const project = database.createProject("Screening policy");
    const paper = addPaper(database, project.id, "policy_paper");
    const review = database.createReview({
      projectId: project.id,
      criteria: [
        {
          id: "full_text_wrong_population",
          stage: "full-text",
          type: "exclusion",
          label: "Wrong population"
        },
        {
          id: "abstract_relevant",
          stage: "title-abstract",
          type: "inclusion",
          label: "Relevant topic"
        }
      ]
    });
    const criteria = database.listReviewCriteria(review.id);
    const fullTextCriterion = criteria.find((criterion) => criterion.label === "Wrong population")!;
    const abstractCriterion = criteria.find((criterion) => criterion.label === "Relevant topic")!;

    expect(() =>
      database.setScreeningDecision({
        reviewId: review.id,
        paperId: paper.id,
        stage: "full-text",
        decision: "include"
      })
    ).toThrow(/title\/abstract screening/i);
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    expect(() =>
      database.setScreeningDecision({
        reviewId: review.id,
        paperId: paper.id,
        stage: "full-text",
        decision: "exclude"
      })
    ).toThrow(/require a criterion or custom reason/i);
    expect(() =>
      database.setScreeningDecision({
        reviewId: review.id,
        paperId: paper.id,
        stage: "full-text",
        decision: "exclude",
        reasonCriterionId: abstractCriterion.id
      })
    ).toThrow(/does not belong to this protocol stage/i);

    const excluded = database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "exclude",
      reasonCriterionId: fullTextCriterion.id
    });
    expect(excluded.reasonCriterionId).toBe(fullTextCriterion.id);
    const changed = database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "uncertain"
    });
    expect(changed.previousDecisionId).toBe(excluded.id);
    expect(database.listScreeningDecisionHistory(review.id, paper.id, "full-text")).toHaveLength(2);
  });

  it("invalidates downstream review state when title screening is no longer included", () => {
    const database = open();
    const project = database.createProject("Downstream eligibility");
    const paper = addPaper(database, project.id, "eligibility_paper");
    const review = database.createReview({ projectId: project.id });
    includeThroughFullText(database, review.id, paper.id);
    const field = database.saveExtractionField({ reviewId: review.id, name: "Outcome", type: "short-text" });
    const value = database.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "confirmed",
      origin: "manual"
    });
    expect(database.getReviewFlowSummary(review.id).includedPapers).toBe(1);

    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "exclude"
    });

    expect(database.listScreeningDecisionHistory(review.id, paper.id, "full-text")).toHaveLength(1);
    expect(database.getExtractionValue(value.id)?.status).toBe("needs-review");
    expect(database.getReviewFlowSummary(review.id).includedPapers).toBe(0);
    expect(
      database.listReviewPapers({
        reviewId: review.id,
        stage: "extraction",
        sources: [],
        decisions: [],
        fullText: "any",
        sort: "created",
        direction: "asc",
        page: 1,
        pageSize: 25
      }).items
    ).toHaveLength(0);
    expect(() =>
      database.saveExtractionValue({
        reviewId: review.id,
        paperId: paper.id,
        fieldId: field.id,
        value: "Changed",
        status: "confirmed",
        origin: "manual"
      })
    ).toThrow(/both screening stages/i);

    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    expect(
      database.listReviewPapers({
        reviewId: review.id,
        stage: "extraction",
        sources: [],
        decisions: [],
        fullText: "any",
        sort: "created",
        direction: "asc",
        page: 1,
        pageSize: 25
      }).items
    ).toHaveLength(0);
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include"
    });
    expect(database.getReviewFlowSummary(review.id).includedPapers).toBe(1);
  });

  it("preserves human decisions and marks earlier AI suggestions stale after protocol revision", () => {
    const database = open();
    const project = database.createProject("Revision history");
    const paper = addPaper(database, project.id, "revision_paper");
    const review = database.createReview({
      projectId: project.id,
      researchQuestion: "Original question",
      criteria: [
        {
          id: "retained_criterion",
          stage: "title-abstract",
          type: "inclusion",
          label: "Relevant design"
        }
      ]
    });
    const decision = database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    const timestamp = new Date().toISOString();
    database.saveReviewRun({
      id: "run_before_revision",
      reviewId: review.id,
      stage: "title-abstract",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: review.currentRevisionId,
      status: "completed",
      paperIds: [paper.id],
      fieldIds: [],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    database.saveReviewRunItem({
      id: "run_item_before_revision",
      runId: "run_before_revision",
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      extractionSuggestions: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });

    const revision = database.reviseReviewProtocol({
      reviewId: review.id,
      researchQuestion: "Revised question",
      changeNote: "Clarified the outcome",
      criteria: [
        {
          id: "retained_criterion",
          stage: "title-abstract",
          type: "inclusion",
          label: "Relevant study design"
        }
      ]
    });

    expect(revision.version).toBe(2);
    const revisionHistory = database.listReviewProtocolRevisions(review.id);
    expect(revisionHistory.map((item) => item.criteria[0]?.label)).toEqual([
      "Relevant study design",
      "Relevant design"
    ]);
    expect(new Set(revisionHistory.map((item) => item.criteria[0]?.id)).size).toBe(2);
    expect(database.getCurrentScreeningDecision(review.id, paper.id, "title-abstract")?.id).toBe(decision.id);
    expect(
      database.listReviewPapers({
        reviewId: review.id,
        stage: "title-abstract",
        sources: [],
        decisions: [],
        fullText: "any",
        sort: "created",
        direction: "asc",
        page: 1,
        pageSize: 25
      }).items[0].aiSuggestionStale
    ).toBe(true);
    expect(database.getReviewRunItem("run_item_before_revision")?.stale).toBe(true);

    database.saveReviewRun({
      id: "run_after_revision",
      reviewId: review.id,
      stage: "title-abstract",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: revision.id,
      status: "completed",
      paperIds: [paper.id],
      fieldIds: [],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const currentItem = database.saveReviewRunItem({
      id: "run_item_after_revision",
      runId: "run_after_revision",
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      extractionSuggestions: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    expect(currentItem.stale).toBe(false);
    expect(
      database.listReviewPapers({
        reviewId: review.id,
        stage: "title-abstract",
        sources: [],
        decisions: [],
        fullText: "any",
        sort: "created",
        direction: "asc",
        page: 1,
        pageSize: 25
      }).items[0].aiSuggestionStale
    ).toBe(false);
    expect(
      database.markScreeningForRereview({ reviewId: review.id, paperIds: [paper.id], stage: "title-abstract" })
    ).toBe(1);
    expect(
      database.markScreeningForRereview({ reviewId: review.id, paperIds: [paper.id], stage: "title-abstract" })
    ).toBe(0);
    expect(() => database.deleteProject(project.id)).not.toThrow();
    expect(database.getReview(project.id)).toBeUndefined();
  });

  it("marks late run items stale, retains criterion provenance, and downgrades stale extraction suggestions", () => {
    const database = open();
    const project = database.createProject("Late AI completion");
    const paper = addPaper(database, project.id, "late_paper");
    const review = database.createReview({
      projectId: project.id,
      criteria: [
        {
          stage: "full-text",
          type: "inclusion",
          label: "Eligible design"
        }
      ]
    });
    includeThroughFullText(database, review.id, paper.id);
    const field = database.saveExtractionField({ reviewId: review.id, name: "Result", type: "short-text" });
    const timestamp = new Date().toISOString();
    database.saveReviewRun({
      id: "late_extraction_run",
      reviewId: review.id,
      stage: "extraction",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: review.currentRevisionId,
      status: "running",
      paperIds: [paper.id],
      fieldIds: [field.id],
      completedCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const revised = database.reviseReviewProtocol({
      reviewId: review.id,
      researchQuestion: "Revised while running",
      criteria: []
    });
    const evidence = {
      id: "late_evidence",
      reviewId: review.id,
      evidenceId: "E1",
      paperId: paper.id,
      sourceType: "paper-abstract" as const,
      title: paper.title,
      excerpt: "The result improved.",
      createdAt: timestamp
    };
    const item = database.saveReviewRunItem({
      id: "late_extraction_item",
      runId: "late_extraction_run",
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      criterionAssessments: [
        {
          criterionId: database.listReviewProtocolRevisions(review.id)[1].criteria[0].id,
          assessment: "met",
          explanation: "The design matched.",
          evidenceIds: ["E1"]
        }
      ],
      extractionSuggestions: [
        {
          fieldId: field.id,
          value: "Improved",
          status: "suggested",
          evidenceIds: ["E1"]
        }
      ],
      evidence: [evidence],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    expect(item.criterionAssessments[0]?.assessment).toBe("met");
    expect(revised.version).toBe(2);
    expect(
      database.listReviewPapers({
        reviewId: review.id,
        stage: "extraction",
        sources: [],
        decisions: [],
        fullText: "any",
        sort: "created",
        direction: "asc",
        page: 1,
        pageSize: 25
      }).items[0].aiSuggestionStale
    ).toBe(true);
    const value = database.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "suggested",
      origin: "ai",
      runItemId: item.id,
      evidenceIds: [evidence.id]
    });
    expect(value.status).toBe("needs-review");
  });
});

describe("review extraction and durable evidence", () => {
  it("allows same-paper evidence reuse while rejecting cross-paper evidence, including after deletion", () => {
    const database = open();
    const project = database.createProject("Evidence ownership");
    const firstPaper = addPaper(database, project.id, "evidence_paper_one");
    const secondPaper = addPaper(database, project.id, "evidence_paper_two");
    const review = database.createReview({ projectId: project.id });
    includeThroughFullText(database, review.id, firstPaper.id);
    includeThroughFullText(database, review.id, secondPaper.id);
    const firstField = database.saveExtractionField({ reviewId: review.id, name: "Outcome", type: "short-text" });
    const secondField = database.saveExtractionField({ reviewId: review.id, name: "Measure", type: "short-text" });
    const evidence = database.saveReviewEvidence({
      id: "shared_evidence",
      reviewId: review.id,
      evidenceId: "E1",
      paperId: firstPaper.id,
      sourceType: "paper-abstract",
      title: firstPaper.title,
      excerpt: "The outcome improved on the selected measure.",
      createdAt: new Date().toISOString()
    });
    const firstValue = database.saveExtractionValue({
      reviewId: review.id,
      paperId: firstPaper.id,
      fieldId: firstField.id,
      value: "Improved",
      status: "confirmed",
      origin: "ai",
      evidenceIds: [evidence.id]
    });
    const secondValue = database.saveExtractionValue({
      reviewId: review.id,
      paperId: firstPaper.id,
      fieldId: secondField.id,
      value: "Validated scale",
      status: "confirmed",
      origin: "ai",
      evidenceIds: [evidence.id]
    });
    expect(firstValue.evidenceIds).toEqual([evidence.id]);
    expect(secondValue.evidenceIds).toEqual([evidence.id]);
    expect(() =>
      database.saveExtractionValue({
        reviewId: review.id,
        paperId: secondPaper.id,
        fieldId: firstField.id,
        value: "Wrong paper",
        status: "confirmed",
        origin: "ai",
        evidenceIds: [evidence.id]
      })
    ).toThrow(/same paper/i);

    database.deletePaper(project.id, firstPaper.id);
    const durable = database.getReviewEvidence(evidence.id)!;
    expect(durable.paperId).toBeUndefined();
    expect(() => database.saveReviewEvidence(durable, secondValue.id)).not.toThrow();
    expect(database.getExtractionValue(secondValue.id)?.evidenceIds).toEqual([evidence.id]);
  });

  it("requires evidence for confirmed AI values and invalidates values on semantic field changes", () => {
    const database = open();
    const project = database.createProject("Extraction");
    const paper = addPaper(database, project.id, "extract_paper");
    const review = database.createReview({ projectId: project.id });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    database.setScreeningDecision({ reviewId: review.id, paperId: paper.id, stage: "full-text", decision: "include" });
    const field = database.saveExtractionField({
      reviewId: review.id,
      name: "Sample size",
      type: "number"
    });

    for (const blank of [null, "", "   ", []] as const) {
      expect(() =>
        database.saveExtractionValue({
          reviewId: review.id,
          paperId: paper.id,
          fieldId: field.id,
          value: blank,
          status: "confirmed",
          origin: "manual"
        })
      ).toThrow(/cannot be blank.*not found/i);
    }

    expect(() =>
      database.saveExtractionValue({
        reviewId: review.id,
        paperId: paper.id,
        fieldId: field.id,
        value: 42,
        status: "confirmed",
        origin: "ai"
      })
    ).toThrow(/require evidence/i);

    const evidence = database.saveReviewEvidence({
      id: "review_evidence_one",
      reviewId: review.id,
      evidenceId: "E1",
      paperId: paper.id,
      sourceType: "paper-abstract",
      title: paper.title,
      excerpt: "The study enrolled 42 participants.",
      locator: "Abstract",
      createdAt: new Date().toISOString()
    });
    const value = database.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: 42,
      status: "confirmed",
      origin: "ai",
      evidenceIds: [evidence.id]
    });
    expect(value.evidenceIds).toEqual([evidence.id]);

    const reordered = database.saveExtractionField({
      id: field.id,
      reviewId: review.id,
      name: field.name,
      type: field.type,
      order: 5
    });
    expect(reordered.revision).toBe(1);
    const revised = database.saveExtractionField({
      id: field.id,
      reviewId: review.id,
      name: "Enrolled sample size",
      type: field.type,
      order: 5
    });
    expect(revised.revision).toBe(2);
    expect(database.getExtractionValue(value.id)?.status).toBe("needs-review");
    expect(database.listExtractionFieldHistory(field.id).map((entry) => entry.revision)).toEqual([1, 2]);
    expect(database.listExtractionValueHistory(value.id).map((entry) => entry.status)).toEqual([
      "confirmed",
      "needs-review"
    ]);
  });

  it("retains evidence and decision snapshots when linked records are deleted", () => {
    const database = open();
    const project = database.createProject("Evidence snapshots");
    const paper = addPaper(database, project.id, "deleted_paper", "Durable citation");
    const review = database.createReview({ projectId: project.id });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    const evidence = database.saveReviewEvidence({
      id: "durable_evidence",
      reviewId: review.id,
      evidenceId: "E1",
      paperId: paper.id,
      sourceType: "paper-abstract",
      title: paper.title,
      excerpt: "This excerpt must survive deletion.",
      createdAt: new Date().toISOString()
    });

    database.deletePaper(project.id, paper.id);

    expect(database.getReviewEvidence(evidence.id)).toMatchObject({
      title: "Durable citation",
      excerpt: "This excerpt must survive deletion."
    });
    expect(database.getReviewEvidence(evidence.id)?.paperId).toBeUndefined();
    expect(database.listScreeningDecisionHistory(review.id)[0].paperId).toBe(paper.id);
  });

  it("partitions current decisions by immutable paper snapshots after multiple papers are deleted", () => {
    const database = open();
    const project = database.createProject("Deleted decision partitions");
    const includedPaper = addPaper(database, project.id, "deleted_included");
    const excludedPaper = addPaper(database, project.id, "deleted_excluded");
    const review = database.createReview({ projectId: project.id });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: includedPaper.id,
      stage: "title-abstract",
      decision: "uncertain"
    });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: includedPaper.id,
      stage: "title-abstract",
      decision: "include"
    });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: excludedPaper.id,
      stage: "title-abstract",
      decision: "exclude"
    });
    database.deletePaper(project.id, includedPaper.id);
    database.deletePaper(project.id, excludedPaper.id);

    expect(database.getCurrentScreeningDecision(review.id, includedPaper.id, "title-abstract")?.decision).toBe(
      "include"
    );
    expect(database.getCurrentScreeningDecision(review.id, excludedPaper.id, "title-abstract")?.decision).toBe(
      "exclude"
    );
    expect(database.getReviewFlowSummary(review.id)).toMatchObject({
      uniqueRecordsScreened: 2,
      titleAbstractExclusions: 1,
      fullTextsSought: 1
    });
  });

  it("reports fresh-review history accurately and counts unresolved extraction states", () => {
    const database = open();
    const project = database.createProject("Summary review");
    const review = database.createReview({ projectId: project.id });
    const paper = addPaper(database, project.id, "summary_paper");
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    database.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include"
    });
    const suggestedField = database.saveExtractionField({
      reviewId: review.id,
      name: "Suggested outcome",
      type: "short-text"
    });
    const rejectedField = database.saveExtractionField({
      reviewId: review.id,
      name: "Rejected outcome",
      type: "short-text"
    });
    database.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: suggestedField.id,
      value: "Candidate value",
      status: "suggested",
      origin: "ai"
    });
    database.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: rejectedField.id,
      value: "Rejected value",
      status: "rejected",
      origin: "ai"
    });

    expect(database.getReviewFlowSummary(review.id)).toMatchObject({
      historicalCountsAvailable: true,
      warnings: [],
      extraction: { totalCells: 2, confirmedCells: 0, notFoundCells: 0, needsReviewCells: 2 }
    });
  });

  it("counts only trusted, correctly paper-linked artifacts as indexed review full text", () => {
    const database = open();
    const project = database.createProject("Trusted full text");
    const trustedPaper = addPaper(database, project.id, "trusted_paper");
    const briefPaper = addPaper(database, project.id, "brief_paper");
    const generatedPaper = addPaper(database, project.id, "generated_paper");
    const metadataMismatchPaper = addPaper(database, project.id, "metadata_mismatch_paper");
    const chunkMismatchPaper = addPaper(database, project.id, "chunk_mismatch_paper");
    const review = database.createReview({ projectId: project.id });
    for (const paper of [trustedPaper, briefPaper, generatedPaper, metadataMismatchPaper, chunkMismatchPaper]) {
      database.setScreeningDecision({
        reviewId: review.id,
        paperId: paper.id,
        stage: "title-abstract",
        decision: "include"
      });
    }
    const trusted = addIndexedArtifact(database, {
      projectId: project.id,
      artifactId: "trusted_markdown",
      artifactType: "markdown",
      paperId: trustedPaper.id
    });
    addIndexedArtifact(database, {
      projectId: project.id,
      artifactId: "generated_brief",
      artifactType: "brief",
      paperId: briefPaper.id
    });
    addIndexedArtifact(database, {
      projectId: project.id,
      artifactId: "research_chat_markdown",
      artifactType: "markdown",
      paperId: generatedPaper.id,
      source: "research-chat"
    });
    addIndexedArtifact(database, {
      projectId: project.id,
      artifactId: "wrong_metadata",
      artifactType: "paper-pdf",
      paperId: metadataMismatchPaper.id,
      metadataPaperId: trustedPaper.id
    });
    addIndexedArtifact(database, {
      projectId: project.id,
      artifactId: "wrong_chunk_paper",
      artifactType: "table",
      paperId: chunkMismatchPaper.id,
      chunkPaperId: trustedPaper.id
    });

    const available = database.listReviewPapers({
      reviewId: review.id,
      stage: "full-text",
      sources: [],
      decisions: [],
      fullText: "available",
      sort: "title",
      direction: "asc",
      page: 1,
      pageSize: 25
    });
    expect(available.items.map((paper) => paper.paperId)).toEqual([trustedPaper.id]);
    expect(database.getReviewFlowSummary(review.id)).toMatchObject({
      fullTextsSought: 5,
      fullTextsUnavailable: 4
    });
    expect(() =>
      database.saveReviewEvidence({
        id: "trusted_chunk_evidence",
        reviewId: review.id,
        evidenceId: "S1",
        paperId: trustedPaper.id,
        artifactId: trusted.artifactId,
        chunkId: trusted.chunkId,
        sourceType: "artifact-chunk",
        title: trustedPaper.title,
        excerpt: "Indexed full text evidence.",
        createdAt: new Date().toISOString()
      })
    ).not.toThrow();
    const generatedChunk = database.listArtifactChunks(project.id, "research_chat_markdown", 1)[0];
    expect(() =>
      database.saveReviewEvidence({
        id: "untrusted_chunk_evidence",
        reviewId: review.id,
        evidenceId: "S2",
        paperId: generatedPaper.id,
        artifactId: "research_chat_markdown",
        chunkId: generatedChunk.chunkId,
        sourceType: "artifact-chunk",
        title: generatedPaper.title,
        excerpt: generatedChunk.text,
        createdAt: new Date().toISOString()
      })
    ).toThrow(/trusted indexed chunk/i);
  });
});

describe("review portability and batch transactions", () => {
  it("round trips the complete review state without regenerating audit history or snapshots", () => {
    const source = open("portability-source.db");
    const sourceProject = source.createProject("Portable review");
    const paper = addPaper(source, sourceProject.id, "portable_paper", "Portable evidence");
    const review = source.createReview({
      projectId: sourceProject.id,
      researchQuestion: "Does the evidence travel?",
      criteria: [
        {
          id: "portable_exclusion",
          stage: "full-text",
          type: "exclusion",
          label: "Ineligible design"
        }
      ]
    });
    source.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include"
    });
    source.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include"
    });
    source.markScreeningForRereview({ reviewId: review.id, paperIds: [paper.id], stage: "full-text" });
    const field = source.saveExtractionField({ reviewId: review.id, name: "Outcome", type: "short-text" });
    source.saveExtractionValue({
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Improved",
      status: "confirmed",
      origin: "manual"
    });
    const timestamp = new Date().toISOString();
    source.saveReviewRun({
      id: "portable_run",
      reviewId: review.id,
      stage: "extraction",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: review.currentRevisionId,
      status: "completed",
      paperIds: [paper.id],
      fieldIds: [field.id],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    source.saveReviewRunItem({
      id: "portable_run_item",
      runId: "portable_run",
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      suggestedDecision: "include",
      extractionSuggestions: [],
      evidence: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    source.saveReviewRun({
      id: "portable_failed_run",
      reviewId: review.id,
      stage: "title-abstract",
      provider: "ollama",
      model: "test-model",
      protocolRevisionId: review.currentRevisionId,
      status: "failed",
      paperIds: [paper.id],
      fieldIds: [],
      completedCount: 0,
      failedCount: 1,
      cancelledCount: 0,
      error: "Provider unavailable.",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    source.saveReviewRunItem({
      id: "portable_failed_item",
      runId: "portable_failed_run",
      paperId: paper.id,
      status: "failed",
      attemptCount: 2,
      extractionSuggestions: [],
      evidence: [],
      error: "Provider unavailable.",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp
    });
    const batch = source.listDiscoveryBatches(review.id)[0];
    source.saveDiscoveryBatch({ ...batch, config: { query: "portable query" } });
    const exported = source.exportReviewPortabilityState(review.id);
    expect(exported.runs.map((run) => run.status).sort()).toEqual(["completed", "failed"]);

    const target = open("portability-target.db");
    const targetProject = target.createProject("Imported review");
    addPaper(target, targetProject.id, paper.id, paper.title);
    const remapped: ReviewPortabilityState = {
      ...structuredClone(exported),
      review: { ...exported.review, projectId: targetProject.id }
    };
    const imported = target.importReviewPortabilityState(targetProject.id, remapped);

    expect(imported.id).toBe(review.id);
    expect(target.exportReviewPortabilityState(imported.id)).toEqual(remapped);
    expect(target.listReviewAuditEvents(imported.id)).toHaveLength(exported.auditEvents.length);
  });

  it("rolls back a portability import atomically and supports nested batch transactions", () => {
    const source = open("rollback-source.db");
    const sourceProject = source.createProject("Rollback source");
    addPaper(source, sourceProject.id, "rollback_paper");
    const sourceReview = source.createReview({ projectId: sourceProject.id, researchQuestion: "Rollback?" });
    const exported = source.exportReviewPortabilityState(sourceReview.id);

    const target = open("rollback-target.db");
    const targetProject = target.createProject("Rollback target");
    addPaper(target, targetProject.id, "rollback_paper");
    const corrupt: ReviewPortabilityState = {
      ...structuredClone(exported),
      review: { ...exported.review, projectId: targetProject.id },
      revisions: [...exported.revisions, exported.revisions[0]]
    };

    expect(() => target.importReviewPortabilityState(targetProject.id, corrupt)).toThrow();
    expect(target.getReview(targetProject.id)).toBeUndefined();

    expect(() =>
      target.transaction(() => {
        target.savePaper(targetProject.id, {
          id: "transaction_paper",
          title: "Nested transaction paper",
          authors: [],
          source: "reference-import",
          isOpenAccess: false,
          fieldsOfStudy: []
        });
        throw new Error("force rollback");
      })
    ).toThrow(/force rollback/);
    expect(target.getPaper(targetProject.id, "transaction_paper")).toBeUndefined();
  });
});
