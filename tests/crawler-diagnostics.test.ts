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
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{not-json", { status: 200 })));

    await expect(getJson(new URL("https://example.test/api"), { retries: 0 })).rejects.toThrow("Malformed JSON response");
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
      expect.objectContaining({ sourceId: "openalex", status: "warning", paperCount: 1, attemptedUrl: "https://example.test/search" })
    ]);
    expect((await artifacts.readArtifact(digest!)).toString("utf8")).toContain("Source Diagnostics");
  });
});

describe("BrowserCrawlerService diagnostics", () => {
  it("parses successful multi-result browser output", async () => {
    const crawler = new BrowserCrawlerService(fakePython(JSON.stringify({ papers: [paper("One"), paper("Two")], warnings: [] })));

    const result = await crawler.runGoogleScholar("proj", browserConfig());

    expect(result.warnings).toEqual([]);
    expect(result.papers.map((item) => item.title)).toEqual(["One", "Two"]);
  });

  it("returns blocked-page warnings from browser output", async () => {
    const crawler = new BrowserCrawlerService(
      fakePython(JSON.stringify({ papers: [], warnings: ["Google Scholar returned an anti-automation or CAPTCHA page."] }))
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
