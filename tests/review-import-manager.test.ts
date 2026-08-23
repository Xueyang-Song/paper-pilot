import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ReviewImportManager } from "../src/main/services/review-import-manager";

let directory: string;
let db: PaperPilotDb;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paper-pilot-review-import-"));
  db = new PaperPilotDb(join(directory, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("ReviewImportManager", () => {
  it("previews title-only matches as ambiguous without exposing a raw path", async () => {
    const fixture = reviewFixture();
    db.savePaper(fixture.projectId, {
      id: "existing",
      title: "Shared title",
      authors: ["Original Author"],
      year: 2020,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const path = await csv("title,authors,year\nShared title,Different Author,2024\n");

    const preview = await new ReviewImportManager(db).preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });

    expect(preview).not.toHaveProperty("filePath");
    expect(preview.items[0]).toMatchObject({
      valid: true,
      match: { kind: "ambiguous", candidatePaperIds: ["existing"] }
    });
  });

  it("records an explicit skip and reconciles discovery counts", async () => {
    const fixture = reviewFixture();
    db.savePaper(fixture.projectId, {
      id: "existing",
      title: "Shared title",
      authors: ["Original Author"],
      year: 2020,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const path = await csv("title,authors,year\nShared title,Different Author,2024\n");
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });

    const result = await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: [{ recordIndex: 0, action: "skip" }]
    });

    expect(result.counts).toMatchObject({ identified: 1, filtered: 1, newRecords: 0 });
    expect(db.listReviewCandidateOrigins(fixture.reviewId, result.batch.id)[0]).toMatchObject({
      resolution: "skipped"
    });
    expect(db.listPapers(fixture.projectId)).toHaveLength(1);
  });

  it("requires ambiguous resolutions and restricts merges to the presented candidates", async () => {
    const fixture = reviewFixture();
    db.savePaper(fixture.projectId, {
      id: "candidate",
      title: "Shared title",
      authors: ["Original Author"],
      year: 2020,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    db.savePaper(fixture.projectId, {
      id: "unrelated",
      title: "Unrelated paper",
      authors: ["Another Author"],
      year: 2019,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const path = await csv("title,authors,year\nShared title,Different Author,2024\n");
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });

    await expect(
      manager.commit({
        projectId: fixture.projectId,
        reviewId: fixture.reviewId,
        previewId: preview.previewId,
        resolutions: []
      })
    ).rejects.toThrow(/explicit ambiguous-match resolution/i);
    await expect(
      manager.commit({
        projectId: fixture.projectId,
        reviewId: fixture.reviewId,
        previewId: preview.previewId,
        resolutions: [{ recordIndex: 0, action: "merge", paperId: "unrelated" }]
      })
    ).rejects.toThrow(/invalid merge target/i);
    expect(db.listDiscoveryBatches(fixture.reviewId).filter((batch) => batch.kind === "reference-import")).toEqual([]);
  });

  it("merges an exact normalized DOI, enriches metadata, and retains the source occurrence", async () => {
    const fixture = reviewFixture();
    db.savePaper(fixture.projectId, {
      id: "existing",
      title: "Original title",
      authors: ["A. Author"],
      year: 2022,
      doi: "10.1000/example",
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const path = await csv(
      "title,authors,year,doi,abstract,citation count\nOriginal title,A. Author,2022,https://doi.org/10.1000/example,New abstract,9\n"
    );
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });
    expect(preview.items[0].match).toMatchObject({ kind: "exact", paperId: "existing", matchedBy: "doi" });

    const result = await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: []
    });

    expect(result.counts).toMatchObject({ identified: 1, merged: 1, duplicates: 0, newRecords: 0 });
    expect(db.getPaper(fixture.projectId, "existing")).toMatchObject({ abstract: "New abstract", citationCount: 9 });
    expect(db.listReviewCandidateOrigins(fixture.reviewId, result.batch.id)[0]).toMatchObject({
      paperId: "existing",
      matchedPaperId: "existing",
      resolution: "merged"
    });
  });

  it("rejects a file changed after preview without mutating review provenance", async () => {
    const fixture = reviewFixture();
    const path = await csv("title\nFirst record\n");
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });
    await writeFile(path, "title\nChanged record\n", "utf8");

    await expect(
      manager.commit({
        projectId: fixture.projectId,
        reviewId: fixture.reviewId,
        previewId: preview.previewId,
        resolutions: []
      })
    ).rejects.toThrow(/changed after preview/i);
    expect(db.listDiscoveryBatches(fixture.reviewId).filter((batch) => batch.kind === "reference-import")).toEqual([]);
  });

  it("does not copy an imported identifier into a different source authority", async () => {
    const fixture = reviewFixture();
    db.savePaper(fixture.projectId, {
      id: "crossref-record",
      title: "Authority-safe merge",
      authors: ["Doe, Jane"],
      year: 2024,
      source: "crossref",
      sourcePaperId: "CR-9",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const path = await csv(
      "title,authors,year,source id,source authority,abstract\nAuthority-safe merge,Jane Doe,2024,W123,OpenAlex,Enriched abstract\n"
    );
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });

    expect(preview.items[0].match).toMatchObject({ kind: "exact", matchedBy: "fingerprint" });
    await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: []
    });

    const merged = db.getPaper(fixture.projectId, "crossref-record");
    expect(merged).toMatchObject({ source: "crossref", sourcePaperId: "CR-9", abstract: "Enriched abstract" });
    expect(merged?.raw?.identitySourceIdentifiers).toEqual([{ authority: "openalex", identifier: "w123" }]);
  });

  it("deduplicates records created earlier in the same import using the incremental identity index", async () => {
    const fixture = reviewFixture();
    const path = await csv(
      [
        "title,authors,year,abstract",
        "One batched study,Jane Doe,2024,First occurrence",
        "One batched study,Jane Doe,2024,Second occurrence"
      ].join("\n")
    );
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });
    expect(preview.items[1].match).toMatchObject({
      kind: "exact",
      matchedBy: "fingerprint",
      paperId: "preview-paper:1"
    });
    const result = await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: []
    });

    expect(result.counts).toMatchObject({ identified: 2, newRecords: 1, duplicates: 1 });
    expect(db.listPapers(fixture.projectId)).toHaveLength(1);
    expect(db.listReviewCandidateOrigins(fixture.reviewId, result.batch.id)).toHaveLength(2);
  });

  it("uses preview record identities as explicit merge targets in cross-record order", async () => {
    const fixture = reviewFixture();
    const path = await csv(["title,authors,year", "Same title,Jane Doe,2024", "Same title,John Roe,2023"].join("\n"));
    const manager = new ReviewImportManager(db);
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });

    expect(preview.items[0].match.kind).toBe("none");
    expect(preview.items[1].match).toMatchObject({
      kind: "ambiguous",
      candidatePaperIds: ["preview-paper:1"]
    });
    const result = await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: [{ recordIndex: 1, action: "merge", paperId: "preview-paper:1" }]
    });

    expect(result.counts).toMatchObject({ identified: 2, newRecords: 1, merged: 1 });
    expect(db.listPapers(fixture.projectId)).toHaveLength(1);
    expect(db.listReviewCandidateOrigins(fixture.reviewId, result.batch.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ resolution: "merged" })])
    );
  });

  it("buffers large imports into bounded prepared provenance writes", async () => {
    const fixture = reviewFixture();
    const records = Array.from({ length: 1_201 }, (_, index) =>
      [`Unique import ${index}`, `Author ${index}`, "2024"].join(",")
    );
    const path = await csv(["title,authors,year", ...records].join("\n"));
    const manager = new ReviewImportManager(db);
    const bulkOrigins = vi.spyOn(db, "recordReviewCandidateOriginsBulk");
    const preview = await manager.preview({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      filePath: path
    });
    const result = await manager.commit({
      projectId: fixture.projectId,
      reviewId: fixture.reviewId,
      previewId: preview.previewId,
      resolutions: []
    });

    expect(result.counts).toMatchObject({ identified: 1_201, newRecords: 1_201 });
    expect(bulkOrigins.mock.calls.map(([inputs]) => inputs.length)).toEqual([500, 500, 201]);
  });
});

function reviewFixture(): { projectId: string; reviewId: string } {
  const project = db.createProject("Imported review");
  const review = db.createReview({ projectId: project.id });
  return { projectId: project.id, reviewId: review.id };
}

async function csv(content: string): Promise<string> {
  const path = join(directory, `references-${Math.random().toString(16).slice(2)}.csv`);
  await writeFile(path, content, "utf8");
  return path;
}
