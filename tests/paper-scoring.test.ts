import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import type { CredentialService } from "../src/main/services/credential-service";
import { CrawlService } from "../src/main/services/crawl-service";
import { JobQueue } from "../src/main/services/job-queue";
import { PaperScoringService } from "../src/main/services/paper-scoring-service";
import { SourceRegistry } from "../src/main/sources/registry";
import type { SourceConnector } from "../src/main/sources/types";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-scoring-"));
  db = new PaperPilotDb(join(dir, "scoring.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("PaperScoringService", () => {
  it("scores papers and persists the score with the paper", () => {
    const project = db.createProject("Scoring", "graph neural networks");
    db.savePaper(project.id, {
      id: "paper_score_1",
      title: "Graph Neural Networks for Protein Interfaces",
      abstract: "A useful abstract about graph models for biological interfaces.",
      authors: ["Ada Lovelace", "Grace Hopper"],
      year: new Date().getFullYear() - 1,
      doi: "10.1000/scored",
      url: "https://example.test/scored",
      pdfUrl: "https://example.test/scored.pdf",
      source: "openalex",
      venue: "Nature Methods",
      citationCount: 250,
      isOpenAccess: true,
      fieldsOfStudy: ["Computer Science", "Biology"],
      raw: {
        authorships: [{ institutions: [{ display_name: "Stanford University" }] }]
      }
    });

    const result = new PaperScoringService(db).scoreProjectPapers(project.id);
    const [paper] = db.listPapers(project.id);

    expect(result.scoredCount).toBe(1);
    expect(paper.score?.overall).toBeGreaterThan(85);
    expect(paper.score?.label).toBe("excellent");
    expect(paper.score?.components.institution).toBeGreaterThan(80);
  });

  it("runs scoring as part of a crawl", async () => {
    const project = db.createProject("Crawl scoring", "test topic", { autoApproveSources: true });
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "Fixture OpenAlex",
        kind: "api",
        description: "fixture",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 1 }
      },
      credentialSchema: {} as SourceConnector["credentialSchema"],
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run() {
        return {
          papers: [
            {
              id: "paper_crawl_score_1",
              title: "Scored During Crawl",
              abstract: "A crawler fixture paper.",
              authors: ["Katherine Johnson"],
              year: new Date().getFullYear(),
              source: "openalex",
              venue: "Proceedings of the National Academy of Sciences",
              citationCount: 40,
              isOpenAccess: true,
              pdfUrl: "https://example.test/paper.pdf",
              fieldsOfStudy: ["Automation"],
              raw: {
                authorships: [{ institutions: [{ display_name: "Massachusetts Institute of Technology" }] }]
              }
            }
          ],
          warnings: [],
          provenance: { fixture: true }
        };
      }
    };
    const crawl = new CrawlService(
      db,
      new SourceRegistry([connector]),
      { getMany: () => ({}) } as unknown as CredentialService,
      new ArtifactService(db, dir),
      new JobQueue(),
      undefined,
      undefined,
      new PaperScoringService(db)
    );

    const result = await crawl.runCrawl(project.id, {
      topic: "test topic",
      sourceIds: ["openalex"],
      maxPapers: 1,
      openAccessOnly: true
    });

    expect(result.papers[0].score?.overall).toBeGreaterThan(70);
    expect(db.listPapers(project.id)[0].score?.version).toBe("heuristic-v1");
  });
});
