import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AppSettings, appSettingsSchema } from "../../shared/schemas.js";
import { ensureDir } from "../utils.js";
import type { CredentialService } from "./credential-service.js";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "./ollama-config.js";

const defaults: AppSettings = appSettingsSchema.parse({
  ai: {
    provider: "ollama",
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
    model: DEFAULT_OLLAMA_MODEL,
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
});

export class SettingsService {
  constructor(
    private readonly settingsPath: string,
    private readonly credentials: CredentialService
  ) {}

  async get(): Promise<AppSettings> {
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
      const parsed = appSettingsSchema.parse({ ...defaults, ...(raw as object) });
      parsed.ai.hasApiKey = this.credentials.has("ai-gateway");
      return parsed;
    } catch {
      return { ...defaults, ai: { ...defaults.ai, hasApiKey: this.credentials.has("ai-gateway") } };
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const next = appSettingsSchema.parse({
      ai: { ...current.ai, ...patch.ai, hasApiKey: this.credentials.has("ai-gateway") },
      python: { ...current.python, ...patch.python },
      sources: { ...current.sources, ...patch.sources }
    });
    await ensureDir(dirname(this.settingsPath));
    await writeFile(this.settingsPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  }
}
