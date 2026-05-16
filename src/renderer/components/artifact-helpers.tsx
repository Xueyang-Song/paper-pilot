import { FileCode, FileJson, FileText } from "lucide-react";
import type { JSX } from "react";
import type { Artifact, Paper, PaperScore } from "../../shared/schemas";

export interface ArtifactScoreTarget {
  kind: "paper" | "aggregate";
  title: string;
  subtitle: string;
  sourceLabel?: string;
  paper?: Paper;
  score?: PaperScore;
}
export interface ArtifactRow {
  artifact: Artifact;
  scoreTarget?: ArtifactScoreTarget;
  sourceLabel?: string;
  originalIndex: number;
}
export function buildArtifactRows(artifacts: Artifact[], papers: Paper[]): ArtifactRow[] {
  const paperById = new Map(papers.map((paper) => [paper.id, paper]));
  const aggregateScore = averagePaperScore(papers);
  return artifacts
    .map((artifact, originalIndex) => {
      const scoreTarget = getArtifactScoreTarget(artifact, paperById, papers, aggregateScore);
      return {
        artifact,
        scoreTarget,
        sourceLabel: scoreTarget?.sourceLabel ?? getArtifactSourceLabel(artifact),
        originalIndex
      };
    })
    .sort(compareArtifactRows);
}
function compareArtifactRows(left: ArtifactRow, right: ArtifactRow): number {
  const kindDelta = scoreTargetRank(left.scoreTarget) - scoreTargetRank(right.scoreTarget);
  if (kindDelta !== 0) return kindDelta;
  const scoreDelta = (right.scoreTarget?.score?.overall ?? -1) - (left.scoreTarget?.score?.overall ?? -1);
  if (scoreDelta !== 0) return scoreDelta;
  return left.originalIndex - right.originalIndex;
}
function scoreTargetRank(target?: ArtifactScoreTarget): number {
  if (target?.kind === "paper") return 0;
  if (target?.kind === "aggregate") return 1;
  return 2;
}
function getArtifactScoreTarget(
  artifact: Artifact,
  paperById: Map<string, Paper>,
  papers: Paper[],
  aggregateScore?: PaperScore
): ArtifactScoreTarget | undefined {
  const paper = findPaperForArtifact(artifact, paperById, papers);
  if (paper) {
    return {
      kind: "paper",
      title: paper.title,
      subtitle: paper.score ? "Paper score" : "Paper score not calculated",
      sourceLabel: formatSourceName(paper.source),
      paper,
      score: paper.score
    };
  }
  if (isCrawlArtifact(artifact) && papers.length) {
    return {
      kind: "aggregate",
      title: "Crawl average",
      subtitle: aggregateScore ? `${scoredPaperCount(papers)} scored papers` : "No scored papers yet",
      sourceLabel: formatSourceList(artifact.metadata.sources),
      score: aggregateScore
    };
  }
  return undefined;
}
function getArtifactSourceLabel(artifact: Artifact): string | undefined {
  const sources = formatSourceList(artifact.metadata.sources);
  if (sources) return sources;
  if (!artifact.source || artifact.source === "crawl-service") return undefined;
  return formatSourceName(artifact.source);
}
function findPaperForArtifact(artifact: Artifact, paperById: Map<string, Paper>, papers: Paper[]): Paper | undefined {
  const paperId = metadataString(artifact.metadata.paperId);
  if (paperId && paperById.has(paperId)) return paperById.get(paperId);
  const doi = normalizeDoi(metadataString(artifact.metadata.doi));
  if (doi) {
    const doiMatch = papers.find((paper) => normalizeDoi(paper.doi) === doi);
    if (doiMatch) return doiMatch;
  }
  if (artifact.type === "paper-pdf") {
    const normalizedTitle = normalizeCardTitle(artifact.title);
    return papers.find((paper) => normalizeCardTitle(paper.title) === normalizedTitle);
  }
  return undefined;
}
function isCrawlArtifact(artifact: Artifact): boolean {
  return artifact.source === "crawl-service" && (artifact.type === "metadata-json" || artifact.type === "markdown");
}
function averagePaperScore(papers: Paper[]): PaperScore | undefined {
  const scored = papers.filter((paper): paper is Paper & { score: PaperScore } => Boolean(paper.score));
  if (!scored.length) return undefined;
  const components = Object.fromEntries(
    scoreComponentRows(scored[0].score).map((component) => [
      component.key,
      roundUiScore(scored.reduce((sum, paper) => sum + paper.score.components[component.key], 0) / scored.length)
    ])
  ) as PaperScore["components"];
  const overall = roundUiScore(scored.reduce((sum, paper) => sum + paper.score.overall, 0) / scored.length);
  const topPaper = [...scored].sort((left, right) => right.score.overall - left.score.overall)[0];
  return {
    overall,
    label: scoreLabel(overall),
    components,
    reasons: [`Average across ${scored.length} scored papers.`, `Top paper: ${topPaper.title}.`],
    scoredAt: scored.map((paper) => paper.score.scoredAt).sort().at(-1) ?? new Date().toISOString(),
    version: "aggregate"
  };
}
function scoredPaperCount(papers: Paper[]): number {
  return papers.filter((paper) => Boolean(paper.score)).length;
}
export function scoreComponentRows(score: PaperScore): Array<{ key: keyof PaperScore["components"]; label: string; value: number }> {
  return [
    { key: "citations", label: "Citations", value: score.components.citations },
    { key: "venue", label: "Venue", value: score.components.venue },
    { key: "institution", label: "Institution", value: score.components.institution },
    { key: "recency", label: "Recency", value: score.components.recency },
    { key: "access", label: "Access", value: score.components.access },
    { key: "source", label: "Source", value: score.components.source },
    { key: "metadata", label: "Metadata", value: score.components.metadata }
  ];
}
function scoreLabel(score: number): PaperScore["label"] {
  if (score >= 85) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 55) return "solid";
  if (score >= 40) return "emerging";
  return "limited";
}
function roundUiScore(value: number): number {
  return Number(Math.min(100, Math.max(0, value)).toFixed(1));
}
function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeDoi(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
}
function normalizeCardTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function formatSourceList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const sources = value
    .filter((source): source is string => typeof source === "string" && source.trim().length > 0)
    .map(formatSourceName);
  return sources.length ? sources.join(", ") : undefined;
}
function formatSourceName(source: string): string {
  const labels: Record<string, string> = {
    openalex: "OpenAlex",
    crossref: "Crossref",
    "semantic-scholar": "Semantic Scholar",
    pubmed: "PubMed",
    arxiv: "arXiv",
    "europe-pmc": "Europe PMC",
    core: "CORE",
    unpaywall: "Unpaywall",
    "google-scholar": "Google Scholar",
    "ai-service": "AI service",
    "python-service": "Python service"
  };
  return labels[source] ?? source.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function ArtifactIcon({ artifact, className }: { artifact: Artifact; className?: string }): JSX.Element {
  const props = { size: 16, className };
  if (artifact.type === "metadata-json" || artifact.mime === "application/json") return <FileJson {...props} />;
  if (artifact.type === "script") return <FileCode {...props} />;
  return <FileText {...props} />;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
export function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}
export function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = base64ToBytes(base64);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}
export function base64ToBytes(base64: string): Uint8Array {
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let offset = 0; offset < raw.length; offset += 8192) {
    const slice = raw.slice(offset, offset + 8192);
    for (let index = 0; index < slice.length; index += 1) {
      bytes[offset + index] = slice.charCodeAt(index);
    }
  }
  return bytes;
}
