import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import { BrowserCrawlerService } from "../src/main/services/browser-crawler-service";
import { JobQueue } from "../src/main/services/job-queue";
import { PythonService } from "../src/main/services/python-service";
import { SourceRegistry } from "../src/main/sources/registry";
import type { AppSettings, CrawlConfig } from "../src/shared/schemas";

const runLiveCrawlerSmoke = process.env.PAPER_PILOT_LIVE_CRAWLER_SMOKE === "1";
const runBrowserSmoke = process.env.PAPER_PILOT_BROWSER_SMOKE === "1";
const liveIt = runLiveCrawlerSmoke ? it : it.skip;
const browserIt = runBrowserSmoke ? it : it.skip;

describe("crawler smoke tests", () => {
  liveIt("runs no-key HTTP sources without throwing", async () => {
    const registry = new SourceRegistry();
    const sourceIds = ["openalex", "crossref", "semantic-scholar", "pubmed", "arxiv", "europe-pmc", "unpaywall"] as const;
    const config: CrawlConfig = {
      topic: "graph neural networks protein folding",
      maxPapers: 1,
      sourceIds: [],
      sort: "relevance",
      openAccessOnly: true,
      allowBrowserFallback: false,
      credentialRefs: {}
    };

    const results = await Promise.all(
      sourceIds.map((sourceId) =>
        registry.run(sourceId, { ...config, sourceIds: [sourceId] }, { credentials: {}, userAgent: "PaperPilot/0.1 smoke-test" })
      )
    );

    expect(results).toHaveLength(sourceIds.length);
    expect(results.every((result) => Array.isArray(result.papers) && Array.isArray(result.warnings))).toBe(true);
    expect(results.some((result) => result.papers.length > 0 || result.warnings.length > 0)).toBe(true);
  });

  browserIt("installs Chromium on demand and extracts Scholar-shaped browser results", async () => {
    const root = await mkdtemp(join(tmpdir(), "paper-pilot-browser-smoke-"));
    let db: PaperPilotDb | undefined;
    const previousScholarUrl = process.env.PAPER_PILOT_SCHOLAR_URL;
    try {
      db = new PaperPilotDb(join(root, "paper-pilot.db"));
      const project = db.createProject("Browser crawler smoke", "fixture", {
        autoApproveScripts: true,
        autoApproveBrowserInstall: true
      });
      const fixturePath = join(root, "scholar-fixture.html");
      await writeFile(
        fixturePath,
        `<!doctype html>
<html><body>
  <div class="paper-pilot-result">
    <h3 class="paper-pilot-title"><a href="https://example.test/paper-one">Graph Neural Networks for Protein Folding</a></h3>
    <div class="paper-pilot-meta">Ada Lovelace, Grace Hopper - Journal of Useful Fixtures - 2025</div>
    <div class="paper-pilot-snippet">A fixture abstract about graph neural networks and protein folding.</div>
  </div>
  <div class="paper-pilot-result">
    <h3 class="paper-pilot-title"><a href="https://example.test/paper-two">Robust Crawlers for Research Assistants</a></h3>
    <div class="paper-pilot-meta">Katherine Johnson - Automation Letters - 2024</div>
    <div class="paper-pilot-snippet">A second fixture result.</div>
  </div>
</body></html>`,
        "utf8"
      );
      process.env.PAPER_PILOT_SCHOLAR_URL = pathToFileURL(fixturePath).href;

      const artifacts = new ArtifactService(db, root);
      const jobs = new JobQueue();
      const settings = {
        get: async (): Promise<AppSettings> => ({
          ai: {
            provider: "vercel",
            baseUrl: "https://ai-gateway.vercel.sh/v1",
            model: "openai/gpt-5.4",
            hasApiKey: false,
            reasoningEnabled: true
          },
          python: { runtimeMode: "managed", markitdownEnabled: true }
        })
      };
      const python = new PythonService(db, root, settings, artifacts, jobs);
      const browserCrawler = new BrowserCrawlerService(python);

      const result = await browserCrawler.runGoogleScholar(project.id, {
        topic: "protein folding",
        maxPapers: 2,
        sourceIds: ["google-scholar"],
        sort: "relevance",
        openAccessOnly: false,
        allowBrowserFallback: true,
        credentialRefs: {}
      });

      expect(result.warnings).toEqual([]);
      expect(result.papers.map((paper) => paper.title)).toEqual([
        "Graph Neural Networks for Protein Folding",
        "Robust Crawlers for Research Assistants"
      ]);
      expect(jobs.list(project.id)[0]?.status).toBe("completed");
      expect(db.listArtifacts(project.id)[0]?.type).toBe("crawl-log");
    } finally {
      if (previousScholarUrl === undefined) {
        delete process.env.PAPER_PILOT_SCHOLAR_URL;
      } else {
        process.env.PAPER_PILOT_SCHOLAR_URL = previousScholarUrl;
      }
      db?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
