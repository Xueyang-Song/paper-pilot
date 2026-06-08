import { describe, expect, it } from "vitest";
import { appSettingsSchema, crawlConfigSchema, paperDedupeKey, updateStatusSchema } from "../src/shared/schemas";

describe("shared schemas", () => {
  it("applies crawl defaults", () => {
    const config = crawlConfigSchema.parse({ topic: "protein folding" });
    expect(config.openAccessOnly).toBe(true);
    expect(config.maxPapers).toBe(25);
    expect(config.sourceIds).toContain("openalex");
  });

  it("dedupes DOI before title", () => {
    expect(paperDedupeKey({ doi: "https://doi.org/10.1000/ABC", title: "A Paper" })).toBe("doi:10.1000/abc");
    expect(paperDedupeKey({ title: "A: Paper!" })).toBe("title:a paper");
  });

  it("defaults source preferences", () => {
    const settings = appSettingsSchema.parse({
      ai: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "gemma3:12b-it-qat" },
      python: { runtimeMode: "managed" }
    });
    expect(settings.ui.theme).toBe("system");
    expect(settings.sources.disabledSourceIds).toEqual([]);
  });

  it("validates updater status payloads", () => {
    const status = updateStatusSchema.parse({
      state: "downloading",
      currentVersion: "0.2.3",
      availableVersion: "0.2.4",
      downloadPercent: 45,
      transferredBytes: 45,
      totalBytes: 100,
      bytesPerSecond: 10,
      lastCheckedAt: "2026-06-08T12:00:00.000Z"
    });

    expect(status.retryCount).toBe(0);
    expect(status.state).toBe("downloading");
  });
});
