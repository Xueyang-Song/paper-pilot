import { describe, expect, it } from "vitest";
import {
  fitReviewEvidenceBudget,
  parseReviewAgentJson,
  validateExtractionSuggestion,
  validateScreeningSuggestion,
  type ReviewAgentCriterion,
  type ReviewAgentEvidence
} from "../src/main/services/review-agent-utils";

const evidence: ReviewAgentEvidence[] = [
  {
    evidenceId: "S1",
    paperId: "paper-1",
    sourceType: "paper",
    title: "Trial",
    excerpt: "Adults receiving the intervention improved."
  }
];
const criteria: ReviewAgentCriterion[] = [
  { id: "include-adults", kind: "inclusion", text: "Adults are studied." },
  { id: "exclude-animals", kind: "exclusion", text: "Animal-only study." }
];

describe("review agent validation", () => {
  it("parses fenced and surrounded JSON", () => {
    expect(parseReviewAgentJson('```json\n{"decision":"uncertain"}\n```')).toEqual({ decision: "uncertain" });
    expect(parseReviewAgentJson('Result:\n{"decision":"uncertain"}\nDone')).toEqual({ decision: "uncertain" });
  });

  it("fits evidence to local and hosted context budgets without changing evidence IDs", () => {
    const oversized = Array.from({ length: 12 }, (_, index) => ({
      ...evidence[0],
      evidenceId: `S${index + 1}`,
      excerpt: "e".repeat(10_000)
    }));
    const local = fitReviewEvidenceBudget(oversized, "ollama");
    const hosted = fitReviewEvidenceBudget(oversized, "openai-compatible");

    expect(local.map((entry) => entry.evidenceId)).toEqual(oversized.map((entry) => entry.evidenceId));
    expect(local.reduce((total, entry) => total + entry.excerpt.length, 0)).toBeLessThanOrEqual(16_000);
    expect(hosted.reduce((total, entry) => total + entry.excerpt.length, 0)).toBeLessThanOrEqual(40_000);
  });

  it("accepts a criterion-consistent evidence-backed screening suggestion", () => {
    const result = validateScreeningSuggestion({
      paperId: "paper-1",
      criteria,
      evidence,
      value: {
        decision: "include",
        rationale: "The eligible adult population is present and no animal-only exclusion applies.",
        assessments: [
          {
            criterionId: "include-adults",
            assessment: "met",
            explanation: "Adults received the intervention.",
            evidenceIds: ["S1"]
          },
          {
            criterionId: "exclude-animals",
            assessment: "not-met",
            explanation: "The study concerns adults.",
            evidenceIds: ["S1"]
          }
        ]
      }
    });
    expect(result.decision).toBe("include");
  });

  it("rejects invalid evidence and inconsistent decisions", () => {
    const base = {
      rationale: "Unclear",
      assessments: [
        {
          criterionId: "include-adults",
          assessment: "unclear",
          explanation: "No population is stated.",
          evidenceIds: []
        },
        {
          criterionId: "exclude-animals",
          assessment: "unclear",
          explanation: "No population is stated.",
          evidenceIds: []
        }
      ]
    };
    expect(() =>
      validateScreeningSuggestion({ paperId: "paper-1", criteria, evidence, value: { ...base, decision: "include" } })
    ).toThrow("inconsistent");
    expect(() =>
      validateScreeningSuggestion({
        paperId: "paper-1",
        criteria,
        evidence,
        value: {
          ...base,
          decision: "uncertain",
          assessments: [{ ...base.assessments[0], assessment: "met", evidenceIds: ["S9"] }, base.assessments[1]]
        }
      })
    ).toThrow("Unknown review evidence");
  });

  it("fails advisory screening closed to uncertain when a blank protocol has no criteria", () => {
    expect(
      validateScreeningSuggestion({
        paperId: "paper-1",
        criteria: [],
        evidence,
        value: { decision: "uncertain", rationale: "No screening criteria are configured.", assessments: [] }
      }).decision
    ).toBe("uncertain");
    expect(() =>
      validateScreeningSuggestion({
        paperId: "paper-1",
        criteria: [],
        evidence,
        value: { decision: "include", rationale: "No criteria were assessed.", assessments: [] }
      })
    ).toThrow("inconsistent");
  });

  it("validates typed extraction values and evidence", () => {
    const result = validateExtractionSuggestion({
      paperId: "paper-1",
      evidence,
      fields: [
        { id: "sample-size", type: "number" },
        { id: "design", type: "single-select", options: ["RCT", "Cohort"] }
      ],
      value: {
        values: [
          { fieldId: "sample-size", status: "found", value: 42, evidenceIds: ["S1"] },
          { fieldId: "design", status: "not-found", evidenceIds: [] }
        ]
      }
    });
    expect(result.values[0].value).toBe(42);
    expect(() =>
      validateExtractionSuggestion({
        paperId: "paper-1",
        evidence,
        fields: [{ id: "sample-size", type: "number" }],
        value: { values: [{ fieldId: "sample-size", status: "found", value: "42", evidenceIds: ["S1"] }] }
      })
    ).toThrow();
  });
});
