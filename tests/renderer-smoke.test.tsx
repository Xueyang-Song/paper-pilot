// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperPilotApi } from "../src/preload/index";
import type { AppSettings } from "../src/shared/schemas";
import { Root } from "../src/renderer/App";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn()
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "pdf.worker.mjs" }));

const settings: AppSettings = {
  ui: { theme: "system" },
  ai: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "gemma3:12b-it-qat",
    hasApiKey: false,
    reasoningEnabled: true
  },
  python: {
    runtimeMode: "managed",
    markitdownEnabled: true
  },
  sources: {
    disabledSourceIds: []
  }
};

function createApiMock(): PaperPilotApi {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    listSources: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue(settings),
    setTitleBarTheme: vi.fn().mockResolvedValue(undefined),
    checkAiProvider: vi.fn().mockResolvedValue({
      provider: "ollama",
      baseUrl: settings.ai.baseUrl,
      model: settings.ai.model,
      hasApiKey: false,
      reachable: false,
      status: "warning",
      checkedAt: "2026-08-19T00:00:00.000Z",
      models: []
    }),
    listCredentialFlags: vi.fn().mockResolvedValue([]),
    getUpdateStatus: vi.fn().mockResolvedValue({
      state: "idle",
      currentVersion: "0.0.0-development",
      retryCount: 0
    }),
    platform: vi.fn().mockResolvedValue("win32"),
    onJobChanged: vi.fn().mockReturnValue(() => undefined),
    onChatRunEvent: vi.fn().mockReturnValue(() => undefined),
    onUpdateStatusChanged: vi.fn().mockReturnValue(() => undefined)
  } as unknown as PaperPilotApi;
}

beforeEach(() => {
  Object.defineProperty(window, "paperPilot", {
    configurable: true,
    value: createApiMock()
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  });
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("renderer app shell", () => {
  it("loads the primary research workspace surfaces", async () => {
    render(<Root />);

    expect(await screen.findByText("Paper Pilot")).toBeTruthy();
    expect(screen.getAllByText("Projects").length).toBeGreaterThan(0);
    expect(screen.getByText("Ask the project, inspect the evidence")).toBeTruthy();
    expect(screen.getAllByText("Artifacts").length).toBeGreaterThan(0);
  });

  it("shows named grounded chats, source pins, and generated answers", async () => {
    const project = {
      id: "project_1",
      title: "Evidence project",
      topic: "evidence",
      createdAt: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T00:00:00.000Z",
      policy: {
        autonomy: "project" as const,
        autoApproveSources: false,
        autoApproveScripts: false,
        autoApproveBrowserInstall: false,
        maxCrawlPapers: 50,
        warnOnPaidModelRuns: true
      }
    };
    const conversation = {
      id: "conversation_1",
      projectId: project.id,
      title: "Evidence chat",
      mode: "grounded" as const,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
    const paper = {
      id: "paper_1",
      projectId: project.id,
      title: "Inspectable source paper",
      authors: [],
      source: "openalex" as const,
      isOpenAccess: true,
      fieldsOfStudy: []
    };
    const answer = {
      id: "answer_1",
      projectId: project.id,
      type: "chat-answer" as const,
      title: "Answer — Evidence",
      path: "C:/data/answer.md",
      mime: "text/markdown",
      hash: "hash",
      source: "research-chat",
      metadata: {},
      createdAt: project.createdAt
    };
    const api = createApiMock();
    api.listProjects = vi.fn().mockResolvedValue([project]);
    api.getProjectBundle = vi.fn().mockResolvedValue({
      project,
      conversations: [conversation],
      messages: [],
      papers: [paper],
      artifacts: [answer],
      jobs: []
    });
    api.listConversations = vi.fn().mockResolvedValue([conversation]);
    api.listConversationMessages = vi.fn().mockResolvedValue([]);
    api.listChatRuns = vi.fn().mockResolvedValue([]);
    api.updateConversation = vi.fn().mockResolvedValue({ ...conversation, mode: "exploratory" });
    Object.defineProperty(window, "paperPilot", { configurable: true, value: api });

    render(<Root />);

    expect(await screen.findByText("Evidence chat")).toBeTruthy();
    expect(await screen.findByText(/Generated answers/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add sources/i }));
    expect(await screen.findByText("Inspectable source paper")).toBeTruthy();
    fireEvent.click(screen.getByText("Inspectable source paper"));
    expect(screen.getAllByText("Inspectable source paper").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "exploratory" }));
    await waitFor(() =>
      expect(api.updateConversation).toHaveBeenCalledWith({ conversationId: conversation.id, mode: "exploratory" })
    );
  });
});
