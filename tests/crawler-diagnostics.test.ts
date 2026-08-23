import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import { BrowserCrawlerService } from "../src/main/services/browser-crawler-service";
import { CrawlService } from "../src/main/services/crawl-service";
import { JobQueue } from "../src/main/services/job-queue";
import { SourceRegistry } from "../src/main/sources/registry";
import type { SourceConnector } from "../src/main/sources/types";
import { getJson } from "../src/main/sources/http";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-crawler-diagnostics-"));
  db = new PaperPilotDb(join(dir, "crawler.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("crawler request helpers", () => {
  it("retries retryable HTTP failures before returning JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson(new URL("https://example.test/api"), { retries: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies malformed JSON as a readable crawler error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{not-json", { status: 200 }))
    );

    await expect(getJson(new URL("https://example.test/api"), { retries: 0 })).rejects.toThrow(
      "Malformed JSON response"
    );
  });

  it("retries timeout-style failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getJson(new URL("https://example.test/api"), { retries: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("crawler diagnostics", () => {
  it("stores per-source diagnostics in crawl metadata and digest artifacts", async () => {
    const project = db.createProject("Diagnostics", "protein", { autoApproveSources: true });
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "OpenAlex",
        kind: "api",
        description: "Fixture connector",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 60 }
      },
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run() {
        return {
          papers: [
            {
              id: "paper_diag",
              title: "Diagnostic Paper",
              authors: [],
              source: "openalex",
              isOpenAccess: true,
              fieldsOfStudy: []
            }
          ],
          warnings: ["fixture warning"],
          provenance: { searchUrl: "https://example.test/search" }
        };
      }
    };
    const artifacts = new ArtifactService(db, dir);
    const crawl = new CrawlService(
      db,
      new SourceRegistry([connector]),
      { getMany: () => ({}) },
      artifacts,
      new JobQueue(),
      undefined,
      undefined,
      undefined
    );

    await crawl.runCrawl(project.id, {
      topic: "protein",
      sourceIds: ["openalex"],
      maxPapers: 1,
      openAccessOnly: false
    });

    const metadata = db.listArtifacts(project.id).find((artifact) => artifact.type === "metadata-json");
    const digest = db.listArtifacts(project.id).find((artifact) => artifact.type === "markdown");
    expect(metadata?.metadata.sourceDiagnostics).toEqual([
      expect.objectContaining({
        sourceId: "openalex",
        status: "warning",
        paperCount: 1,
        attemptedUrl: "https://example.test/search"
      })
    ]);
    expect((await artifacts.readArtifact(digest!)).toString("utf8")).toContain("Source Diagnostics");
  });

  it("captures active-review candidates before filtering and keeps metadata-only records by default", async () => {
    const project = db.createProject("Review crawl", "intervention", { autoApproveSources: true });
    db.savePaper(project.id, {
      id: "existing",
      title: "Existing trial",
      authors: ["A. Researcher"],
      year: 2024,
      doi: "10.1000/existing",
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id, researchQuestion: "Which trials are relevant?" });
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "OpenAlex",
        kind: "api",
        description: "Fixture connector",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 60 }
      },
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run(config) {
        expect(config.openAccessOnly).toBe(false);
        return {
          papers: [
            {
              id: "same_doi",
              title: "Existing trial",
              abstract: "Enriched abstract",
              authors: ["A. Researcher"],
              year: 2024,
              doi: "https://doi.org/10.1000/existing",
              source: "openalex",
              sourcePaperId: "W1",
              isOpenAccess: false,
              fieldsOfStudy: []
            },
            {
              id: "metadata_only",
              title: "Paywalled but screenable",
              authors: ["B. Researcher"],
              year: 2025,
              source: "openalex",
              sourcePaperId: "W2",
              isOpenAccess: false,
              fieldsOfStudy: []
            }
          ],
          warnings: [],
          provenance: {}
        };
      }
    };
    const crawl = new CrawlService(
      db,
      new SourceRegistry([connector]),
      { getMany: () => ({}) },
      new ArtifactService(db, dir),
      new JobQueue()
    );

    const result = await crawl.runCrawl(project.id, {
      topic: "intervention",
      sourceIds: ["openalex"],
      maxPapers: 10
    });

    expect(result.papers.map((paper) => paper.title)).toContain("Paywalled but screenable");
    const crawlBatch = db.listDiscoveryBatches(review.id).find((batch) => batch.kind === "crawl");
    expect(crawlBatch).toMatchObject({
      status: "completed",
      counts: { identified: 2, filtered: 0, merged: 1, newRecords: 1 }
    });
    expect(db.listReviewCandidateOrigins(review.id, crawlBatch!.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: "merged", sourceRecordId: "W1" }),
        expect.objectContaining({ resolution: "created", sourceRecordId: "W2" })
      ])
    );
  });

  it("uses staged identity matching and retains stronger crawler identifiers with occurrence provenance", async () => {
    const project = db.createProject("Identity crawl", "identity", { autoApproveSources: true });
    db.savePaper(project.id, {
      id: "fingerprint-record",
      title: "A staged identity study",
      authors: ["Doe, Jane"],
      year: 2024,
      source: "crossref",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id });
    let calls = 0;
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "OpenAlex",
        kind: "api",
        description: "Identity fixture",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 60 }
      },
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run() {
        calls += 1;
        return {
          papers: [
            {
              id: `openalex-${calls}`,
              title: calls === 1 ? "A staged identity study" : "Updated connector title",
              abstract: "Connector metadata",
              authors: ["Jane Doe"],
              year: 2024,
              doi: calls === 1 ? "10.1000/staged" : undefined,
              source: "openalex",
              sourcePaperId: "W-STRONG",
              isOpenAccess: false,
              fieldsOfStudy: []
            }
          ],
          warnings: [],
          provenance: {}
        };
      }
    };
    const crawl = new CrawlService(
      db,
      new SourceRegistry([connector]),
      { getMany: () => ({}) },
      new ArtifactService(db, dir),
      new JobQueue()
    );
    const config = { topic: "identity", sourceIds: ["openalex" as const], maxPapers: 5 };

    const first = await crawl.runCrawl(project.id, config);
    const enriched = db.getPaper(project.id, "fingerprint-record");
    expect(first.papers).toHaveLength(1);
    expect(enriched).toMatchObject({
      id: "fingerprint-record",
      source: "crossref",
      doi: "10.1000/staged",
      abstract: "Connector metadata"
    });
    expect(enriched?.sourcePaperId).toBeUndefined();
    expect(enriched?.raw?.identitySourceIdentifiers).toEqual([{ authority: "openalex", identifier: "w-strong" }]);

    const second = await crawl.runCrawl(project.id, config);
    expect(second.papers).toEqual([expect.objectContaining({ id: "fingerprint-record" })]);
    expect(db.listPapers(project.id)).toHaveLength(1);
    const crawlBatches = db.listDiscoveryBatches(review.id).filter((batch) => batch.kind === "crawl");
    expect(crawlBatches).toHaveLength(2);
    const mergedBatch = crawlBatches.find((batch) => batch.counts.merged === 1)!;
    const duplicateBatch = crawlBatches.find((batch) => batch.counts.duplicates === 1)!;
    expect(mergedBatch.counts).toMatchObject({ merged: 1, newRecords: 0 });
    expect(duplicateBatch.counts).toMatchObject({ duplicates: 1, newRecords: 0 });
    expect(db.listReviewCandidateOrigins(review.id, mergedBatch.id)[0]).toMatchObject({
      paperId: "fingerprint-record",
      matchedPaperId: "fingerprint-record",
      sourceRecordId: "W-STRONG",
      resolution: "merged"
    });
    expect(db.listReviewCandidateOrigins(review.id, duplicateBatch.id)[0]).toMatchObject({
      paperId: "fingerprint-record",
      matchedPaperId: "fingerprint-record",
      sourceRecordId: "W-STRONG",
      resolution: "duplicate"
    });
  });

  it("preserves partial discovery counts when candidate persistence fails mid-source", async () => {
    const project = db.createProject("Partial crawl", "partial", { autoApproveSources: true });
    const review = db.createReview({ projectId: project.id });
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "OpenAlex",
        kind: "api",
        description: "Partial failure fixture",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 60 }
      },
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run() {
        return {
          papers: [
            {
              id: "partial-one",
              title: "First persisted candidate",
              authors: ["Jane Doe"],
              year: 2024,
              source: "openalex",
              sourcePaperId: "W-PARTIAL-1",
              isOpenAccess: false,
              fieldsOfStudy: []
            },
            {
              id: "partial-two",
              title: "Second failed candidate",
              authors: ["John Doe"],
              year: 2024,
              source: "openalex",
              sourcePaperId: "W-PARTIAL-2",
              isOpenAccess: false,
              fieldsOfStudy: []
            }
          ],
          warnings: [],
          provenance: {}
        };
      }
    };
    const savePaper = db.savePaper.bind(db);
    let calls = 0;
    vi.spyOn(db, "savePaper").mockImplementation((projectId, candidate) => {
      calls += 1;
      if (calls === 2) throw new Error("fixture persistence failure");
      return savePaper(projectId, candidate);
    });
    const crawl = new CrawlService(
      db,
      new SourceRegistry([connector]),
      { getMany: () => ({}) },
      new ArtifactService(db, dir),
      new JobQueue()
    );

    const result = await crawl.runCrawl(project.id, {
      topic: "partial",
      sourceIds: ["openalex"],
      maxPapers: 5
    });

    expect(result.warnings).toContain("OpenAlex: fixture persistence failure");
    const batch = db.listDiscoveryBatches(review.id).find((candidate) => candidate.kind === "crawl")!;
    expect(batch).toMatchObject({
      status: "failed",
      counts: { identified: 2, newRecords: 1, filtered: 0, duplicates: 0, merged: 0 }
    });
    expect(db.listReviewCandidateOrigins(review.id, batch.id)).toEqual([
      expect.objectContaining({ paperId: "partial-one", resolution: "created" })
    ]);
  });
});

describe("BrowserCrawlerService diagnostics", () => {
  it("parses successful multi-result browser output", async () => {
    const crawler = new BrowserCrawlerService(
      fakePython(JSON.stringify({ papers: [paper("One"), paper("Two")], warnings: [] }))
    );

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.warnings).toEqual([]);
    expect(result.papers.map((item) => item.title)).toEqual(["One", "Two"]);
  });

  it("returns blocked-page warnings from browser output", async () => {
    const crawler = new BrowserCrawlerService(
      fakePython(
        JSON.stringify({ papers: [], warnings: ["Google Scholar returned an anti-automation or CAPTCHA page."] })
      )
    );

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("CAPTCHA");
  });

  it("returns empty-page warnings from browser output", async () => {
    const crawler = new BrowserCrawlerService(
      fakePython(JSON.stringify({ papers: [], warnings: ["Timed out waiting for search results."] }))
    );

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("Timed out");
  });

  it("does not throw on malformed browser JSON output", async () => {
    const crawler = new BrowserCrawlerService(fakePython("{not-json}"));

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("malformed JSON");
  });

  it("does not throw when browser output has no JSON result", async () => {
    const crawler = new BrowserCrawlerService(fakePython("plain output", "playwright failed", "failed"));

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("no JSON output");
  });

  it("classifies missing Playwright Chromium diagnostics", async () => {
    const stderr = "browserType.launch: Executable doesn't exist. Please run: playwright install chromium";
    const crawler = new BrowserCrawlerService(fakePython("", stderr, "failed"));

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("Chromium is not installed");
  });

  it("classifies browser launch diagnostics", async () => {
    const stderr = "TargetClosedError: Browser failed to launch because host system is missing dependencies";
    const crawler = new BrowserCrawlerService(fakePython("", stderr, "failed"));

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.papers).toEqual([]);
    expect(result.warnings[0]).toContain("could not launch Chromium");
  });
});

function fakePython(stdout: string, stderr = "", status: "completed" | "waiting-approval" | "failed" = "completed") {
  return {
    runProjectScript: async () => ({ jobId: "job_browser", status, stdout, stderr })
  } as never;
}

function browserConfig() {
  return {
    topic: "protein",
    maxPapers: 2,
    sourceIds: ["google-scholar" as const],
    sort: "relevance" as const,
    openAccessOnly: false,
    allowBrowserFallback: true,
    credentialRefs: {}
  };
}

function paper(title: string) {
  return {
    title,
    authors: [],
    source: "google-scholar",
    isOpenAccess: false,
    fieldsOfStudy: []
  };
}
