import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ChevronDown, ChevronUp, FolderOpen, Loader2, Search, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, Paper } from "../../shared/schemas";
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
  const isSelectedPdf = Boolean(selectedArtifact && (selectedArtifact.mime === "application/pdf" || selectedArtifact.type === "paper-pdf"));
  const [activeHitIndex, setActiveHitIndex] = useState(0);
  const [textHitCount, setTextHitCount] = useState(0);
  const [pdfHitCount, setPdfHitCount] = useState(0);
  const contentQuery = useQuery({
    queryKey: ["artifact-content", projectId, selectedArtifact?.id],
    queryFn: () => readArtifactContent(projectId, selectedArtifact?.id ?? ""),
    enabled: Boolean(projectId && selectedArtifact)
  });
  const hitCount = isSelectedPdf ? pdfHitCount : textHitCount;
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
              <div className="truncate text-base font-semibold">{selectedArtifact.title}</div>
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
              <ArtifactScoreControl target={selectedRow.scoreTarget} />
            </div>
          </header>
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
