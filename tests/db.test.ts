import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-"));
  db = new PaperPilotDb(join(dir, "test.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("PaperPilotDb", () => {
  it("creates projects and persists messages", () => {
    const project = db.createProject("CRISPR delivery", "CRISPR");
    db.appendMessage({ projectId: project.id, role: "user", content: "crawl papers", metadata: {} });
    db.appendMessage({ projectId: project.id, role: "assistant", content: "done", metadata: { tool: "crawl" } });
    expect(db.listProjects()).toHaveLength(1);
    expect(db.listMessages(project.id).map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("dedupes papers by DOI", () => {
    const project = db.createProject("Materials");
    db.savePaper(project.id, {
      id: "paper_1",
      title: "Original title",
      authors: [],
      doi: "10.1000/demo",
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    db.savePaper(project.id, {
      id: "paper_2",
      title: "Different title",
      authors: [],
      doi: "https://doi.org/10.1000/demo",
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    const papers = db.listPapers(project.id);
    expect(papers).toHaveLength(1);
    expect(papers[0].isOpenAccess).toBe(true);
  });

  it("indexes artifact chunks with FTS", () => {
    const project = db.createProject("Indexing");
    db.saveArtifact({
      id: "art_1",
      projectId: project.id,
      title: "Digest",
      type: "markdown",
      path: join(dir, "digest.md"),
      mime: "text/markdown",
      hash: "abc",
      metadata: {},
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: "art_1",
      chunks: [{ text: "perovskite solar cells degrade under moisture stress" }]
    });
    expect(db.searchChunks(project.id, "moisture solar")).toHaveLength(1);
  });

  it("indexes artifact chunks with sqlite-vec when available", () => {
    const project = db.createProject("Vector search");
    db.saveArtifact({
      id: "art_vec",
      projectId: project.id,
      title: "Vector Digest",
      type: "markdown",
      path: join(dir, "vector-digest.md"),
      mime: "text/markdown",
      hash: "def",
      metadata: {},
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: "art_vec",
      chunks: [
        { text: "graph neural networks improve protein interface prediction" },
        { text: "ocean temperatures alter coastal climate risk" }
      ]
    });
    if (db.vectorSearchAvailable()) {
      const [first] = db.searchVectorChunks(project.id, "protein graph networks", 1);
      expect(first.text).toContain("protein");
    }
  });
});
