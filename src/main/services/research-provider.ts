import type { AppSettings, Message } from "../../shared/schemas.js";
import type { CredentialService } from "./credential-service.js";

export interface ProviderChatInput {
  settings: AppSettings;
  system: string;
  messages: Array<Pick<Message, "role" | "content">>;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export class ResearchProvider {
  constructor(private readonly credentials: CredentialService) {}

  async stream(input: ProviderChatInput): Promise<string> {
    return input.settings.ai.provider === "ollama" ? this.streamOllama(input) : this.streamOpenAi(input);
  }

  private async streamOllama(input: ProviderChatInput): Promise<string> {
    const response = await fetch(`${trimTrailingSlash(input.settings.ai.baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: input.signal,
      body: JSON.stringify({
        model: input.settings.ai.model,
        stream: true,
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [{ role: "system", content: input.system }, ...input.messages]
      })
    });
    if (!response.ok) throw new Error(await responseError("Ollama", response));
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = (await response.json()) as { message?: { content?: string } };
      const content = data.message?.content ?? "";
      if (content) input.onDelta(content);
      return content;
    }
    return readLineStream(
      response,
      (line) => {
        const data = JSON.parse(line) as { message?: { content?: string } };
        return data.message?.content ?? "";
      },
      input.onDelta
    );
  }

  private async streamOpenAi(input: ProviderChatInput): Promise<string> {
    const apiKey = this.credentials.get("ai-gateway");
    if (!apiKey) throw new Error("AI Gateway API key is not configured.");
    const response = await fetch(openAiCompatibleUrl(input.settings.ai.baseUrl, "chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: input.signal,
      body: JSON.stringify({
        model: input.settings.ai.model,
        stream: true,
        messages: [{ role: "system", content: input.system }, ...input.messages],
        reasoning:
          input.settings.ai.provider === "vercel" && input.settings.ai.reasoningEnabled
            ? { effort: "medium" }
            : undefined
      })
    });
    if (!response.ok) throw new Error(await responseError("AI provider", response));
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      if (content) input.onDelta(content);
      return content;
    }
    return readLineStream(
      response,
      (line) => {
        if (!line.startsWith("data:")) return "";
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return "";
        const data = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        return data.choices?.[0]?.delta?.content ?? "";
      },
      input.onDelta
    );
  }
}

async function readLineStream(
  response: Response,
  extract: (line: string) => string,
  onDelta: (text: string) => void
): Promise<string> {
  if (!response.body) throw new Error("Provider returned an empty response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const delta = extract(trimmed);
      if (!delta) continue;
      content += delta;
      onDelta(delta);
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const delta = extract(buffer.trim());
    content += delta;
    if (delta) onDelta(delta);
  }
  return content;
}

async function responseError(label: string, response: Response): Promise<string> {
  const detail = await response.text().catch(() => "");
  return `${label} request failed ${response.status}: ${detail.slice(0, 500)}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function openAiCompatibleUrl(baseUrl: string, resource: string): string {
  const normalizedBase = trimTrailingSlash(baseUrl);
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/${resource.replace(/^\/+/, "")}`;
}
