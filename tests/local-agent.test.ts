import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { SourceRegistry } from "../src/main/sources/registry";
import type { AiService } from "../src/main/services/ai-service";
import type { CrawlService } from "../src/main/services/crawl-service";
import { JobQueue } from "../src/main/services/job-queue";
import { LocalAgentService } from "../src/main/services/local-agent-service";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-agent-"));
  db = new PaperPilotDb(join(dir, "agent.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("LocalAgentService", () => {
  it("runs an Ollama-style tool loop", async () => {
    const project = db.createProject("Local agent");
    const jobs = new JobQueue();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:0.5b" }] }), { status: 200 });
      }
      if (fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/chat")).length === 1) {
        return new Response(
          JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "list_project_state", arguments: {} } }]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          message: {
            role: "assistant",
            content: "Project state inspected."
          }
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new LocalAgentService(
      db,
      new SourceRegistry(),
      {} as CrawlService,
      {} as AiService,
      jobs,
      { baseUrl: "http://ollama.test", model: "qwen2.5:0.5b" }
    );
    expect(await agent.available()).toBe(true);
    const result = await agent.run(project.id, "What is in this project?");
    expect(result.content).toBe("Project state inspected.");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
