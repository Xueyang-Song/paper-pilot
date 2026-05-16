import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import { SearchService } from "../src/main/services/search-service";

let dir: string;
let db: PaperPilotDb;
let artifacts: ArtifactService;
let search: SearchService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-search-"));
  db = new PaperPilotDb(join(dir, "search.db"));
  artifacts = new ArtifactService(db, dir);
  search = new SearchService(db, artifacts);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SearchService", () => {
  it("searches indexed artifacts across global, project, and file scopes", async () => {
    const crispr = db.createProject("CRISPR delivery");
    const materials = db.createProject("Materials");
    const digest = await artifacts.writeArtifact({
      projectId: crispr.id,
      type: "markdown",
      title: "Lipid nanoparticle digest",
      content: "CRISPR lipid nanoparticles improve liver delivery and reduce off-target exposure."
    });
    await artifacts.writeArtifact({
      projectId: materials.id,
      type: "markdown",
      title: "Perovskite digest",
      content: "Perovskite solar cells degrade when moisture stress enters the lattice."
    });

    const projectResults = search.search({
      query: "lipid nanoparticles",
      scope: { type: "project", projectId: crispr.id },
      limit: 10
    });
    expect(projectResults.results[0]).toMatchObject({ kind: "chunk", artifactId: digest.id, projectId: crispr.id });
    expect(projectResults.results[0].snippet).toContain("[[");

    const globalResults = search.search({
      query: "moisture lattice",
      scope: { type: "global" },
      limit: 10
    });
    expect(globalResults.results[0]).toMatchObject({ kind: "chunk", projectId: materials.id });

    const fileResults = search.search({
      query: "moisture",
      scope: { type: "file", projectId: crispr.id, artifactId: digest.id },
      limit: 10
    });
    expect(fileResults.results).toHaveLength(0);
  });

  it("reindexes files that were saved before search indexing", async () => {
    const project = db.createProject("Old project");
    const artifact = await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Legacy notes",
      content: "Graph neural retrieval finds protein interface evidence.",
      indexText: false
    });

    expect(
      search.search({ query: "protein interface", scope: { type: "project", projectId: project.id }, limit: 10 }).results
    ).toHaveLength(0);

    const reindexed = await search.reindex({ projectId: project.id });
    expect(reindexed).toMatchObject({ artifactCount: 1, paperCount: 0 });
    expect(reindexed.chunkCount).toBeGreaterThan(0);

    const results = search.search({
      query: "protein interface",
      scope: { type: "file", projectId: project.id, artifactId: artifact.id },
      limit: 10
    });
    expect(results.results[0]).toMatchObject({ kind: "chunk", artifactId: artifact.id });
  });

  it("returns indexed page metadata for file hits", () => {
    const project = db.createProject("PDF pages");
    db.saveArtifact({
      id: "art_page",
      projectId: project.id,
      title: "Paged paper",
      type: "paper-pdf",
      path: join(dir, "paged-paper.pdf"),
      mime: "application/pdf",
      hash: "paged-hash",
      metadata: {},
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: "art_page",
      chunks: [{ text: "Methods section discusses nanoparticle delivery.", metadata: { page: 7 } }]
    });

    const results = search.search({
      query: "nanoparticle delivery",
      scope: { type: "file", projectId: project.id, artifactId: "art_page" },
      limit: 10
    });
    expect(results.results[0]).toMatchObject({ artifactId: "art_page", page: 7 });
  });

  it("searches paper metadata as first-class results", () => {
    const project = db.createProject("Protein design");
    const paperId = "paper_search";
    db.savePaper(project.id, {
      id: paperId,
      title: "Protein folding with graph networks",
      abstract: "AlphaFold embeddings improve structure-aware interface ranking.",
      authors: ["Ada Lovelace"],
      source: "semantic-scholar",
      isOpenAccess: true,
      fieldsOfStudy: ["Biology"]
    });
    db.saveArtifact({
      id: "art_paper_search",
      projectId: project.id,
      title: "Protein folding PDF",
      type: "paper-pdf",
      path: join(dir, "protein-folding.pdf"),
      mime: "application/pdf",
      hash: "paper-hash",
      metadata: { paperId },
      createdAt: new Date().toISOString()
    });

    const results = search.search({
      query: "alphafold embeddings",
      scope: { type: "project", projectId: project.id },
      limit: 10
    });
    expect(results.results[0]).toMatchObject({ kind: "paper", paperId, artifactId: "art_paper_search" });
  });
});
