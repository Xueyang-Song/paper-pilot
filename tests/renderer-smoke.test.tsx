// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Start a research project")).toBeTruthy();
    expect(screen.getAllByText("Artifacts").length).toBeGreaterThan(0);
  });
});
