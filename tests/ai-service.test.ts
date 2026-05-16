import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import { AiService } from "../src/main/services/ai-service";
import { JobQueue } from "../src/main/services/job-queue";
import type { AppSettings } from "../src/shared/schemas";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-ai-"));
  db = new PaperPilotDb(join(dir, "ai.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("AiService", () => {
  it("falls back to local structured synthesis when the temporary Ollama model rejects the request", async () => {
    const project = db.createProject("AI fallback project");
    db.savePaper(project.id, {
      id: "paper_ai_fallback",
      title: "Useful Paper",
      authors: [],
      year: 2025,
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                message: "AI Gateway requires a valid credit card on file to service requests.",
                type: "customer_verification_required"
              }
            }),
            { status: 403 }
          )
      )
    );
    const settings = {
      get: async (): Promise<AppSettings> => ({
        ai: {
          provider: "vercel",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          model: "openai/gpt-5.4",
          hasApiKey: true,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true }
      })
    };
    const credentials = { get: () => "test-key" };
    const jobs = new JobQueue();
    const service = new AiService(db, settings, credentials, new ArtifactService(db, dir), jobs);

    const brief = await service.generateResearchBrief(project.id, "Summarize the papers.");

    expect(brief.content).toContain("used local structured synthesis");
    expect(brief.content).toContain("Useful Paper");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        method: "POST"
      })
    );
    expect(jobs.get(brief.jobId)?.status).toBe("completed");
  });
});
