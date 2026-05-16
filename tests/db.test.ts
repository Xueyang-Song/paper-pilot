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

  it("renames projects", () => {
    const project = db.createProject("Old name", "protein");

    const renamed = db.renameProject(project.id, "New name");

    expect(renamed.title).toBe("New name");
    expect(renamed.topic).toBe("protein");
    expect(db.getProject(project.id)?.title).toBe("New name");
  });

  it("updates, pins, archives, and deletes projects", () => {
    const project = db.createProject("Draft", "topic");

    const updated = db.updateProject({
      projectId: project.id,
      title: "Updated",
      topic: "new topic",
      description: "A useful project description."
    });
    const pinned = db.setProjectPinned(project.id, true);
    const archived = db.setProjectArchived(project.id, true);

    expect(updated.title).toBe("Updated");
    expect(updated.topic).toBe("new topic");
    expect(updated.description).toBe("A useful project description.");
    expect(pinned.pinnedAt).toBeTruthy();
    expect(archived.archivedAt).toBeTruthy();

    db.deleteProject(project.id);
    expect(db.getProject(project.id)).toBeUndefined();
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

  it("updates paper metadata and user curation fields", () => {
    const project = db.createProject("Library");
    const paper = db.savePaper(project.id, {
      id: "paper_curate",
      title: "Original title",
      authors: ["Ada Lovelace"],
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });

    const updated = db.updatePaper(project.id, paper.id, {
      title: "Curated title",
      venue: "Journal of Useful Tests",
      favorite: true,
      userStatus: "read",
      tags: ["important", "methods"],
      notes: "Read before sprint planning."
    });

    expect(updated.title).toBe("Curated title");
    expect(updated.venue).toBe("Journal of Useful Tests");
    expect(updated.favorite).toBe(true);
    expect(updated.userStatus).toBe("read");
    expect(updated.tags).toEqual(["important", "methods"]);
    expect(updated.notes).toBe("Read before sprint planning.");
  });

  it("deletes paper records and artifact records", () => {
    const project = db.createProject("Delete records");
    db.savePaper(project.id, {
      id: "paper_delete",
      title: "Delete me",
      authors: [],
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    db.saveArtifact({
      id: "art_delete",
      projectId: project.id,
      title: "Temporary",
      type: "markdown",
      path: join(dir, "temporary.md"),
      mime: "text/markdown",
      hash: "abc",
      metadata: {},
      createdAt: new Date().toISOString()
    });

    db.deletePaper(project.id, "paper_delete");
    const deletedArtifact = db.deleteArtifact(project.id, "art_delete");

    expect(db.listPapers(project.id)).toHaveLength(0);
    expect(deletedArtifact.title).toBe("Temporary");
    expect(db.listArtifacts(project.id)).toHaveLength(0);
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
