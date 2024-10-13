import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../src/main/sources/registry";
import type { SourceConnector } from "../src/main/sources/types";

describe("SourceRegistry", () => {
  it("lists API-first sources plus experimental browser fallback", () => {
    const sources = new SourceRegistry().list();
    expect(sources.map((source) => source.id)).toEqual(
      expect.arrayContaining(["openalex", "crossref", "semantic-scholar", "pubmed", "arxiv", "europe-pmc", "core", "unpaywall", "google-scholar"])
    );
    expect(sources.find((source) => source.id === "google-scholar")?.stable).toBe(false);
  });

  it("turns connector failures into warnings", async () => {
    const connector: SourceConnector = {
      definition: {
        id: "openalex",
        displayName: "Failing OpenAlex",
        kind: "api",
        description: "fixture",
        requiresApiKey: false,
        stable: true,
        capabilities: [],
        rateLimit: { requestsPerMinute: 1 }
      },
      credentialSchema: {} as SourceConnector["credentialSchema"],
      crawlConfigSchema: {} as SourceConnector["crawlConfigSchema"],
      async run() {
        throw new Error("temporary upstream failure");
      }
    };
    const registry = new SourceRegistry([connector]);
    const result = await registry.run(
      "openalex",
      {
        topic: "test",
        maxPapers: 1,
        sourceIds: ["openalex"],
        sort: "relevance",
        openAccessOnly: true,
        allowBrowserFallback: false,
        credentialRefs: {}
      },
      { credentials: {}, userAgent: "test" }
    );
    expect(result.papers).toHaveLength(0);
    expect(result.warnings[0]).toContain("temporary upstream failure");
  });
});
