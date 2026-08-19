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
  it("uses the selected Ollama provider for briefs", async () => {
    const project = seedProject();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://ollama.test/api/chat");
      return new Response(JSON.stringify({ message: { content: "Ollama brief" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = serviceWithSettings({
      ai: {
        provider: "ollama",
        baseUrl: "http://ollama.test",
        model: "gemma3:12b-it-qat",
        hasApiKey: false,
        reasoningEnabled: true
      },
      python: { runtimeMode: "managed", markitdownEnabled: true }
    });

    const brief = await service.generateResearchBrief(project.id, "Summarize the papers.");

    expect(brief.content).toBe("Ollama brief");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the selected gateway provider instead of forcing Ollama", async () => {
    const project = seedProject();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
      return new Response(JSON.stringify({ choices: [{ message: { content: "Gateway brief" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = serviceWithSettings(
      {
        ai: {
          provider: "vercel",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          model: "openai/gpt-5.4",
          hasApiKey: true,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true }
      },
      "test-key"
    );

    const brief = await service.generateResearchBrief(project.id, "Summarize the papers.");

    expect(brief.content).toBe("Gateway brief");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falls back to local structured synthesis and records provider metadata on model failure", async () => {
    const project = seedProject();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("verification required", { status: 403 }))
    );
    const service = serviceWithSettings(
      {
        ai: {
          provider: "vercel",
          baseUrl: "https://ai-gateway.vercel.sh/v1",
          model: "openai/gpt-5.4",
          hasApiKey: true,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true }
      },
      "test-key"
    );

    const brief = await service.generateResearchBrief(project.id, "Summarize the papers.");
    const artifact = db.listArtifacts(project.id).find((item) => item.id === brief.artifactId);

    expect(brief.content).toContain("used local structured synthesis");
    expect(brief.content).toContain("Useful Paper");
    expect(artifact?.metadata).toMatchObject({
      provider: "vercel",
      model: "local-structured",
      attemptedModel: "openai/gpt-5.4",
      providerError: expect.stringContaining("AI Gateway request failed 403")
    });
  });

  it("checks Ollama health without generating text", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://ollama.test/api/tags");
      return new Response(JSON.stringify({ models: [{ name: "gemma3:12b-it-qat" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const health = await serviceWithSettings({
      ai: {
        provider: "ollama",
        baseUrl: "http://ollama.test",
        model: "gemma3:12b-it-qat",
        hasApiKey: false,
        reasoningEnabled: true
      },
      python: { runtimeMode: "managed", markitdownEnabled: true }
    }).checkProvider();

    expect(health).toMatchObject({ provider: "ollama", reachable: true, status: "ok" });
    expect(health.models).toEqual(["gemma3:12b-it-qat"]);
  });

  it("warns when Ollama is reachable but has no installed models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
    );

    const health = await serviceWithSettings({
      ai: {
        provider: "ollama",
        baseUrl: "http://ollama.test",
        model: "gemma3:12b-it-qat",
        hasApiKey: false,
        reasoningEnabled: true
      },
      python: { runtimeMode: "managed", markitdownEnabled: true }
    }).checkProvider();

    expect(health).toMatchObject({ provider: "ollama", reachable: true, status: "warning" });
    expect(health.detail).toContain("no models");
  });

  it("checks gateway health with a non-generating model-list request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://gateway.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.4" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const health = await serviceWithSettings(
      {
        ai: {
          provider: "openai-compatible",
          baseUrl: "https://gateway.test/v1",
          model: "openai/gpt-5.4",
          hasApiKey: true,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true }
      },
      "test-key"
    ).checkProvider();

    expect(health).toMatchObject({ provider: "openai-compatible", reachable: true, status: "ok", hasApiKey: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.test/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("preserves nested OpenAI-compatible base paths", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://gateway.test/proxy/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await serviceWithSettings(
      {
        ai: {
          provider: "openai-compatible",
          baseUrl: "https://gateway.test/proxy/v1",
          model: "model-a",
          hasApiKey: true,
          reasoningEnabled: true
        },
        python: { runtimeMode: "managed", markitdownEnabled: true }
      },
      "test-key"
    ).checkProvider();
  });

  it("reports a warning for keyed providers without a stored key", async () => {
    const health = await serviceWithSettings({
      ai: {
        provider: "vercel",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        model: "openai/gpt-5.4",
        hasApiKey: false,
        reasoningEnabled: true
      },
      python: { runtimeMode: "managed", markitdownEnabled: true }
    }).checkProvider();

    expect(health).toMatchObject({ provider: "vercel", reachable: false, status: "warning", hasApiKey: false });
  });
});

function seedProject() {
  const project = db.createProject("AI provider project");
  db.savePaper(project.id, {
    id: "paper_ai_provider",
    title: "Useful Paper",
    authors: [],
    year: 2025,
    source: "openalex",
    isOpenAccess: true,
    fieldsOfStudy: []
  });
  return project;
}

function serviceWithSettings(settingsValue: AppSettings, apiKey?: string): AiService {
  const settings = { get: async (): Promise<AppSettings> => settingsValue };
  const credentials = {
    get: () => apiKey,
    has: () => Boolean(apiKey)
  };
  return new AiService(db, settings, credentials, new ArtifactService(db, dir), new JobQueue());
}
