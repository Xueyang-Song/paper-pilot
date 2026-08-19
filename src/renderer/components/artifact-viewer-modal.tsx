import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Star,
  Trash2,
  X
} from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, Paper, PaperUpdate } from "../../shared/schemas";
import { HighlightedText } from "../lib/highlight";
import { ArtifactIcon, buildArtifactRows, formatBytes, formatJson } from "./artifact-helpers";
import { ArtifactScoreControl, ScoreChip } from "./artifact-panel";
import { PdfArtifactPreview } from "./pdf-artifact-preview";
import { IconButton, MarkdownMessage } from "./ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function ArtifactViewerModal({
  projectId,
  artifacts,
  papers,
  selectedArtifactId,
  onSelect,
  highlightQuery,
  initialSearchPage,
  onClearHighlight,
  onOpenSearch,
  onClose
}: {
  projectId: string;
  artifacts: Artifact[];
  papers: Paper[];
  selectedArtifactId: string;
  onSelect(artifactId: string): void;
  highlightQuery: string;
  initialSearchPage?: number;
  onClearHighlight(): void;
  onOpenSearch(): void;
  onClose(): void;
}): JSX.Element | null {
  const artifactRows = useMemo(() => buildArtifactRows(artifacts, papers), [artifacts, papers]);
  const selectedRow = artifactRows.find((row) => row.artifact.id === selectedArtifactId) ?? artifactRows[0];
  const selectedArtifact = selectedRow?.artifact;
  const selectedPaper = selectedRow?.scoreTarget?.paper;
  const isSelectedPdf = Boolean(
    selectedArtifact && (selectedArtifact.mime === "application/pdf" || selectedArtifact.type === "paper-pdf")
  );
  const queryClient = useQueryClient();
  const [activeHitIndex, setActiveHitIndex] = useState(0);
  const [textHitCount, setTextHitCount] = useState(0);
  const [pdfHitCount, setPdfHitCount] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(selectedArtifact?.title ?? "");
  const [draftTags, setDraftTags] = useState(selectedPaper?.tags?.join(", ") ?? "");
  const [draftNotes, setDraftNotes] = useState(selectedPaper?.notes ?? "");
  const [draftPaperTitle, setDraftPaperTitle] = useState(selectedPaper?.title ?? "");
  const [draftAuthors, setDraftAuthors] = useState(selectedPaper?.authors.join(", ") ?? "");
  const [draftYear, setDraftYear] = useState(selectedPaper?.year ? String(selectedPaper.year) : "");
  const [draftVenue, setDraftVenue] = useState(selectedPaper?.venue ?? "");
  const [draftDoi, setDraftDoi] = useState(selectedPaper?.doi ?? "");
  const contentQuery = useQuery({
    queryKey: ["artifact-content", projectId, selectedArtifact?.id],
    queryFn: () => readArtifactContent(projectId, selectedArtifact?.id ?? ""),
    enabled: Boolean(projectId && selectedArtifact)
  });
  const hitCount = isSelectedPdf ? pdfHitCount : textHitCount;
  const renameArtifact = useMutation({
    mutationFn: () => {
      if (!selectedArtifact) throw new Error("No artifact selected.");
      return window.paperPilot.renameArtifact({ projectId, artifactId: selectedArtifact.id, title: draftTitle });
    },
    onSuccess: () => {
      setEditingTitle(false);
      refreshBundle(projectId, queryClient);
    }
  });
  const deleteArtifact = useMutation({
    mutationFn: () => {
      if (!selectedArtifact) throw new Error("No artifact selected.");
      return window.paperPilot.deleteArtifacts({ projectId, artifactIds: [selectedArtifact.id] });
    },
    onSuccess: () => {
      refreshBundle(projectId, queryClient);
      const remaining = artifactRows.filter((row) => row.artifact.id !== selectedArtifact?.id);
      if (remaining[0]) onSelect(remaining[0].artifact.id);
      else onClose();
    }
  });
  const exportArtifact = useMutation({
    mutationFn: () => {
      if (!selectedArtifact) throw new Error("No artifact selected.");
      return window.paperPilot.exportArtifacts({ projectId, artifactIds: [selectedArtifact.id] });
    }
  });
  const reindexArtifact = useMutation({
    mutationFn: () => {
      if (!selectedArtifact) throw new Error("No artifact selected.");
      return window.paperPilot.reindexArtifacts({ projectId, artifactIds: [selectedArtifact.id] });
    },
    onSuccess: () => refreshBundle(projectId, queryClient)
  });
  const openSource = useMutation({
    mutationFn: () => {
      if (!selectedArtifact) throw new Error("No artifact selected.");
      return window.paperPilot.openArtifactSource({ projectId, artifactId: selectedArtifact.id });
    }
  });
  const updatePaper = useMutation({
    mutationFn: (patch: PaperUpdate["patch"]) => {
      if (!selectedPaper) throw new Error("No linked paper selected.");
      return window.paperPilot.updatePaper({ projectId, paperId: selectedPaper.id, patch });
    },
    onSuccess: () => refreshBundle(projectId, queryClient)
  });
  const deletePaper = useMutation({
    mutationFn: () => {
      if (!selectedPaper) throw new Error("No linked paper selected.");
      return window.paperPilot.deletePaper({ projectId, paperId: selectedPaper.id });
    },
    onSuccess: () => refreshBundle(projectId, queryClient)
  });
  const exportCitation = useMutation({
    mutationFn: () => {
      if (!selectedPaper) throw new Error("No linked paper selected.");
      return window.paperPilot.exportCitations({ projectId, paperIds: [selectedPaper.id], format: "bibtex" });
    }
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  useEffect(() => {
    if (
      selectedArtifactId &&
      artifactRows.length &&
      !artifactRows.some((row) => row.artifact.id === selectedArtifactId)
    ) {
      onSelect(artifactRows[0].artifact.id);
    }
  }, [artifactRows, onSelect, selectedArtifactId]);
  useEffect(() => {
    setActiveHitIndex(0);
    setTextHitCount(0);
    setPdfHitCount(0);
  }, [highlightQuery, selectedArtifact?.id]);
  useEffect(() => {
    setEditingTitle(false);
    setDraftTitle(selectedArtifact?.title ?? "");
    setDraftTags(selectedPaper?.tags?.join(", ") ?? "");
    setDraftNotes(selectedPaper?.notes ?? "");
    setDraftPaperTitle(selectedPaper?.title ?? "");
    setDraftAuthors(selectedPaper?.authors.join(", ") ?? "");
    setDraftYear(selectedPaper?.year ? String(selectedPaper.year) : "");
    setDraftVenue(selectedPaper?.venue ?? "");
    setDraftDoi(selectedPaper?.doi ?? "");
  }, [
    selectedArtifact?.id,
    selectedArtifact?.title,
    selectedPaper?.authors,
    selectedPaper?.doi,
    selectedPaper?.id,
    selectedPaper?.notes,
    selectedPaper?.tags,
    selectedPaper?.title,
    selectedPaper?.venue,
    selectedPaper?.year
  ]);
  useEffect(() => {
    if (hitCount > 0 && activeHitIndex >= hitCount) setActiveHitIndex(hitCount - 1);
  }, [activeHitIndex, hitCount]);
  function goToHit(delta: number): void {
    if (!hitCount) return;
    setActiveHitIndex((current) => (current + delta + hitCount) % hitCount);
  }
  if (!selectedArtifact) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="grid h-[calc(100dvh-2rem)] max-h-[980px] !w-[calc(100vw-2rem)] !max-w-[1500px] grid-cols-[300px_minmax(0,1fr)] gap-0 overflow-hidden border-border bg-popover p-0 shadow-2xl"
        showCloseButton={false}
      >
        <aside className="flex min-h-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
            <div>
              <div className="text-sm font-semibold">Files</div>
              <div className="text-xs text-muted-foreground">{artifactRows.length} artifacts</div>
            </div>
            <IconButton label="Close viewer" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3">
              <div className="space-y-1">
                {artifactRows.map(({ artifact, scoreTarget, sourceLabel }) => {
                  const selected = artifact.id === selectedArtifact.id;
                  return (
                    <button
                      key={artifact.id}
                      type="button"
                      onClick={() => onSelect(artifact.id)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition",
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "text-sidebar-foreground hover:bg-sidebar-accent"
                      )}
                    >
                      <ArtifactIcon
                        artifact={artifact}
                        className={cn("mt-0.5 shrink-0", selected ? "text-primary-foreground" : "text-primary")}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{artifact.title}</span>
                        <span
                          className={cn(
                            "mt-0.5 block truncate text-xs",
                            selected ? "text-primary-foreground/70" : "text-muted-foreground"
                          )}
                        >
                          {artifact.type}
                          {sourceLabel ? ` / From ${sourceLabel}` : ""}
                        </span>
                      </span>
                      {scoreTarget ? <ScoreChip score={scoreTarget.score} /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </ScrollArea>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-5">
            <div className="min-w-0">
              {editingTitle ? (
                <div className="flex min-w-0 items-center gap-2">
                  <Input
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    className="h-8 min-w-0 flex-1 text-sm font-semibold"
                    maxLength={180}
                  />
                  <HeaderButton
                    label="Save title"
                    onClick={() => renameArtifact.mutate()}
                    disabled={renameArtifact.isPending}
                  >
                    {renameArtifact.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  </HeaderButton>
                </div>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-base font-semibold">{selectedArtifact.title}</div>
                  <HeaderButton label="Rename file" onClick={() => setEditingTitle(true)}>
                    <Pencil size={13} />
                  </HeaderButton>
                </div>
              )}
              <div className="mt-0.5 flex gap-3 text-xs text-muted-foreground">
                <span>{selectedArtifact.type}</span>
                {selectedRow.sourceLabel ? <span>From {selectedRow.sourceLabel}</span> : null}
                <span>{selectedArtifact.mime}</span>
                {contentQuery.data ? <span>{formatBytes(contentQuery.data.size)}</span> : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <IconButton label="Search this file" onClick={onOpenSearch}>
                <Search size={18} />
              </IconButton>
              {highlightQuery.trim() ? (
                <div className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-border bg-background">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Previous hit"
                    aria-label="Previous hit"
                    onClick={() => goToHit(-1)}
                    disabled={!hitCount}
                    className="rounded-none"
                  >
                    <ChevronUp size={15} />
                  </Button>
                  <div className="min-w-14 border-x border-border px-2 text-center text-[11px] font-medium tabular-nums text-muted-foreground">
                    {hitCount ? `${activeHitIndex + 1}/${hitCount}` : "0/0"}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Next hit"
                    aria-label="Next hit"
                    onClick={() => goToHit(1)}
                    disabled={!hitCount}
                    className="rounded-none"
                  >
                    <ChevronDown size={15} />
                  </Button>
                </div>
              ) : null}
              {highlightQuery.trim() ? (
                <Button type="button" variant="secondary" size="sm" onClick={onClearHighlight} className="max-w-56">
                  <Search size={13} />
                  <span className="truncate">{highlightQuery}</span>
                  <X size={12} />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => revealArtifactLocation(projectId, selectedArtifact.id)}
              >
                <FolderOpen size={13} />
                Show in folder
              </Button>
              <HeaderButton
                label="Open original source"
                onClick={() => openSource.mutate()}
                disabled={openSource.isPending}
              >
                <ExternalLink size={13} />
              </HeaderButton>
              <HeaderButton
                label="Export file"
                onClick={() => exportArtifact.mutate()}
                disabled={exportArtifact.isPending}
              >
                <Download size={13} />
              </HeaderButton>
              <HeaderButton
                label="Reindex file"
                onClick={() => reindexArtifact.mutate()}
                disabled={reindexArtifact.isPending}
              >
                {reindexArtifact.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              </HeaderButton>
              <HeaderButton
                label="Delete file"
                danger
                onClick={() => {
                  if (window.confirm(`Delete "${selectedArtifact.title}"?`)) deleteArtifact.mutate();
                }}
                disabled={deleteArtifact.isPending}
              >
                <Trash2 size={13} />
              </HeaderButton>
              <ArtifactScoreControl target={selectedRow.scoreTarget} />
            </div>
          </header>
          {selectedPaper ? (
            <div className="shrink-0 border-b border-border bg-background px-5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <HeaderButton
                  label={selectedPaper.favorite ? "Remove favorite" : "Favorite paper"}
                  active={selectedPaper.favorite}
                  onClick={() => updatePaper.mutate({ favorite: !selectedPaper.favorite })}
                >
                  <Star size={13} />
                </HeaderButton>
                <Select
                  value={selectedPaper.userStatus ?? "unread"}
                  onValueChange={(value) => updatePaper.mutate({ userStatus: value as Paper["userStatus"] })}
                >
                  <SelectTrigger className="h-8 w-32">
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
                <Input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  onBlur={() => updatePaper.mutate({ tags: splitTags(draftTags) })}
                  placeholder="Tags"
                  className="h-8 min-w-32 text-xs"
                />
                <Input
                  value={draftNotes}
                  onChange={(event) => setDraftNotes(event.target.value)}
                  onBlur={() => updatePaper.mutate({ notes: draftNotes.trim() })}
                  placeholder="Notes"
                  className="h-8 min-w-0 flex-1 text-xs"
                />
                <HeaderButton
                  label="Export citation"
                  onClick={() => exportCitation.mutate()}
                  disabled={exportCitation.isPending}
                >
                  <FileText size={13} />
                </HeaderButton>
                <HeaderButton
                  label="Remove paper record"
                  danger
                  onClick={() => {
                    if (window.confirm(`Remove the paper record for "${selectedPaper.title}"? Files will remain.`))
                      deletePaper.mutate();
                  }}
                  disabled={deletePaper.isPending}
                >
                  <Trash2 size={13} />
                </HeaderButton>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_70px_minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <PaperField
                  label="Paper title"
                  value={draftPaperTitle}
                  onChange={setDraftPaperTitle}
                  onCommit={() => {
                    if (draftPaperTitle.trim() && draftPaperTitle.trim() !== selectedPaper.title) {
                      updatePaper.mutate({ title: draftPaperTitle.trim() });
                    }
                  }}
                />
                <PaperField
                  label="Authors"
                  value={draftAuthors}
                  onChange={setDraftAuthors}
                  onCommit={() => updatePaper.mutate({ authors: splitTags(draftAuthors) })}
                />
                <PaperField
                  label="Year"
                  value={draftYear}
                  onChange={setDraftYear}
                  onCommit={() => {
                    const year = Number(draftYear);
                    if (Number.isInteger(year)) updatePaper.mutate({ year });
                  }}
                />
                <PaperField
                  label="Venue"
                  value={draftVenue}
                  onChange={setDraftVenue}
                  onCommit={() => updatePaper.mutate({ venue: draftVenue.trim() })}
                />
                <PaperField
                  label="DOI"
                  value={draftDoi}
                  onChange={setDraftDoi}
                  onCommit={() => updatePaper.mutate({ doi: draftDoi.trim() })}
                />
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/35">
            <ArtifactPreview
              artifact={selectedArtifact}
              data={contentQuery.data}
              isLoading={contentQuery.isLoading}
              error={contentQuery.error}
              highlightQuery={highlightQuery}
              activeHitIndex={activeHitIndex}
              onHitCountChange={isSelectedPdf ? setPdfHitCount : setTextHitCount}
              onActiveHitIndexChange={setActiveHitIndex}
              pdfSearchPage={initialSearchPage}
            />
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}
function ArtifactPreview({
  artifact,
  data,
  isLoading,
  error,
  highlightQuery,
  activeHitIndex,
  onHitCountChange,
  onActiveHitIndexChange,
  pdfSearchPage
}: {
  artifact: Artifact;
  data?: Awaited<ReturnType<Window["paperPilot"]["readArtifact"]>>;
  isLoading: boolean;
  error: Error | null;
  highlightQuery: string;
  activeHitIndex: number;
  onHitCountChange(hitCount: number): void;
  onActiveHitIndexChange(hitIndex: number): void;
  pdfSearchPage?: number;
}): JSX.Element {
  useEffect(() => {
    if (!highlightQuery.trim()) onHitCountChange(0);
  }, [artifact.id, highlightQuery, onHitCountChange]);
  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading artifact
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-8">
        <Alert variant="destructive" className="max-w-xl">
          <AlertDescription>Could not open this artifact. {error.message}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!data) return <div className="h-full" />;
  if (data.encoding === "base64") {
    if (artifact.mime === "application/pdf" || artifact.type === "paper-pdf") {
      return (
        <PdfArtifactPreview
          artifact={artifact}
          fallbackBase64={data.content}
          searchPage={pdfSearchPage}
          highlightQuery={highlightQuery}
          activeHitIndex={activeHitIndex}
          onHitCountChange={onHitCountChange}
          onActiveHitIndexChange={onActiveHitIndexChange}
        />
      );
    }
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground shadow-sm">
          Binary preview is not available for this file type.
        </div>
      </div>
    );
  }
  if (data.truncated) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-chart-4/40 bg-chart-4/10 px-5 py-2 text-xs text-chart-4">
          Preview is truncated at 2 MB for responsiveness.
        </div>
        <TextArtifactPreview
          artifact={artifact}
          content={data.content}
          highlightQuery={highlightQuery}
          activeHitIndex={activeHitIndex}
          onHitCountChange={onHitCountChange}
        />
      </div>
    );
  }
  return (
    <TextArtifactPreview
      artifact={artifact}
      content={data.content}
      highlightQuery={highlightQuery}
      activeHitIndex={activeHitIndex}
      onHitCountChange={onHitCountChange}
    />
  );
}
function TextArtifactPreview({
  artifact,
  content,
  highlightQuery,
  activeHitIndex,
  onHitCountChange
}: {
  artifact: Artifact;
  content: string;
  highlightQuery: string;
  activeHitIndex: number;
  onHitCountChange(hitCount: number): void;
}): JSX.Element {
  if (artifact.type === "metadata-json" || artifact.mime === "application/json") {
    return (
      <CodeViewer
        content={formatJson(content)}
        highlightQuery={highlightQuery}
        activeHitIndex={activeHitIndex}
        onHitCountChange={onHitCountChange}
      />
    );
  }
  if (highlightQuery.trim()) {
    return (
      <CodeViewer
        content={content}
        highlightQuery={highlightQuery}
        activeHitIndex={activeHitIndex}
        onHitCountChange={onHitCountChange}
      />
    );
  }
  if (artifact.type === "markdown" || artifact.type === "brief") {
    return (
      <div className="h-full overflow-y-auto px-8 py-7">
        <Card className="mx-auto max-w-4xl rounded-lg border-border bg-card px-7 py-6 shadow-sm">
          <MarkdownMessage content={content} isUser={false} />
        </Card>
      </div>
    );
  }
  return (
    <CodeViewer
      content={content}
      highlightQuery={highlightQuery}
      activeHitIndex={activeHitIndex}
      onHitCountChange={onHitCountChange}
    />
  );
}
function CodeViewer({
  content,
  highlightQuery,
  activeHitIndex,
  onHitCountChange
}: {
  content: string;
  highlightQuery?: string;
  activeHitIndex: number;
  onHitCountChange(hitCount: number): void;
}): JSX.Element {
  return (
    <div className="h-full overflow-auto bg-[oklch(0.13_0.015_248)] p-5 text-slate-100">
      <pre className="m-0 min-w-full whitespace-pre-wrap break-words font-mono text-xs leading-5">
        <HighlightedText
          value={content}
          query={highlightQuery ?? ""}
          tone="dark"
          activeHitIndex={activeHitIndex}
          onHitCountChange={onHitCountChange}
          scrollToActive
        />
      </pre>
    </div>
  );
}
function readArtifactContent(projectId: string, artifactId: string): ReturnType<Window["paperPilot"]["readArtifact"]> {
  if (typeof window.paperPilot.readArtifact !== "function") {
    throw new Error(
      "Artifact viewer bridge is unavailable. Restart Paper Pilot so the updated preload script is loaded."
    );
  }
  return window.paperPilot.readArtifact({ projectId, artifactId });
}
function revealArtifactLocation(projectId: string | undefined, artifactId: string): void {
  if (!projectId) return;
  void window.paperPilot.revealArtifact({ projectId, artifactId });
}

function HeaderButton({
  label,
  active,
  danger,
  disabled,
  onClick,
  children
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
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
      variant={danger ? "destructive" : active ? "secondary" : "outline"}
      size="icon"
      className={cn("shrink-0", active && "text-chart-4")}
    >
      {children}
    </Button>
  );
}

function PaperField({
  label,
  value,
  onChange,
  onCommit
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  onCommit(): void;
}): JSX.Element {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        className="h-8 w-full text-xs"
      />
    </label>
  );
}

function refreshBundle(projectId: string, queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
  void queryClient.invalidateQueries({ queryKey: ["artifact-content", projectId] });
}

function splitTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 20);
}
