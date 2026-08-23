import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { collectReviewPaperEvidence, hasIndexedReviewFullText } from "../src/main/services/review-evidence";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-review-evidence-"));
  db = new PaperPilotDb(join(dir, "review.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("review evidence", () => {
  it("uses only the selected paper abstract during title/abstract screening", () => {
    const project = db.createProject("Review");
    const paper = db.savePaper(project.id, {
      id: "paper-a",
      title: "Eligible trial",
      abstract: "Adults received an intervention in a randomized trial.",
      authors: [],
      source: "pubmed",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    db.savePaper(project.id, {
      id: "paper-b",
      title: "Other trial",
      abstract: "This evidence must not be included.",
      authors: [],
      source: "pubmed",
      isOpenAccess: false,
      fieldsOfStudy: []
    });

    const result = collectReviewPaperEvidence({
      db,
      projectId: project.id,
      paperId: paper.id,
      stage: "title-abstract",
      query: "adults"
    });
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ paperId: paper.id, locator: "Paper metadata" }),
        expect.objectContaining({ paperId: paper.id, locator: "Abstract" })
      ])
    );
    expect(result.map((entry) => entry.excerpt).join("\n")).not.toContain("must not be included");
  });

  it("restricts full-text evidence to indexed artifacts linked to the paper", () => {
    const project = db.createProject("Review");
    const paper = db.savePaper(project.id, {
      id: "paper-a",
      title: "Eligible trial",
      authors: [],
      source: "pubmed",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    const linked = db.saveArtifact({
      id: "artifact-a",
      projectId: project.id,
      type: "paper-pdf",
      title: paper.title,
      path: join(dir, "paper.pdf"),
      mime: "application/pdf",
      hash: "hash-a",
      metadata: { paperId: paper.id },
      createdAt: new Date().toISOString()
    });
    const unrelated = db.saveArtifact({
      id: "artifact-b",
      projectId: project.id,
      type: "markdown",
      title: "Unrelated",
      path: join(dir, "other.md"),
      mime: "text/markdown",
      hash: "hash-b",
      metadata: {},
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: linked.id,
      paperId: paper.id,
      chunks: [{ text: "The intervention improved the measured outcome.", metadata: { page: 4 } }]
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: unrelated.id,
      chunks: [{ text: "Unrelated intervention outcome." }]
    });

    expect(hasIndexedReviewFullText(db, project.id, paper.id)).toBe(true);
    const result = collectReviewPaperEvidence({
      db,
      projectId: project.id,
      paperId: paper.id,
      stage: "full-text",
      query: "intervention outcome"
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ artifactId: linked.id, paperId: paper.id, page: 4 });
  });
});
