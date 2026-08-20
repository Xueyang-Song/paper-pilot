import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import type { CredentialService } from "../src/main/services/credential-service";
import { ResearchChatService } from "../src/main/services/research-chat-service";
import type { SettingsService } from "../src/main/services/settings-service";
import { SourceRegistry } from "../src/main/sources/registry";
import type { AppSettings, ChatRunEvent } from "../src/shared/schemas";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-research-chat-"));
  db = new PaperPilotDb(join(dir, "chat.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ResearchChatService", () => {
  it("streams a grounded answer, persists citations, and creates one non-indexed artifact", async () => {
    const { projectId, conversationId } = seedProject();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `${JSON.stringify({ message: { content: "The study reports a measured improvement under controlled conditions. [[S1]]" } })}\n`,
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )
        )
    );
    const service = createService();
    const events: ChatRunEvent[] = [];
    const complete = terminalEvent(events);

    const started = await service.start(
      {
        projectId,
        conversationId,
        content: "What improvement does the study report?",
        mode: "grounded",
        sourceRefs: []
      },
      (event) => events.push(event)
    );
    const terminal = await complete;

    expect(terminal.type).toBe("complete");
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(db.getChatRun(started.runId)?.status).toBe("completed");
    expect(db.listCitations(started.runId)).toHaveLength(1);
    const answers = db.listArtifacts(projectId).filter((artifact) => artifact.type === "chat-answer");
    expect(answers).toHaveLength(1);
    expect(db.searchChunks(projectId, "controlled improvement")).toHaveLength(0);
  });

  it("repairs an invalid grounded citation once", async () => {
    const { projectId, conversationId } = seedProject();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ message: { content: "The study reports a measured improvement under controlled conditions. [[S9]]" } })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ message: { content: "The study reports a measured improvement under controlled conditions. [[S1]]" } })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = createService();
    const events: ChatRunEvent[] = [];
    const complete = terminalEvent(events);

    const started = await service.start(
      { projectId, conversationId, content: "Summarize the measured improvement", mode: "grounded", sourceRefs: [] },
      (event) => events.push(event)
    );
    await complete;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.listCitations(started.runId)[0].evidenceId).toBe("S1");
    expect(db.getChatRun(started.runId)?.trace.some((step) => step.label === "Repairing citation coverage")).toBe(true);
  });

  it("returns insufficient evidence without calling a provider", async () => {
    const project = db.createProject("Empty project");
    const conversation = db.ensureDefaultConversation(project.id);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createService();
    const events: ChatRunEvent[] = [];
    const complete = terminalEvent(events);

    await service.start(
      {
        projectId: project.id,
        conversationId: conversation.id,
        content: "What does the evidence show?",
        mode: "grounded",
        sourceRefs: []
      },
      (event) => events.push(event)
    );
    const terminal = await complete;

    expect(terminal.type).toBe("complete");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.listMessages(project.id, conversation.id).at(-1)?.content).toContain("Insufficient project evidence");
  });

  it("fails closed after one unsuccessful citation repair", async () => {
    const { projectId, conversationId } = seedProject();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `${JSON.stringify({ message: { content: "This unsupported research claim remains long enough to require coverage. [[S99]]" } })}\n`,
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )
        )
    );
    const service = createService();
    const events: ChatRunEvent[] = [];
    const terminalPromise = terminalEvent(events);
    const started = await service.start(
      { projectId, conversationId, content: "Make an unsupported claim", mode: "grounded", sourceRefs: [] },
      (event) => events.push(event)
    );
    const terminal = await terminalPromise;

    expect(terminal).toMatchObject({ type: "error", status: "failed" });
    expect(db.getChatRun(started.runId)?.status).toBe("failed");
    expect(db.listArtifacts(projectId).filter((artifact) => artifact.type === "chat-answer")).toHaveLength(0);
  });

  it("stops an active provider request and keeps no generated artifact", async () => {
    const { projectId, conversationId } = seedProject();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new DOMException("Stopped", "AbortError"));
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")));
          })
      )
    );
    const service = createService();
    const events: ChatRunEvent[] = [];
    const terminalPromise = terminalEvent(events);
    const started = await service.start(
      { projectId, conversationId, content: "Stream until stopped", mode: "grounded", sourceRefs: [] },
      (event) => events.push(event)
    );
    expect(service.cancel(started.runId)).toBe(true);
    const terminal = await terminalPromise;

    expect(terminal).toMatchObject({ type: "error", status: "stopped" });
    expect(db.getChatRun(started.runId)?.status).toBe("stopped");
    expect(db.listArtifacts(projectId).filter((artifact) => artifact.type === "chat-answer")).toHaveLength(0);
  });

  it("executes the same trusted corpus tool through the provider loop", async () => {
    const { projectId, conversationId } = seedProject();
    db.savePaper(projectId, {
      id: "paper_beta",
      title: "Beta response",
      abstract: "Beta response evidence is distinct from the controlled improvement study.",
      authors: ["Beta Author"],
      source: "crossref",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "search_corpus", arguments: { query: "controlled improvement" } } }] } })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          `${JSON.stringify({ message: { content: "The controlled study reports a measured improvement. [[S2]]" } })}\n`,
          { status: 200, headers: { "content-type": "application/x-ndjson" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = createService();
    const events: ChatRunEvent[] = [];
    const terminalPromise = terminalEvent(events);
    const started = await service.start(
      {
        projectId,
        conversationId,
        content: "Explain the beta response after searching",
        mode: "grounded",
        sourceRefs: []
      },
      (event) => events.push(event)
    );
    await terminalPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondRequest.messages.find((message) => message.role === "tool")?.content).toContain('"evidenceId":"S2"');
    expect(db.getChatRun(started.runId)?.trace.some((step) => step.toolName === "search_corpus")).toBe(true);
    expect(db.listCitations(started.runId)).toMatchObject([{ evidenceId: "S2", paperId: "paper_1" }]);
  });

  it("uses the shared safe tool executor for explicit source-list requests", async () => {
    const project = db.createProject("Sources project");
    const conversation = db.ensureDefaultConversation(project.id);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createService(new SourceRegistry());
    const events: ChatRunEvent[] = [];
    const terminalPromise = terminalEvent(events);
    const started = await service.start(
      {
        projectId: project.id,
        conversationId: conversation.id,
        content: "List the available scholarly sources",
        mode: "grounded",
        sourceRefs: []
      },
      (event) => events.push(event)
    );
    await terminalPromise;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.getChatRun(started.runId)?.trace.slice(0, 2)).toMatchObject([
      { toolName: "list_sources", status: "running" },
      { toolName: "list_sources", status: "completed" }
    ]);
    expect(db.listMessages(project.id, conversation.id).at(-1)?.content).toContain("Scholarly sources");
  });
});

function seedProject(): { projectId: string; conversationId: string } {
  const project = db.createProject("Evidence project");
  db.savePaper(project.id, {
    id: "paper_1",
    title: "Controlled improvement study",
    abstract: "The study reports a measured improvement under controlled conditions with an explicit comparison group.",
    authors: ["Ada Author"],
    source: "openalex",
    isOpenAccess: true,
    fieldsOfStudy: []
  });
  return { projectId: project.id, conversationId: db.ensureDefaultConversation(project.id).id };
}

function createService(registry?: SourceRegistry): ResearchChatService {
  const settings: AppSettings = {
    ui: { theme: "system" },
    ai: {
      provider: "ollama",
      baseUrl: "http://ollama.test",
      model: "test-model",
      hasApiKey: false,
      reasoningEnabled: false
    },
    python: { runtimeMode: "managed", markitdownEnabled: true },
    sources: { disabledSourceIds: [] }
  };
  return new ResearchChatService(
    db,
    new ArtifactService(db, dir),
    { get: async () => settings } as SettingsService,
    { get: () => undefined } as unknown as CredentialService,
    registry
  );
}

function terminalEvent(events: ChatRunEvent[]): Promise<ChatRunEvent> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const event = events.find((candidate) => candidate.type === "complete" || candidate.type === "error");
      if (!event) return;
      clearInterval(interval);
      resolve(event);
    }, 5);
  });
}
