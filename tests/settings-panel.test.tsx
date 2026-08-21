// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperPilotApi } from "../src/preload/index";
import { SettingsPanel } from "../src/renderer/components/settings-panel";
import type { AppSettings } from "../src/shared/schemas";

const settings: AppSettings = {
  ui: { theme: "system" },
  ai: {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "missing-model",
    hasApiKey: false,
    reasoningEnabled: true
  },
  python: { runtimeMode: "managed", markitdownEnabled: true },
  sources: { disabledSourceIds: [] }
};

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AI provider settings", () => {
  it("loads installed Ollama models and saves the exact discovered identifier", async () => {
    const api = createApiMock();
    Object.defineProperty(window, "paperPilot", { configurable: true, value: api });

    renderSettings();

    await waitFor(() =>
      expect(api.listAiModels).toHaveBeenCalledWith({
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434"
      })
    );
    expect(await screen.findByText("Exact model: qwen3.8:latest")).toBeTruthy();
    expect(screen.queryByDisplayValue("missing-model")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        ai: expect.objectContaining({
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "qwen3.8:latest"
        })
      })
    );
  });

  it("shows a useful discovery error when Ollama cannot be reached", async () => {
    const api = createApiMock();
    vi.mocked(api.listAiModels).mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
    Object.defineProperty(window, "paperPilot", { configurable: true, value: api });

    renderSettings();

    expect(await screen.findByText("Could not load Ollama models")).toBeTruthy();
    expect(screen.getByText(/connect ECONNREFUSED/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save AI settings" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function renderSettings(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPanel
        open
        sources={[]}
        themePreference="system"
        isThemeSaving={false}
        onThemeChange={vi.fn()}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
}

function createApiMock(): PaperPilotApi {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    listCredentialFlags: vi.fn().mockResolvedValue([]),
    getUpdateStatus: vi.fn().mockResolvedValue({
      state: "idle",
      currentVersion: "0.0.0-development",
      retryCount: 0
    }),
    onUpdateStatusChanged: vi.fn().mockReturnValue(() => undefined),
    listAiModels: vi.fn().mockResolvedValue({
      provider: "ollama",
      baseUrl: settings.ai.baseUrl,
      fetchedAt: "2026-08-20T00:00:00.000Z",
      models: [
        {
          id: "qwen3.8:latest",
          name: "qwen3.8:latest",
          sizeBytes: 17_741_872_154,
          parameterSize: "27.3B",
          quantizationLevel: "Q4_K_M"
        }
      ]
    }),
    updateSettings: vi.fn().mockResolvedValue(settings),
    checkAiProvider: vi.fn()
  } as unknown as PaperPilotApi;
}
