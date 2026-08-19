import type { AppSettings, Message } from "../../shared/schemas.js";
import type { CredentialService } from "./credential-service.js";

export interface ProviderToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderMessage extends Pick<Message, "role" | "content"> {
  toolCalls?: ProviderToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ProviderChatInput {
  settings: AppSettings;
  system: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export interface ProviderChatResult {
  content: string;
  toolCalls: ProviderToolCall[];
}

interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsText?: string;
  replaceArguments?: boolean;
}

interface StreamDelta {
  text?: string;
  toolCalls?: ToolCallDelta[];
}

export class ResearchProvider {
  constructor(
    private readonly credentials: CredentialService,
    private readonly requestTimeoutMs = 10 * 60 * 1000
  ) {}

  async stream(input: ProviderChatInput): Promise<string> {
    return (await this.chat(input)).content;
  }

  async chat(input: ProviderChatInput): Promise<ProviderChatResult> {
    return input.settings.ai.provider === "ollama" ? this.chatOllama(input) : this.chatOpenAi(input);
  }

  private async chatOllama(input: ProviderChatInput): Promise<ProviderChatResult> {
    const response = await fetch(`${trimTrailingSlash(input.settings.ai.baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: requestSignal(input.signal, this.requestTimeoutMs),
      body: JSON.stringify({
        model: input.settings.ai.model,
        stream: true,
        options: { temperature: 0.2, num_ctx: 8192 },
        messages: [{ role: "system", content: input.system }, ...input.messages.map(toOllamaMessage)],
        tools: input.tools?.length ? input.tools : undefined
      })
    });
    if (!response.ok) throw new Error(await responseError("Ollama", response));
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = (await response.json()) as {
        message?: { content?: string; tool_calls?: OllamaToolCall[] };
      };
      const content = data.message?.content ?? "";
      if (content) input.onDelta(content);
      return { content, toolCalls: normalizeOllamaToolCalls(data.message?.tool_calls ?? []) };
    }
    return readProviderStream(
      response,
      (line) => {
        const data = JSON.parse(line) as { message?: { content?: string; tool_calls?: OllamaToolCall[] } };
        return {
          text: data.message?.content,
          toolCalls: (data.message?.tool_calls ?? []).map((call, index) => ({
            index,
            id: call.id,
            name: call.function.name,
            argumentsText: JSON.stringify(call.function.arguments ?? {}),
            replaceArguments: true
          }))
        };
      },
      input.onDelta
    );
  }

  private async chatOpenAi(input: ProviderChatInput): Promise<ProviderChatResult> {
    const apiKey = this.credentials.get("ai-gateway");
    if (input.settings.ai.provider === "vercel" && !apiKey) {
      throw new Error("AI Gateway API key is not configured.");
    }
    const response = await fetch(openAiCompatibleUrl(input.settings.ai.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json"
      },
      signal: requestSignal(input.signal, this.requestTimeoutMs),
      body: JSON.stringify({
        model: input.settings.ai.model,
        stream: true,
        messages: [{ role: "system", content: input.system }, ...input.messages.map(toOpenAiMessage)],
        tools: input.tools?.length ? input.tools : undefined,
        reasoning:
          input.settings.ai.provider === "vercel" && input.settings.ai.reasoningEnabled
            ? { effort: "medium" }
            : undefined
      })
    });
    if (!response.ok) throw new Error(await responseError("AI provider", response));
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string; tool_calls?: OpenAiToolCall[] } }>;
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? "";
      if (content) input.onDelta(content);
      return { content, toolCalls: normalizeOpenAiToolCalls(message?.tool_calls ?? []) };
    }
    return readProviderStream(
      response,
      (line) => {
        if (!line.startsWith("data:")) return {};
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return {};
        const data = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        const delta = data.choices?.[0]?.delta;
        return {
          text: delta?.content,
          toolCalls: (delta?.tool_calls ?? []).map((call, fallbackIndex) => ({
            index: call.index ?? fallbackIndex,
            id: call.id,
            name: call.function?.name,
            argumentsText: call.function?.arguments
          }))
        };
      },
      input.onDelta
    );
  }
}

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments?: Record<string, unknown> };
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function toOllamaMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        function: { name: call.name, arguments: call.arguments }
      }))
    };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_name: message.toolName };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  return { role: message.role, content: message.content };
}

async function readProviderStream(
  response: Response,
  extract: (line: string) => StreamDelta,
  onDelta: (text: string) => void
): Promise<ProviderChatResult> {
  if (!response.body) throw new Error("Provider returned an empty response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const calls = new Map<number, { id?: string; name?: string; argumentsText: string }>();
  let buffer = "";
  let content = "";
  const consume = (line: string): void => {
    const delta = extract(line);
    if (delta.text) {
      content += delta.text;
      onDelta(delta.text);
    }
    for (const call of delta.toolCalls ?? []) {
      const current = calls.get(call.index) ?? { argumentsText: "" };
      calls.set(call.index, {
        id: call.id ?? current.id,
        name: call.name ?? current.name,
        argumentsText: call.replaceArguments
          ? (call.argumentsText ?? current.argumentsText)
          : current.argumentsText + (call.argumentsText ?? "")
      });
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) consume(trimmed);
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
  return { content, toolCalls: finishToolCalls(calls) };
}

function finishToolCalls(
  calls: Map<number, { id?: string; name?: string; argumentsText: string }>
): ProviderToolCall[] {
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id ?? `tool_call_${index}`,
      name: call.name ?? "unknown",
      arguments: parseArguments(call.argumentsText)
    }));
}

function normalizeOllamaToolCalls(calls: OllamaToolCall[]): ProviderToolCall[] {
  return calls.map((call, index) => ({
    id: call.id ?? `tool_call_${index}`,
    name: call.function.name,
    arguments: call.function.arguments ?? {}
  }));
}

function normalizeOpenAiToolCalls(calls: OpenAiToolCall[]): ProviderToolCall[] {
  return calls.map((call, index) => ({
    id: call.id ?? `tool_call_${index}`,
    name: call.function?.name ?? "unknown",
    arguments: parseArguments(call.function?.arguments ?? "")
  }));
}

function parseArguments(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function responseError(label: string, response: Response): Promise<string> {
  return `${label} request failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function openAiCompatibleUrl(baseUrl: string, resource: string): string {
  const normalizedBase = trimTrailingSlash(baseUrl);
  const versionedBase = normalizedBase.endsWith("/v1") ? normalizedBase : `${normalizedBase}/v1`;
  return `${versionedBase}/${resource.replace(/^\/+/, "")}`;
}
