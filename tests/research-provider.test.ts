import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialService } from "../src/main/services/credential-service";
import { ResearchProvider } from "../src/main/services/research-provider";
import type { AppSettings } from "../src/shared/schemas";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResearchProvider", () => {
  it("normalizes Ollama NDJSON deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            [
              JSON.stringify({ message: { content: "First " } }),
              JSON.stringify({ message: { content: "second." }, done: true })
            ].join("\n"),
            { status: 200, headers: { "content-type": "application/x-ndjson" } }
          )
        )
    );
    const deltas: string[] = [];
    const content = await provider().stream({
      settings: settings("ollama", "http://ollama.test"),
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: (delta) => deltas.push(delta)
    });
    expect(content).toBe("First second.");
    expect(deltas).toEqual(["First ", "second."]);
  });

  it("normalizes OpenAI-compatible SSE and sends the configured key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { content: "Hosted " } }] })}`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: "answer." } }] })}`,
            "data: [DONE]",
            ""
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    const content = await provider("secret-key").stream({
      settings: settings("openai-compatible", "https://models.test/api"),
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: () => undefined
    });
    expect(content).toBe("Hosted answer.");
    expect(fetchMock.mock.calls[0][0]).toBe("https://models.test/api/v1/chat/completions");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer secret-key" });
  });

  it("propagates aborts without converting them to provider content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")));
          })
      )
    );
    const controller = new AbortController();
    const result = provider().stream({
      settings: settings("ollama", "http://ollama.test"),
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal,
      onDelta: () => undefined
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

function provider(apiKey?: string): ResearchProvider {
  return new ResearchProvider({ get: () => apiKey } as unknown as CredentialService);
}

function settings(providerName: AppSettings["ai"]["provider"], baseUrl: string): AppSettings {
  return {
    ui: { theme: "system" },
    ai: {
      provider: providerName,
      baseUrl,
      model: "test-model",
      hasApiKey: providerName !== "ollama",
      reasoningEnabled: true
    },
    python: { runtimeMode: "managed", markitdownEnabled: true },
    sources: { disabledSourceIds: [] }
  };
}
