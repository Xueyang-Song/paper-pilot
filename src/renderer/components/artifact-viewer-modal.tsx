import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, Download, ExternalLink, FileText, FolderOpen, Loader2, Pencil, RefreshCw, Save, Search, Star, Trash2, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, Paper, PaperUpdate } from "../../shared/schemas";
import { HighlightedText } from "../lib/highlight";
import { ArtifactIcon, base64ToBlob, buildArtifactRows, formatBytes, formatJson } from "./artifact-helpers";
import { ArtifactScoreControl, ScoreChip } from "./artifact-panel";
import { PdfArtifactPreview } from "./pdf-artifact-preview";
import { IconButton, MarkdownMessage } from "./ui";

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
  const isSelectedPdf = Boolean(selectedArtifact && (selectedArtifact.mime === "application/pdf" || selectedArtifact.type === "paper-pdf"));
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
    if (selectedArtifactId && artifactRows.length && !artifactRows.some((row) => row.artifact.id === selectedArtifactId)) {
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
    <div className="fixed inset-0 z-50 bg-stone-950/55 p-5">
      <motion.div
        initial={{ opacity: 0, scale: 0.985, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="mx-auto grid h-full max-h-[980px] w-full max-w-[1500px] grid-cols-[300px_minmax(0,1fr)] overflow-hidden rounded-md border border-stone-300 bg-[#fbfaf6] shadow-2xl"
      >
        <aside className="flex min-h-0 flex-col border-r border-stone-200 bg-[#ede7dc]">
          <div className="flex h-16 items-center justify-between border-b border-stone-300 px-4">
            <div>
              <div className="text-sm font-semibold">Files</div>
              <div className="text-xs text-stone-600">{artifactRows.length} artifacts</div>
            </div>
            <IconButton label="Close viewer" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="space-y-1">
              {artifactRows.map(({ artifact, scoreTarget, sourceLabel }) => {
                const selected = artifact.id === selectedArtifact.id;
                return (
                  <button
                    key={artifact.id}
                    type="button"
                    onClick={() => onSelect(artifact.id)}
                    className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition ${
                      selected ? "bg-stone-950 text-[#f4efe6]" : "text-stone-800 hover:bg-white/70"
                    }`}
                  >
                    <ArtifactIcon artifact={artifact} className={`mt-0.5 shrink-0 ${selected ? "text-[#f4efe6]" : "text-[#7b2d43]"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{artifact.title}</span>
                      <span className={`mt-0.5 block truncate text-xs ${selected ? "text-stone-300" : "text-stone-600"}`}>
                        {artifact.type}
                        {sourceLabel ? ` | From ${sourceLabel}` : ""}
                      </span>
                    </span>
                    {scoreTarget ? <ScoreChip score={scoreTarget.score} /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-stone-200 bg-white px-5">
            <div className="min-w-0">
              {editingTitle ? (
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-md border border-stone-300 px-2 text-sm font-semibold outline-none focus:border-[#175c62]"
                    maxLength={180}
                  />
                  <HeaderButton label="Save title" onClick={() => renameArtifact.mutate()} disabled={renameArtifact.isPending}>
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
              <div className="mt-0.5 flex gap-3 text-xs text-stone-600">
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
                <div className="inline-flex h-8 items-center overflow-hidden rounded-md border border-stone-300 bg-white">
                  <button
                    type="button"
                    title="Previous hit"
                    aria-label="Previous hit"
                    onClick={() => goToHit(-1)}
                    disabled={!hitCount}
                    className="grid size-8 place-items-center text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <div className="min-w-14 border-x border-stone-200 px-2 text-center text-[11px] font-medium tabular-nums text-stone-600">
                    {hitCount ? `${activeHitIndex + 1}/${hitCount}` : "0/0"}
                  </div>
                  <button
                    type="button"
                    title="Next hit"
                    aria-label="Next hit"
                    onClick={() => goToHit(1)}
                    disabled={!hitCount}
                    className="grid size-8 place-items-center text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronDown size={15} />
                  </button>
                </div>
              ) : null}
              {highlightQuery.trim() ? (
                <button
                  type="button"
                  onClick={onClearHighlight}
                  className="inline-flex h-8 max-w-56 items-center gap-2 rounded-md border border-[#d2b05f] bg-[#fbf0c9] px-3 text-xs font-medium text-[#77581b] transition hover:border-[#9d7a2a]"
                >
                  <Search size={13} />
                  <span className="truncate">{highlightQuery}</span>
                  <X size={12} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => revealArtifactLocation(projectId, selectedArtifact.id)}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62]"
              >
                <FolderOpen size={13} />
                Show in folder
              </button>
              <HeaderButton label="Open original source" onClick={() => openSource.mutate()} disabled={openSource.isPending}>
                <ExternalLink size={13} />
              </HeaderButton>
              <HeaderButton label="Export file" onClick={() => exportArtifact.mutate()} disabled={exportArtifact.isPending}>
                <Download size={13} />
              </HeaderButton>
              <HeaderButton label="Reindex file" onClick={() => reindexArtifact.mutate()} disabled={reindexArtifact.isPending}>
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
            <div className="shrink-0 border-b border-stone-200 bg-[#fbfaf6] px-5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <HeaderButton
                  label={selectedPaper.favorite ? "Remove favorite" : "Favorite paper"}
                  active={selectedPaper.favorite}
                  onClick={() => updatePaper.mutate({ favorite: !selectedPaper.favorite })}
                >
                  <Star size={13} />
                </HeaderButton>
                <select
                  value={selectedPaper.userStatus ?? "unread"}
                  onChange={(event) => updatePaper.mutate({ userStatus: event.target.value as Paper["userStatus"] })}
                  className="h-8 rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-700 outline-none focus:border-[#175c62]"
                >
                  <option value="unread">Unread</option>
                  <option value="to-read">To read</option>
                  <option value="reading">Reading</option>
                  <option value="read">Read</option>
                  <option value="rejected">Rejected</option>
                </select>
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  onBlur={() => updatePaper.mutate({ tags: splitTags(draftTags) })}
                  placeholder="Tags"
                  className="h-8 min-w-32 rounded-md border border-stone-300 bg-white px-2 text-xs outline-none focus:border-[#175c62]"
                />
                <input
                  value={draftNotes}
                  onChange={(event) => setDraftNotes(event.target.value)}
                  onBlur={() => updatePaper.mutate({ notes: draftNotes.trim() })}
                  placeholder="Notes"
                  className="h-8 min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2 text-xs outline-none focus:border-[#175c62]"
                />
                <HeaderButton label="Export citation" onClick={() => exportCitation.mutate()} disabled={exportCitation.isPending}>
                  <FileText size={13} />
                </HeaderButton>
                <HeaderButton
                  label="Remove paper record"
                  danger
                  onClick={() => {
                    if (window.confirm(`Remove the paper record for "${selectedPaper.title}"? Files will remain.`)) deletePaper.mutate();
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
                <PaperField label="Venue" value={draftVenue} onChange={setDraftVenue} onCommit={() => updatePaper.mutate({ venue: draftVenue.trim() })} />
                <PaperField label="DOI" value={draftDoi} onChange={setDraftDoi} onCommit={() => updatePaper.mutate({ doi: draftDoi.trim() })} />
              </div>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden bg-[#f7f4ee]">
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
      </motion.div>
    </div>
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
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!data || data.encoding !== "base64" || artifact.mime === "application/pdf" || artifact.type === "paper-pdf") {
      setObjectUrl(undefined);
      return undefined;
    }
    const url = URL.createObjectURL(base64ToBlob(data.content, artifact.mime));
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [artifact.mime, data]);
  useEffect(() => {
    if (!highlightQuery.trim()) onHitCountChange(0);
  }, [artifact.id, highlightQuery, onHitCountChange]);
  if (isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <div className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading artifact
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-xl rounded-md border border-[#e9b4c1] bg-white p-5 text-sm text-[#7b2d43] shadow-sm">
          Could not open this artifact. {error.message}
        </div>
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
        <div className="rounded-md border border-stone-200 bg-white p-5 text-sm text-stone-600 shadow-sm">
          Binary preview is not available for this file type.
        </div>
      </div>
    );
  }
  if (data.truncated) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900">
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
        <article className="mx-auto max-w-4xl rounded-md border border-stone-200 bg-white px-7 py-6 shadow-sm">
          <MarkdownMessage content={content} isUser={false} />
        </article>
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
    <div className="h-full overflow-auto bg-[#171412] p-5 text-[#f8f3e8]">
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
    throw new Error("Artifact viewer bridge is unavailable. Restart Paper Pilot so the updated preload script is loaded.");
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
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`grid size-8 shrink-0 place-items-center rounded-md border transition disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "border-[#d2b05f] bg-[#fbf0c9] text-[#77581b]"
          : danger
            ? "border-[#e9b4c1] bg-white text-[#7b2d43] hover:border-[#7b2d43]"
            : "border-stone-300 bg-white text-stone-700 hover:border-[#175c62] hover:text-[#175c62]"
      }`}
    >
      {children}
    </button>
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
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] text-stone-500">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        className="h-8 w-full rounded-md border border-stone-300 bg-white px-2 text-xs outline-none focus:border-[#175c62]"
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
