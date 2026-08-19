import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckSquare,
  Download,
  FilePlus2,
  Info,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Square,
  Star,
  Trash2,
  X
} from "lucide-react";
import type { JSX } from "react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Artifact, Paper, PaperScore, PaperUpdate } from "../../shared/schemas";
import { Metric } from "./ui";
import { ArtifactIcon, buildArtifactRows, scoreComponentRows, type ArtifactScoreTarget } from "./artifact-helpers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

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
  const generatedRows = artifactRows.filter((row) => row.artifact.type === "chat-answer");
  const sourceRows = artifactRows.filter((row) => row.artifact.type !== "chat-answer");
  const scoredCount = papers.filter((paper) => Boolean(paper.score)).length;
  const selectedArtifactIds = [...selectedIds].filter((artifactId) =>
    artifacts.some((artifact) => artifact.id === artifactId)
  );
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
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-muted/35">
      <div className="flex h-12 items-center justify-between border-b border-border bg-card px-4">
        <div className="text-sm font-semibold">Artifacts</div>
        <Archive size={16} className="text-muted-foreground" />
      </div>
      <ScrollArea className="min-h-0 min-w-0 w-full flex-1">
        <div className="min-w-0 p-3 pr-4">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Metric label="Papers" value={papers.length} />
            <Metric label="Files" value={artifacts.length} />
          </div>
          <Card className="mb-3 w-full max-w-full min-w-0 rounded-lg border-border bg-card p-2 py-2 shadow-sm">
            <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setSelectedIds(allVisibleSelected ? new Set() : new Set(artifactRows.map((row) => row.artifact.id)))
                }
              >
                {allVisibleSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                {selectedArtifactIds.length ? `${selectedArtifactIds.length} selected` : "Select"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => importArtifacts.mutate()}
                disabled={!projectId || importArtifacts.isPending}
              >
                {importArtifacts.isPending ? <Loader2 size={13} className="animate-spin" /> : <FilePlus2 size={13} />}
                Import
              </Button>
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
                icon={
                  reindexArtifacts.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />
                }
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
          </Card>
          <Card className="mb-3 w-full max-w-full min-w-0 flex-row items-center justify-between gap-2 rounded-lg border-border bg-card p-3 py-3 shadow-sm">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Scores</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {scoredCount}/{papers.length} papers scored
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => scorePapers.mutate()}
              disabled={!projectId || !papers.length || scorePapers.isPending}
            >
              {scorePapers.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Score
            </Button>
          </Card>
          {scorePapers.isError ? (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-card px-3 py-2 text-xs text-destructive">
              Could not score papers. {scorePapers.error.message}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2">
            {generatedRows.length ? (
              <div className="mt-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Generated answers · {generatedRows.length}
              </div>
            ) : null}
            {generatedRows.map(({ artifact, scoreTarget, sourceLabel }) => (
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
            {sourceRows.length ? (
              <div className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Sources and project files · {sourceRows.length}
              </div>
            ) : null}
            {sourceRows.map(({ artifact, scoreTarget, sourceLabel }) => (
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
              <div className="rounded-lg border border-dashed border-border bg-card/70 p-4 text-sm text-muted-foreground">
                Crawl outputs, Markdown conversions, logs, and briefs appear here.
              </div>
            ) : null}
          </div>
        </div>
      </ScrollArea>
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
    <Card className="w-full max-w-full min-w-0 overflow-visible rounded-lg border-border bg-card p-3 py-3 shadow-sm transition hover:border-primary/70 hover:shadow-md">
      <div className="flex min-w-0 items-start gap-2">
        <Button
          type="button"
          variant={selected ? "secondary" : "outline"}
          size="icon-sm"
          onClick={onToggleSelected}
          title={selected ? "Deselect file" : "Select file"}
          aria-label={selected ? "Deselect file" : "Select file"}
          className="mt-0.5 shrink-0"
        >
          {selected ? <CheckSquare size={14} /> : <Square size={14} />}
        </Button>
        {editingTitle ? (
          <div className="flex min-w-0 flex-1 items-start gap-2 text-left">
            <ArtifactIcon artifact={artifact} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 overflow-hidden">
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="h-7 text-xs"
                maxLength={180}
              />
              <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>{artifact.type}</span>
                {sourceLabel ? <span className="truncate">From {sourceLabel}</span> : null}
              </span>
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onOpenArtifact(artifact.id)}
            className="flex min-w-0 flex-1 items-start gap-2 overflow-hidden text-left"
          >
            <ArtifactIcon artifact={artifact} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className="block truncate text-sm font-medium">{artifact.title}</span>
              <span className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>{artifact.type}</span>
                {sourceLabel ? <span className="truncate">From {sourceLabel}</span> : null}
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1 border-t border-border/70 pt-2">
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
        {scoreTarget?.paper ? (
          <>
            <TinyIcon
              label={scoreTarget.paper.favorite ? "Remove favorite" : "Favorite paper"}
              active={scoreTarget.paper.favorite}
              onClick={() => updatePaper.mutate({ favorite: !scoreTarget.paper?.favorite })}
            >
              <Star size={12} />
            </TinyIcon>
            <Select
              value={scoreTarget.paper.userStatus ?? "unread"}
              onValueChange={(value) => updatePaper.mutate({ userStatus: value as Paper["userStatus"] })}
            >
              <SelectTrigger size="sm" className="h-7 w-32 min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unread">Unread</SelectItem>
                <SelectItem value="to-read">To read</SelectItem>
                <SelectItem value="reading">Reading</SelectItem>
                <SelectItem value="read">Read</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            {scoreTarget.paper.tags?.length ? (
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                {scoreTarget.paper.tags.slice(0, 2).join(", ")}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </Card>
  );
}
export function ArtifactScoreControl({ target }: { target?: ArtifactScoreTarget }): JSX.Element | null {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<ScorePopoverPosition | undefined>(undefined);
  if (!target) return null;
  const score = target.score;

  function showPopover(): void {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 288;
    const margin = 12;
    const estimatedHeight = 330;
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    const top =
      rect.bottom + estimatedHeight + margin > window.innerHeight
        ? Math.max(margin, rect.top - estimatedHeight - 8)
        : rect.bottom + 8;
    setPopoverPosition({ left, top });
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ScoreChip score={score} />
      <div
        ref={triggerRef}
        className="relative"
        onMouseEnter={showPopover}
        onMouseLeave={() => setPopoverPosition(undefined)}
        onFocusCapture={showPopover}
        onBlurCapture={() => setPopoverPosition(undefined)}
      >
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label="Score details"
          onMouseEnter={showPopover}
          onFocus={showPopover}
          onClick={showPopover}
        >
          <Info size={13} />
        </Button>
        {popoverPosition
          ? createPortal(<ScoreDetailsPopover target={target} position={popoverPosition} />, document.body)
          : null}
      </div>
    </div>
  );
}
export function ScoreChip({ score }: { score?: PaperScore }): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={`h-7 rounded-lg px-2 text-xs font-semibold tabular-nums ${scoreBadgeClasses(score?.label)}`}
    >
      {score ? Math.round(score.overall) : "--"}
    </Badge>
  );
}
interface ScorePopoverPosition {
  left: number;
  top: number;
}

function ScoreDetailsPopover({
  target,
  position
}: {
  target: ArtifactScoreTarget;
  position: ScorePopoverPosition;
}): JSX.Element {
  const score = target.score;
  return (
    <div
      className="pointer-events-none fixed z-[80] max-h-[calc(100vh-1.5rem)] w-72 overflow-auto rounded-lg border border-border bg-popover p-3 text-left text-popover-foreground opacity-100 shadow-xl"
      style={{ left: position.left, top: position.top }}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-foreground">{target.title}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{target.subtitle}</div>
        </div>
        <ScoreChip score={score} />
      </div>
      {score ? (
        <>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {score.label}
          </div>
          <div className="space-y-1.5">
            {scoreComponentRows(score).map((component) => (
              <ScoreBar key={component.label} label={component.label} value={component.value} />
            ))}
          </div>
          <div className="mt-3 space-y-1">
            {score.reasons.slice(0, 3).map((reason) => (
              <div key={reason} className="text-[11px] leading-4 text-muted-foreground">
                {reason}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-[11px] leading-4 text-muted-foreground">
          Run Score to calculate paper quality details for this file.
        </div>
      )}
    </div>
  );
}
function ScoreBar({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_30px] items-center gap-2 text-[11px] text-muted-foreground">
      <span className="truncate">{label}</span>
      <Progress value={Math.max(4, Math.min(100, value))} />
      <span className="text-right tabular-nums">{Math.round(value)}</span>
    </div>
  );
}
function scoreBadgeClasses(label?: PaperScore["label"]): string {
  switch (label) {
    case "excellent":
      return "border-primary/50 bg-primary/15 text-primary";
    case "strong":
      return "border-chart-2/50 bg-chart-2/15 text-chart-2";
    case "solid":
      return "border-chart-4/50 bg-chart-4/15 text-chart-4";
    case "emerging":
      return "border-chart-5/50 bg-chart-5/15 text-chart-5";
    case "limited":
      return "border-destructive/50 bg-destructive/15 text-destructive";
    default:
      return "border-border bg-muted text-muted-foreground";
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
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      variant={danger ? "destructive" : "outline"}
      size="sm"
      className="h-8 w-full min-w-0 gap-1 px-1.5 text-xs"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
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
    <Button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      variant={active ? "secondary" : "outline"}
      size="icon-sm"
      className={cn("shrink-0", active && "text-chart-4")}
    >
      {children}
    </Button>
  );
}

function refreshProject(projectId: string | undefined, queryClient: ReturnType<typeof useQueryClient>): void {
  if (!projectId) return;
  void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
}
