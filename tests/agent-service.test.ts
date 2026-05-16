import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { AgentService } from "../src/main/services/agent-service";
import { ArtifactService } from "../src/main/services/artifact-service";
import type { AiService } from "../src/main/services/ai-service";
import type { CrawlService } from "../src/main/services/crawl-service";
import { JobQueue } from "../src/main/services/job-queue";
import type { LocalAgentService } from "../src/main/services/local-agent-service";

let dir: string;
let db: PaperPilotDb;
let artifacts: ArtifactService;
let jobs: JobQueue;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-agent-service-"));
  db = new PaperPilotDb(join(dir, "agent-service.db"));
  artifacts = new ArtifactService(db, dir);
  jobs = new JobQueue();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AgentService", () => {
  it("runs crawl requests through CrawlService before consulting the local agent", async () => {
    const project = db.createProject("Crawler project", "biology", { autoApproveSources: true });
    const crawl = {
      runCrawl: vi.fn(async (projectId: string) => {
        const job = jobs.create({ projectId, kind: "crawl", status: "completed", title: "Crawled biology" });
        return {
          jobId: job.id,
          papers: [
            {
              id: "paper_fixture",
              title: "Fixture Paper",
              authors: [],
              source: "openalex",
              isOpenAccess: true,
              fieldsOfStudy: []
            }
          ],
          artifacts: [],
          warnings: []
        };
      })
    } as unknown as CrawlService;
    const localAgent = {
      available: vi.fn(async () => true),
      run: vi.fn(async () => ({ content: "That paper already exists." }))
    } as unknown as LocalAgentService;
    const agent = new AgentService(db, crawl, {} as AiService, artifacts, jobs, localAgent);

    const response = await agent.handleChat({ projectId: project.id, content: "Crawl papers about biology" });

    expect(crawl.runCrawl).toHaveBeenCalledOnce();
    expect(localAgent.run).not.toHaveBeenCalled();
    expect(response.messages.at(-1)?.content).toContain("I crawled 1 open-access papers");
  });

  it("answers saved-paper questions from the app database", async () => {
    const project = db.createProject("Saved paper project", "protein folding");
    db.savePaper(project.id, {
      id: "paper_saved",
      title: "Protein Folding With Graph Neural Networks",
      authors: [],
      year: 2025,
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    const localAgent = {
      available: vi.fn(async () => true),
      run: vi.fn(async () => ({ content: "I looked in the local folder." }))
    } as unknown as LocalAgentService;
    const agent = new AgentService(db, {} as CrawlService, {} as AiService, artifacts, jobs, localAgent);

    const response = await agent.handleChat({ projectId: project.id, content: "List papers in this project" });

    expect(localAgent.run).not.toHaveBeenCalled();
    expect(response.messages.at(-1)?.content).toContain("Protein Folding With Graph Neural Networks");
    expect(response.messages.at(-1)?.content).toContain("Saved papers: **1**");
  });
});
