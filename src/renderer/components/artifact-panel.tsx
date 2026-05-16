import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Info, Loader2, RefreshCw } from "lucide-react";
import type { JSX } from "react";
import { useMemo } from "react";
import type { Artifact, Paper, PaperScore } from "../../shared/schemas";
import { Metric } from "./ui";
import { ArtifactIcon, buildArtifactRows, scoreComponentRows, type ArtifactScoreTarget } from "./artifact-helpers";

export function ArtifactPanel({
  projectId,
  artifacts,
  papers,
  onOpenArtifact
}: {
  projectId?: string;
  artifacts: Artifact[];
  papers: Paper[];
  onOpenArtifact(artifactId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const scorePapers = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Select a project before scoring papers.");
      return window.paperPilot.scorePapers({ projectId });
    },
    onSuccess: () => {
      if (!projectId) return;
      void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });
  const artifactRows = useMemo(() => buildArtifactRows(artifacts, papers), [artifacts, papers]);
  const scoredCount = papers.filter((paper) => Boolean(paper.score)).length;
  return (
    <aside className="flex min-h-0 flex-col border-l border-stone-200 bg-[#f1f5f1]">
      <div className="flex h-12 items-center justify-between border-b border-stone-200 px-4">
        <div className="text-sm font-semibold">Artifacts</div>
        <Archive size={16} className="text-stone-600" />
      </div>
      <div className="min-h-0 overflow-y-auto p-3">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Metric label="Papers" value={papers.length} />
          <Metric label="Files" value={artifacts.length} />
        </div>
        <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-stone-200 bg-white p-3 shadow-sm">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-600">Scores</div>
            <div className="mt-0.5 truncate text-[11px] text-stone-500">
              {scoredCount}/{papers.length} papers scored
            </div>
          </div>
          <button
            type="button"
            onClick={() => scorePapers.mutate()}
            disabled={!projectId || !papers.length || scorePapers.isPending}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:opacity-50"
          >
            {scorePapers.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Score
          </button>
        </div>
        {scorePapers.isError ? (
          <div className="mb-3 rounded-md border border-[#e9b4c1] bg-white px-3 py-2 text-xs text-[#7b2d43]">
            Could not score papers. {scorePapers.error.message}
          </div>
        ) : null}
        <div className="space-y-2">
          {artifactRows.map(({ artifact, scoreTarget, sourceLabel }) => (
            <ArtifactFileCard
              key={artifact.id}
              artifact={artifact}
              scoreTarget={scoreTarget}
              sourceLabel={sourceLabel}
              onOpenArtifact={onOpenArtifact}
            />
          ))}
          {!artifacts.length ? (
            <div className="rounded-md border border-dashed border-stone-300 bg-white/70 p-4 text-sm text-stone-600">
              Crawl outputs, Markdown conversions, logs, and briefs appear here.
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
function ArtifactFileCard({
  artifact,
  scoreTarget,
  sourceLabel,
  onOpenArtifact
}: {
  artifact: Artifact;
  scoreTarget?: ArtifactScoreTarget;
  sourceLabel?: string;
  onOpenArtifact(artifactId: string): void;
}): JSX.Element {
  return (
    <article className="rounded-md border border-stone-200 bg-white p-3 shadow-sm transition hover:border-[#175c62] hover:shadow-md">
      <div className="mb-2 flex items-start gap-2">
        <button
          type="button"
          onClick={() => onOpenArtifact(artifact.id)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <ArtifactIcon artifact={artifact} className="mt-0.5 shrink-0 text-[#7b2d43]" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{artifact.title}</span>
            <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs text-stone-500">
              <span>{artifact.type}</span>
              {sourceLabel ? <span className="truncate">From {sourceLabel}</span> : null}
            </span>
          </span>
        </button>
        <ArtifactScoreControl target={scoreTarget} />
      </div>
    </article>
  );
}
export function ArtifactScoreControl({ target }: { target?: ArtifactScoreTarget }): JSX.Element | null {
  if (!target) return null;
  const score = target.score;
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ScoreChip score={score} />
      <div className="group/info relative">
        <button
          type="button"
          aria-label="Score details"
          className="grid size-7 place-items-center rounded-md border border-stone-200 bg-white text-stone-500 transition hover:border-[#175c62] hover:text-[#175c62]"
        >
          <Info size={13} />
        </button>
        <ScoreDetailsPopover target={target} />
      </div>
    </div>
  );
}
export function ScoreChip({ score }: { score?: PaperScore }): JSX.Element {
  return (
    <span className={`rounded-md border px-2 py-1 text-xs font-semibold tabular-nums ${scoreBadgeClasses(score?.label)}`}>
      {score ? Math.round(score.overall) : "--"}
    </span>
  );
}
function ScoreDetailsPopover({ target }: { target: ArtifactScoreTarget }): JSX.Element {
  const score = target.score;
  return (
    <div className="pointer-events-none absolute right-0 top-8 z-30 w-72 translate-y-1 rounded-md border border-stone-200 bg-white p-3 text-left opacity-0 shadow-xl transition group-hover/info:translate-y-0 group-hover/info:opacity-100 group-focus-within/info:translate-y-0 group-focus-within/info:opacity-100">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-stone-900">{target.title}</div>
          <div className="mt-0.5 text-[11px] text-stone-500">{target.subtitle}</div>
        </div>
        <span className={`rounded-md border px-2 py-1 text-xs font-semibold tabular-nums ${scoreBadgeClasses(score?.label)}`}>
          {score ? Math.round(score.overall) : "--"}
        </span>
      </div>
      {score ? (
        <>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-stone-500">{score.label}</div>
          <div className="space-y-1.5">
            {scoreComponentRows(score).map((component) => (
              <ScoreBar key={component.label} label={component.label} value={component.value} />
            ))}
          </div>
          <div className="mt-3 space-y-1">
            {score.reasons.slice(0, 3).map((reason) => (
              <div key={reason} className="text-[11px] leading-4 text-stone-600">
                {reason}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-[11px] leading-4 text-stone-600">Run Score to calculate paper quality details for this file.</div>
      )}
    </div>
  );
}
function ScoreBar({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_30px] items-center gap-2 text-[11px] text-stone-600">
      <span className="truncate">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-stone-200">
        <span className="block h-full rounded-full bg-[#175c62]" style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
      </span>
      <span className="text-right tabular-nums">{Math.round(value)}</span>
    </div>
  );
}
function scoreBadgeClasses(label?: PaperScore["label"]): string {
  switch (label) {
    case "excellent":
      return "border-[#175c62] bg-[#d8eadf] text-[#175c62]";
    case "strong":
      return "border-[#8aa66a] bg-[#edf4dc] text-[#476629]";
    case "solid":
      return "border-[#d2b05f] bg-[#fbf0c9] text-[#77581b]";
    case "emerging":
      return "border-[#d59670] bg-[#f8e2d1] text-[#854a2a]";
    case "limited":
      return "border-[#c77c8c] bg-[#f3d4dc] text-[#7b2d43]";
    default:
      return "border-stone-300 bg-stone-100 text-stone-500";
  }
}
