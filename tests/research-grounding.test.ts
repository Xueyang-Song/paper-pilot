import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import {
  buildRecentContext,
  collectResearchEvidence,
  deriveConversationTitle,
  validateResearchCitations
} from "../src/main/services/research-grounding";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-grounding-"));
  db = new PaperPilotDb(join(dir, "grounding.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("research grounding", () => {
  it("constrains evidence to pinned sources and excludes generated artifacts", () => {
    const project = db.createProject("Grounding");
    db.savePaper(project.id, {
      id: "paper_alpha",
      title: "Alpha protein response",
      abstract: "Alpha proteins improve the measured response in the controlled study.",
      authors: ["A. Author"],
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    db.savePaper(project.id, {
      id: "paper_beta",
      title: "Beta protein response",
      abstract: "Beta proteins show a different response.",
      authors: ["B. Author"],
      source: "crossref",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    db.saveArtifact({
      id: "generated",
      projectId: project.id,
      type: "chat-answer",
      title: "Generated alpha answer",
      path: join(dir, "generated.md"),
      mime: "text/markdown",
      hash: "hash",
      source: "research-chat",
      metadata: {},
      createdAt: new Date().toISOString()
    });
    db.addDocumentChunks({
      projectId: project.id,
      artifactId: "generated",
      chunks: [{ text: "Alpha proteins definitely cause every response." }]
    });

    const evidence = collectResearchEvidence(db, project.id, "Which protein response is supported?", [
      { type: "paper", id: "paper_alpha" }
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0].paperId).toBe("paper_alpha");
    expect(evidence.some((entry) => entry.artifactId === "generated")).toBe(false);
  });

  it("validates evidence ids and grounded block coverage", () => {
    const evidence = [
      {
        evidenceId: "S1",
        sourceType: "paper" as const,
        paperId: "paper_1",
        title: "Study",
        excerpt: "Evidence"
      }
    ];
    expect(
      validateResearchCitations(
        "The controlled study reports a statistically meaningful improvement in the measured outcome. [[S1]]",
        evidence,
        true
      ).valid
    ).toBe(true);
    const missing = validateResearchCitations(
      "The controlled study reports a statistically meaningful improvement in the measured outcome.",
      evidence,
      true
    );
    expect(missing.uncoveredBlocks).toHaveLength(1);
    expect(
      validateResearchCitations("A claim with the wrong reference marker [[S9]].", evidence, false).invalidIds
    ).toEqual(["S9"]);
  });

  it("uses a visible recent context window without summaries", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `message_${index}`,
      projectId: "project",
      conversationId: "conversation",
      role: index % 2 ? ("assistant" as const) : ("user" as const),
      content: `${index} ${"long context ".repeat(250)}`,
      status: "completed" as const,
      metadata: {},
      createdAt: new Date(index).toISOString()
    }));
    const result = buildRecentContext(messages, "ollama", "system prompt");
    expect(result.included).toBeGreaterThan(0);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.messages.at(-1)?.id).toBe("message_19");
  });

  it("derives bounded deterministic conversation titles", () => {
    const title = deriveConversationTitle("  Compare   all major findings and limitations ".repeat(5));
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith("...")).toBe(true);
  });
});
