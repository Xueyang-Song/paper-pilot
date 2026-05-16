import { describe, expect, it } from "vitest";
import { appSettingsSchema, crawlConfigSchema, paperDedupeKey } from "../src/shared/schemas";

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
    expect(settings.sources.disabledSourceIds).toEqual([]);
  });
});
