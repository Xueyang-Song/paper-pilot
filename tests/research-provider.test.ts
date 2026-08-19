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

  it("allows OpenAI-compatible endpoints without an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Local answer." } }] })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    await provider().stream({
      settings: settings("openai-compatible", "http://models.test/v1"),
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      signal: new AbortController().signal,
      onDelta: () => undefined
    });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("times out stalled provider requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          })
      )
    );
    await expect(
      provider(undefined, 5).stream({
        settings: settings("ollama", "http://ollama.test"),
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        signal: new AbortController().signal,
        onDelta: () => undefined
      })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("normalizes streamed OpenAI-compatible tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            [
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_corpus", arguments: '{"query":"con' } }] } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'trolled"}' } }] } }] })}`,
              "data: [DONE]",
              ""
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          )
        )
    );
    const result = await provider("key").chat({
      settings: settings("openai-compatible", "https://models.test/v1"),
      system: "system",
      messages: [{ role: "user", content: "search" }],
      tools: [
        {
          type: "function",
          function: { name: "search_corpus", description: "Search", parameters: { type: "object" } }
        }
      ],
      signal: new AbortController().signal,
      onDelta: () => undefined
    });
    expect(result).toEqual({
      content: "",
      toolCalls: [{ id: "call_1", name: "search_corpus", arguments: { query: "controlled" } }]
    });
  });

  it("does not expose raw provider error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("secret upstream payload", { status: 500, statusText: "Failure" }))
    );
    await expect(
      provider().stream({
        settings: settings("ollama", "http://ollama.test"),
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        signal: new AbortController().signal,
        onDelta: () => undefined
      })
    ).rejects.toThrow("Ollama request failed with HTTP 500 Failure.");
  });
});

function provider(apiKey?: string, timeoutMs?: number): ResearchProvider {
  return new ResearchProvider({ get: () => apiKey } as unknown as CredentialService, timeoutMs);
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
