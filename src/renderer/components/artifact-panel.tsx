import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckSquare, Download, FilePlus2, Info, Loader2, Pencil, RefreshCw, Save, Square, Star, Trash2, X } from "lucide-react";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { Artifact, Paper, PaperScore, PaperUpdate } from "../../shared/schemas";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
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
  const importArtifacts = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Select a project before importing files.");
      return window.paperPilot.importArtifacts({ projectId });
    },
    onSuccess: () => refreshProject(projectId, queryClient)
  });
  const deleteArtifacts = useMutation({
    mutationFn: (artifactIds: string[]) => {
      if (!projectId) throw new Error("Select a project before deleting files.");
      return window.paperPilot.deleteArtifacts({ projectId, artifactIds });
    },
    onSuccess: () => {
      setSelectedIds(new Set());
      refreshProject(projectId, queryClient);
    }
  });
  const exportArtifacts = useMutation({
    mutationFn: (artifactIds: string[]) => {
      if (!projectId) throw new Error("Select a project before exporting files.");
      return window.paperPilot.exportArtifacts({ projectId, artifactIds });
    }
  });
  const reindexArtifacts = useMutation({
    mutationFn: (artifactIds: string[]) => {
      if (!projectId) throw new Error("Select a project before reindexing files.");
      return window.paperPilot.reindexArtifacts({ projectId, artifactIds });
    },
    onSuccess: () => refreshProject(projectId, queryClient)
  });
  const artifactRows = useMemo(() => buildArtifactRows(artifacts, papers), [artifacts, papers]);
  const scoredCount = papers.filter((paper) => Boolean(paper.score)).length;
  const selectedArtifactIds = [...selectedIds].filter((artifactId) => artifacts.some((artifact) => artifact.id === artifactId));
  const allVisibleSelected = artifactRows.length > 0 && artifactRows.every((row) => selectedIds.has(row.artifact.id));
  function toggleSelected(artifactId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(artifactId)) next.delete(artifactId);
      else next.add(artifactId);
      return next;
    });
  }
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
        <div className="mb-3 rounded-md border border-stone-200 bg-white p-2 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() =>
                setSelectedIds(allVisibleSelected ? new Set() : new Set(artifactRows.map((row) => row.artifact.id)))
              }
              className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 px-2 text-xs font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62]"
            >
              {allVisibleSelected ? <CheckSquare size={13} /> : <Square size={13} />}
              {selectedArtifactIds.length ? `${selectedArtifactIds.length} selected` : "Select"}
            </button>
            <button
              type="button"
              onClick={() => importArtifacts.mutate()}
              disabled={!projectId || importArtifacts.isPending}
              className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 px-2 text-xs font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:opacity-50"
            >
              {importArtifacts.isPending ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
              Import
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <BulkButton
              label="Export"
              icon={<Download size={13} />}
              disabled={!selectedArtifactIds.length || exportArtifacts.isPending}
              onClick={() => exportArtifacts.mutate(selectedArtifactIds)}
            />
            <BulkButton
              label="Reindex"
              icon={reindexArtifacts.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              disabled={!selectedArtifactIds.length || reindexArtifacts.isPending}
              onClick={() => reindexArtifacts.mutate(selectedArtifactIds)}
            />
            <BulkButton
              label="Delete"
              icon={<Trash2 size={13} />}
              danger
              disabled={!selectedArtifactIds.length || deleteArtifacts.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${selectedArtifactIds.length} selected file(s)?`)) {
                  deleteArtifacts.mutate(selectedArtifactIds);
                }
              }}
            />
          </div>
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
              projectId={projectId}
              selected={selectedIds.has(artifact.id)}
              onToggleSelected={() => toggleSelected(artifact.id)}
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
  projectId,
  selected,
  onToggleSelected,
  onOpenArtifact
}: {
  artifact: Artifact;
  scoreTarget?: ArtifactScoreTarget;
  sourceLabel?: string;
  projectId?: string;
  selected: boolean;
  onToggleSelected(): void;
  onOpenArtifact(artifactId: string): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(artifact.title);
  const renameArtifact = useMutation({
    mutationFn: () => {
      if (!projectId) throw new Error("Select a project before renaming files.");
      return window.paperPilot.renameArtifact({ projectId, artifactId: artifact.id, title: draftTitle });
    },
    onSuccess: () => {
      setEditingTitle(false);
      refreshProject(projectId, queryClient);
    }
  });
  const updatePaper = useMutation({
    mutationFn: (patch: PaperUpdate["patch"]) => {
      const paper = scoreTarget?.paper;
      if (!projectId || !paper) throw new Error("No paper is linked to this file.");
      return window.paperPilot.updatePaper({ projectId, paperId: paper.id, patch });
    },
    onSuccess: () => refreshProject(projectId, queryClient)
  });
  return (
    <article className="rounded-md border border-stone-200 bg-white p-3 shadow-sm transition hover:border-[#175c62] hover:shadow-md">
      <div className="mb-2 flex items-start gap-2">
        <button
          type="button"
          onClick={onToggleSelected}
          title={selected ? "Deselect file" : "Select file"}
          aria-label={selected ? "Deselect file" : "Select file"}
          className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-stone-200 text-stone-600 transition hover:border-[#175c62] hover:text-[#175c62]"
        >
          {selected ? <CheckSquare size={14} /> : <Square size={14} />}
        </button>
        {editingTitle ? (
          <div className="flex min-w-0 flex-1 items-start gap-2 text-left">
            <ArtifactIcon artifact={artifact} className="mt-0.5 shrink-0 text-[#7b2d43]" />
            <span className="min-w-0 flex-1">
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="h-7 w-full rounded-md border border-stone-300 px-2 text-xs text-stone-900 outline-none focus:border-[#175c62]"
                maxLength={180}
              />
              <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs text-stone-500">
                <span>{artifact.type}</span>
                {sourceLabel ? <span className="truncate">From {sourceLabel}</span> : null}
              </span>
            </span>
          </div>
        ) : (
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
        )}
        {editingTitle ? (
          <div className="flex shrink-0 gap-1">
            <TinyIcon label="Save title" onClick={() => renameArtifact.mutate()} disabled={renameArtifact.isPending}>
              {renameArtifact.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            </TinyIcon>
            <TinyIcon
              label="Cancel rename"
              onClick={() => {
                setDraftTitle(artifact.title);
                setEditingTitle(false);
              }}
            >
              <X size={12} />
            </TinyIcon>
          </div>
        ) : (
          <TinyIcon label="Rename file" onClick={() => setEditingTitle(true)}>
            <Pencil size={12} />
          </TinyIcon>
        )}
        <ArtifactScoreControl target={scoreTarget} />
      </div>
      {scoreTarget?.paper ? (
        <div className="mt-2 flex items-center gap-1 border-t border-stone-100 pt-2">
          <TinyIcon
            label={scoreTarget.paper.favorite ? "Remove favorite" : "Favorite paper"}
            active={scoreTarget.paper.favorite}
            onClick={() => updatePaper.mutate({ favorite: !scoreTarget.paper?.favorite })}
          >
            <Star size={12} />
          </TinyIcon>
          <select
            value={scoreTarget.paper.userStatus ?? "unread"}
            onChange={(event) => updatePaper.mutate({ userStatus: event.target.value as Paper["userStatus"] })}
            className="h-7 min-w-0 rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-700 outline-none focus:border-[#175c62]"
          >
            <option value="unread">Unread</option>
            <option value="to-read">To read</option>
            <option value="reading">Reading</option>
            <option value="read">Read</option>
            <option value="rejected">Rejected</option>
          </select>
          {scoreTarget.paper.tags?.length ? (
            <span className="truncate text-[11px] text-stone-500">{scoreTarget.paper.tags.slice(0, 2).join(", ")}</span>
          ) : null}
        </div>
      ) : null}
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

function BulkButton({
  label,
  icon,
  danger,
  disabled,
  onClick
}: {
  label: string;
  icon: JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  onClick(): void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
        danger
          ? "border-[#e9b4c1] text-[#7b2d43] hover:border-[#7b2d43]"
          : "border-stone-300 text-stone-700 hover:border-[#175c62] hover:text-[#175c62]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function TinyIcon({
  label,
  active,
  disabled,
  onClick,
  children
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`grid size-7 shrink-0 place-items-center rounded-md border transition disabled:opacity-50 ${
        active
          ? "border-[#d2b05f] bg-[#fbf0c9] text-[#77581b]"
          : "border-stone-200 bg-white text-stone-500 hover:border-[#175c62] hover:text-[#175c62]"
      }`}
    >
      {children}
    </button>
  );
}

function refreshProject(projectId: string | undefined, queryClient: ReturnType<typeof useQueryClient>): void {
  if (!projectId) return;
  void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
}
