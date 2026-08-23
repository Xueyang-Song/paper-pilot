import type { Paper, PaperScore } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";

const SCORE_VERSION = "heuristic-v1";

const SCORE_WEIGHTS: PaperScore["components"] = {
  citations: 30,
  venue: 20,
  institution: 15,
  recency: 10,
  access: 10,
  source: 8,
  metadata: 7
};

const SOURCE_SCORES: Record<Paper["source"], number> = {
  openalex: 82,
  crossref: 66,
  "semantic-scholar": 78,
  pubmed: 84,
  arxiv: 62,
  "europe-pmc": 84,
  core: 72,
  unpaywall: 64,
  "google-scholar": 52,
  "reference-import": 55
};

const TOP_VENUE_PATTERNS = [
  "nature",
  "science",
  "cell",
  "the lancet",
  "new england journal of medicine",
  "nejm",
  "jama",
  "proceedings of the national academy of sciences",
  "pnas",
  "nature medicine",
  "nature methods",
  "neurips",
  "neural information processing systems",
  "icml",
  "iclr",
  "cvpr",
  "acl",
  "emnlp",
  "siggraph",
  "kdd",
  "aaai",
  "ijcai"
];

const STRONG_VENUE_PATTERNS = [
  "ieee",
  "acm",
  "jmlr",
  "nucleic acids research",
  "bioinformatics",
  "royal society",
  "plos biology",
  "plos medicine",
  "elifesciences",
  "bmj",
  "frontiers",
  "springer",
  "elsevier",
  "wiley"
];

const PREPRINT_VENUE_PATTERNS = ["arxiv", "biorxiv", "medrxiv", "ssrn", "preprint"];

const TOP_INSTITUTION_PATTERNS = [
  "harvard",
  "stanford",
  "massachusetts institute of technology",
  "mit",
  "university of oxford",
  "university of cambridge",
  "eth zurich",
  "uc berkeley",
  "university of california berkeley",
  "princeton",
  "caltech",
  "imperial college",
  "ucla",
  "university of chicago",
  "yale",
  "columbia university",
  "cornell",
  "university of toronto",
  "tsinghua",
  "peking university",
  "national university of singapore",
  "university of tokyo",
  "max planck",
  "nih",
  "broad institute",
  "allen institute"
];

const STRONG_INSTITUTION_HINTS = [
  "university",
  "institute",
  "laboratory",
  "hospital",
  "clinic",
  "research center",
  "cnrs"
];

export interface PaperScoringResult {
  scoredCount: number;
  papers: Paper[];
}

export class PaperScoringService {
  constructor(private readonly db: PaperPilotDb) {}

  scoreProjectPapers(projectId: string, paperIds?: string[]): PaperScoringResult {
    const projectPapers = this.db.listPapers(projectId);
    const selectedIds = paperIds ? new Set(paperIds) : undefined;
    const targetPapers = selectedIds ? projectPapers.filter((paper) => selectedIds.has(paper.id)) : projectPapers;
    const papers = targetPapers.map((paper) =>
      this.db.updatePaperScore(projectId, paper.id, this.scorePaper(paper, projectPapers))
    );
    return { scoredCount: papers.length, papers };
  }

  scorePaper(paper: Paper, projectPapers: Paper[] = []): PaperScore {
    const citations = scoreCitations(paper, projectPapers);
    const venue = scoreVenue(paper);
    const institution = scoreInstitution(paper);
    const recency = scoreRecency(paper);
    const access = scoreAccess(paper);
    const source = scoreSource(paper);
    const metadata = scoreMetadata(paper);
    const components: PaperScore["components"] = {
      citations: citations.score,
      venue: venue.score,
      institution: institution.score,
      recency: recency.score,
      access: access.score,
      source: source.score,
      metadata: metadata.score
    };
    const overall = roundScore(
      Object.entries(components).reduce((sum, [key, value]) => {
        const weight = SCORE_WEIGHTS[key as keyof PaperScore["components"]];
        return sum + value * (weight / 100);
      }, 0)
    );
    return {
      overall,
      label: labelForScore(overall),
      components,
      reasons: [citations.reason, venue.reason, institution.reason, recency.reason, access.reason, metadata.reason]
        .filter(Boolean)
        .slice(0, 5),
      scoredAt: new Date().toISOString(),
      version: SCORE_VERSION
    };
  }
}

function scoreCitations(paper: Paper, projectPapers: Paper[]): { score: number; reason: string } {
  if (paper.citationCount === undefined) {
    return { score: 35, reason: "Citation count is missing, so citation confidence is limited." };
  }
  const citations = paper.citationCount;
  const globalScore = clamp((Math.log1p(citations) / Math.log1p(1000)) * 100);
  const maxProjectCitations = Math.max(
    citations,
    ...projectPapers.map((projectPaper) => projectPaper.citationCount ?? 0)
  );
  const projectScore = maxProjectCitations > 0 ? (Math.log1p(citations) / Math.log1p(maxProjectCitations)) * 100 : 45;
  const score = roundScore(globalScore * 0.7 + projectScore * 0.3);
  return {
    score,
    reason: citations > 0 ? `${citations.toLocaleString()} citations detected.` : "No citations detected yet."
  };
}

function scoreVenue(paper: Paper): { score: number; reason: string } {
  const venue = collectVenueNames(paper)[0];
  if (!venue) return { score: 45, reason: "Venue metadata is missing." };
  const normalized = normalizeText(venue);
  if (containsAny(normalized, TOP_VENUE_PATTERNS)) {
    return { score: 92, reason: `High-prestige venue signal: ${venue}.` };
  }
  if (containsAny(normalized, STRONG_VENUE_PATTERNS)) {
    return { score: 78, reason: `Recognized venue or publisher signal: ${venue}.` };
  }
  if (containsAny(normalized, PREPRINT_VENUE_PATTERNS)) {
    return { score: 55, reason: `Preprint venue signal: ${venue}.` };
  }
  if (/\b(journal|proceedings|transactions|conference)\b/.test(normalized)) {
    return { score: 64, reason: `Scholarly venue signal: ${venue}.` };
  }
  return { score: 52, reason: `Venue signal available: ${venue}.` };
}

function scoreInstitution(paper: Paper): { score: number; reason: string } {
  const institutions = collectInstitutionNames(paper.raw);
  if (!institutions.length) return { score: 50, reason: "Institutional affiliation metadata is missing." };
  const best = institutions
    .map((institution) => ({ institution, normalized: normalizeText(institution) }))
    .map((item) => {
      if (containsAny(item.normalized, TOP_INSTITUTION_PATTERNS)) return { ...item, score: 90 };
      if (containsAny(item.normalized, STRONG_INSTITUTION_HINTS)) return { ...item, score: 70 };
      return { ...item, score: 55 };
    })
    .sort((left, right) => right.score - left.score)[0];
  return {
    score: best.score,
    reason:
      best.score >= 90
        ? `Top institution signal: ${best.institution}.`
        : `Institution signal available: ${best.institution}.`
  };
}

function scoreRecency(paper: Paper): { score: number; reason: string } {
  if (!paper.year) return { score: 45, reason: "Publication year is missing." };
  const age = Math.max(0, new Date().getFullYear() - paper.year);
  if (age <= 1) return { score: 100, reason: "Very recent publication." };
  if (age <= 3) return { score: 85, reason: "Recent publication." };
  if (age <= 6) return { score: 70, reason: "Moderately recent publication." };
  if (age <= 10) return { score: 55, reason: "Older but still within a useful citation window." };
  return { score: 35, reason: "Older paper; score leans more on citations and venue." };
}

function scoreAccess(paper: Paper): { score: number; reason: string } {
  if (paper.pdfUrl && paper.isOpenAccess) return { score: 100, reason: "Open-access PDF is available." };
  if (paper.pdfUrl) return { score: 90, reason: "PDF URL is available." };
  if (paper.isOpenAccess) return { score: 80, reason: "Open-access record is available." };
  if (paper.url || paper.doi) return { score: 55, reason: "Only landing-page or DOI access is available." };
  return { score: 35, reason: "Access metadata is sparse." };
}

function scoreSource(paper: Paper): { score: number; reason: string } {
  return {
    score: SOURCE_SCORES[paper.source] ?? 55,
    reason: `Source reliability proxy: ${paper.source}.`
  };
}

function scoreMetadata(paper: Paper): { score: number; reason: string } {
  const checks = [
    Boolean(paper.title),
    Boolean(paper.abstract),
    paper.authors.length > 0,
    Boolean(paper.year),
    Boolean(paper.doi),
    Boolean(paper.url),
    Boolean(paper.pdfUrl),
    Boolean(paper.venue),
    paper.citationCount !== undefined,
    paper.fieldsOfStudy.length > 0
  ];
  const score = roundScore((checks.filter(Boolean).length / checks.length) * 100);
  return {
    score,
    reason: score >= 70 ? "Metadata is reasonably complete." : "Metadata is incomplete."
  };
}

function collectVenueNames(paper: Paper): string[] {
  const raw = asRecord(paper.raw);
  return uniqueStrings([
    paper.venue,
    getNestedString(raw, ["primary_location", "source", "display_name"]),
    getNestedString(raw, ["host_venue", "display_name"]),
    getNestedString(raw, ["journal", "name"]),
    getNestedString(raw, ["venue"]),
    getNestedString(raw, ["container-title", "0"]),
    getNestedString(raw, ["container_title"])
  ]);
}

function collectInstitutionNames(raw: Paper["raw"]): string[] {
  const names = new Set<string>();
  const rawRecord = asRecord(raw);
  for (const authorship of asArray(rawRecord?.authorships)) {
    const authorshipRecord = asRecord(authorship);
    for (const institution of asArray(authorshipRecord?.institutions)) addInstitutionValue(names, institution);
  }
  for (const author of asArray(rawRecord?.authors)) {
    const authorRecord = asRecord(author);
    addInstitutionValue(names, authorRecord?.affiliation);
    addInstitutionValue(names, authorRecord?.affiliations);
    addInstitutionValue(names, authorRecord?.institutions);
  }
  visitInstitutionLikeValues(rawRecord, names, 0);
  return Array.from(names).slice(0, 20);
}

function visitInstitutionLikeValues(value: unknown, names: Set<string>, depth: number): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) visitInstitutionLikeValues(item, names, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes("institution") || normalizedKey.includes("affiliation")) {
      addInstitutionValue(names, child);
    } else if (typeof child === "object" && child !== null) {
      visitInstitutionLikeValues(child, names, depth + 1);
    }
  }
}

function addInstitutionValue(names: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    if (value.trim()) names.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addInstitutionValue(names, item);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const displayName = record.display_name ?? record.displayName ?? record.name;
  if (typeof displayName === "string" && displayName.trim()) names.add(displayName.trim());
}

function getNestedString(record: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = record;
  for (const segment of path) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }
    const currentRecord = asRecord(current);
    if (!currentRecord) return undefined;
    current = currentRecord[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
}

function containsAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
}

function labelForScore(score: number): PaperScore["label"] {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 55) return "solid";
  if (score >= 40) return "emerging";
  return "limited";
}

function roundScore(value: number): number {
  return Number(clamp(value).toFixed(1));
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}
