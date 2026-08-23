import { z } from "zod";

export interface ReviewAgentEvidence {
  evidenceId: string;
  paperId: string;
  sourceType: "paper" | "artifact";
  title: string;
  excerpt: string;
  artifactId?: string;
  chunkId?: string;
  page?: number;
  locator?: string;
}

export interface ReviewAgentCriterion {
  id: string;
  kind: "inclusion" | "exclusion";
  text: string;
}

export interface ReviewAgentExtractionField {
  id: string;
  type: "short-text" | "long-text" | "number" | "boolean" | "single-select" | "multi-select";
  options?: string[];
}

const criterionAssessmentSchema = z.object({
  criterionId: z.string(),
  assessment: z.enum(["met", "not-met", "unclear"]),
  explanation: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.string()).max(12).default([])
});

const screeningSuggestionSchema = z.object({
  decision: z.enum(["include", "exclude", "uncertain"]),
  rationale: z.string().trim().min(1).max(4_000),
  assessments: z.array(criterionAssessmentSchema)
});

export type ReviewAgentScreeningSuggestion = z.infer<typeof screeningSuggestionSchema>;

const extractionSuggestionSchema = z.object({
  values: z.array(
    z.object({
      fieldId: z.string(),
      status: z.enum(["found", "not-found", "unclear"]),
      value: z.unknown().optional(),
      note: z.string().trim().max(2_000).optional(),
      evidenceIds: z.array(z.string()).max(12).default([])
    })
  )
});

export type ReviewAgentExtractionSuggestion = z.infer<typeof extractionSuggestionSchema>;

export function parseReviewAgentJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("The AI provider returned an empty review response.");
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    const object = firstBalancedJsonObject(unfenced);
    if (!object) throw new Error("The AI provider did not return valid JSON.");
    try {
      return JSON.parse(object) as unknown;
    } catch {
      throw new Error("The AI provider did not return valid JSON.");
    }
  }
}

export function validateScreeningSuggestion(input: {
  value: unknown;
  criteria: ReviewAgentCriterion[];
  evidence: ReviewAgentEvidence[];
  paperId: string;
}): ReviewAgentScreeningSuggestion {
  const parsed = screeningSuggestionSchema.parse(input.value);
  const criteria = new Map(input.criteria.map((criterion) => [criterion.id, criterion]));
  const evidence = new Map(input.evidence.map((entry) => [entry.evidenceId, entry]));
  const seen = new Set<string>();

  for (const assessment of parsed.assessments) {
    if (!criteria.has(assessment.criterionId)) {
      throw new Error(`Unknown review criterion: ${assessment.criterionId}.`);
    }
    if (seen.has(assessment.criterionId)) {
      throw new Error(`Duplicate review criterion assessment: ${assessment.criterionId}.`);
    }
    seen.add(assessment.criterionId);
    validateEvidenceIds(assessment.evidenceIds, evidence, input.paperId);
    if (assessment.assessment !== "unclear" && assessment.evidenceIds.length === 0) {
      throw new Error(`Criterion ${assessment.criterionId} is missing supporting evidence.`);
    }
  }
  for (const criterion of input.criteria) {
    if (!seen.has(criterion.id)) throw new Error(`Missing review criterion assessment: ${criterion.id}.`);
  }

  const byId = new Map(parsed.assessments.map((assessment) => [assessment.criterionId, assessment]));
  const includeIsSupported =
    input.criteria.length > 0 &&
    input.criteria.every((criterion) => {
      const assessment = byId.get(criterion.id)!;
      return criterion.kind === "inclusion" ? assessment.assessment === "met" : assessment.assessment === "not-met";
    });
  const excludeIsSupported = input.criteria.some((criterion) => {
    const assessment = byId.get(criterion.id)!;
    return criterion.kind === "inclusion" ? assessment.assessment === "not-met" : assessment.assessment === "met";
  });
  if (parsed.decision === "include" && !includeIsSupported) {
    throw new Error("The include recommendation is inconsistent with its criterion assessments.");
  }
  if (parsed.decision === "exclude" && !excludeIsSupported) {
    throw new Error("The exclude recommendation is inconsistent with its criterion assessments.");
  }
  if (parsed.decision === "uncertain" && (includeIsSupported || excludeIsSupported)) {
    throw new Error("The uncertain recommendation is inconsistent with its criterion assessments.");
  }
  return parsed;
}

export function validateExtractionSuggestion(input: {
  value: unknown;
  fields: ReviewAgentExtractionField[];
  evidence: ReviewAgentEvidence[];
  paperId: string;
}): ReviewAgentExtractionSuggestion {
  const parsed = extractionSuggestionSchema.parse(input.value);
  const fields = new Map(input.fields.map((field) => [field.id, field]));
  const evidence = new Map(input.evidence.map((entry) => [entry.evidenceId, entry]));
  const seen = new Set<string>();
  for (const item of parsed.values) {
    const field = fields.get(item.fieldId);
    if (!field) throw new Error(`Unknown extraction field: ${item.fieldId}.`);
    if (seen.has(item.fieldId)) throw new Error(`Duplicate extraction field value: ${item.fieldId}.`);
    seen.add(item.fieldId);
    validateEvidenceIds(item.evidenceIds, evidence, input.paperId);
    if (item.status === "found") {
      if (item.value === undefined || item.value === null || item.value === "") {
        throw new Error(`Extraction field ${item.fieldId} is marked found without a value.`);
      }
      if (item.evidenceIds.length === 0) {
        throw new Error(`Extraction field ${item.fieldId} is missing supporting evidence.`);
      }
      validateExtractionValue(field, item.value);
    } else if (item.value !== undefined && item.value !== null && item.value !== "") {
      throw new Error(`Extraction field ${item.fieldId} has a value but is marked ${item.status}.`);
    }
  }
  for (const field of input.fields) {
    if (!seen.has(field.id)) throw new Error(`Missing extraction field value: ${field.id}.`);
  }
  return parsed;
}

export function formatReviewEvidence(evidence: ReviewAgentEvidence[]): string {
  return evidence
    .map((entry) => {
      const locator = entry.page ? `page ${entry.page}` : entry.locator;
      return `[${entry.evidenceId}] ${entry.title}${locator ? ` — ${locator}` : ""}\n${entry.excerpt}`;
    })
    .join("\n\n");
}

export function fitReviewEvidenceBudget(
  evidence: ReviewAgentEvidence[],
  provider: "ollama" | "vercel" | "openai-compatible"
): ReviewAgentEvidence[] {
  if (!evidence.length) return [];
  // Approximate four characters per token and retain room for the protocol,
  // structured instructions, and the provider's response.
  const totalCharacterBudget = provider === "ollama" ? 16_000 : 40_000;
  const perEntryBudget = Math.max(400, Math.floor(totalCharacterBudget / evidence.length));
  return evidence.map((entry) => ({
    ...entry,
    excerpt: entry.excerpt.slice(0, perEntryBudget)
  }));
}

function validateEvidenceIds(ids: string[], evidence: Map<string, ReviewAgentEvidence>, paperId: string): void {
  for (const evidenceId of ids) {
    const entry = evidence.get(evidenceId);
    if (!entry) throw new Error(`Unknown review evidence reference: ${evidenceId}.`);
    if (entry.paperId !== paperId) throw new Error(`Review evidence ${evidenceId} belongs to a different paper.`);
  }
}

function validateExtractionValue(field: ReviewAgentExtractionField, value: unknown): void {
  switch (field.type) {
    case "short-text":
    case "long-text":
      z.string().parse(value);
      return;
    case "number":
      z.number().finite().parse(value);
      return;
    case "boolean":
      z.boolean().parse(value);
      return;
    case "single-select": {
      const selected = z.string().parse(value);
      if (!field.options?.includes(selected)) throw new Error(`Invalid option for extraction field ${field.id}.`);
      return;
    }
    case "multi-select": {
      const selected = z.array(z.string()).parse(value);
      if (selected.some((option) => !field.options?.includes(option))) {
        throw new Error(`Invalid option for extraction field ${field.id}.`);
      }
    }
  }
}

function firstBalancedJsonObject(value: string): string | undefined {
  const start = value.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}
