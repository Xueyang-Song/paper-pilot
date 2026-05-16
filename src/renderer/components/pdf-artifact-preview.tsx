import { Loader2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { Artifact } from "../../shared/schemas";
import { buildHighlightTokens, clamp, countOccurrences } from "../lib/highlight";
import { base64ToBytes } from "./artifact-helpers";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy(): Promise<void>;
}
interface PdfPageLike {
  getViewport(input: { scale: number }): PdfViewportLike;
  getTextContent(): Promise<PdfTextContentLike>;
  render(input: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
    transform?: number[];
  }): { promise: Promise<void>; cancel(): void };
}
interface PdfViewportLike {
  width: number;
  height: number;
  scale?: number;
  transform?: number[];
}
interface PdfTextContentLike {
  items: PdfTextItemLike[];
}
interface PdfTextItemLike {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}
interface PdfHighlightRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}
const PDF_HIGHLIGHT_X_OFFSET = -2;
const PDF_HIGHLIGHT_Y_OFFSET = 2;
export function PdfArtifactPreview({
  artifact,
  fallbackBase64,
  searchPage,
  highlightQuery,
  activeHitIndex,
  onHitCountChange,
  onActiveHitIndexChange
}: {
  artifact: Artifact;
  fallbackBase64: string;
  searchPage?: number;
  highlightQuery: string;
  activeHitIndex: number;
  onHitCountChange(hitCount: number): void;
  onActiveHitIndexChange(hitIndex: number): void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [pdf, setPdf] = useState<PdfDocumentLike | undefined>(undefined);
  const [availableWidth, setAvailableWidth] = useState(840);
  const [hitPages, setHitPages] = useState<number[]>([]);
  const [pageHitCounts, setPageHitCounts] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const totalHitCount = useMemo(() => Object.values(pageHitCounts).reduce((total, count) => total + count, 0), [pageHitCounts]);
  useEffect(() => {
    let disposed = false;
    let loadedPdf: PdfDocumentLike | undefined;
    setLoading(true);
    setError(undefined);
    setPdf(undefined);
    setHitPages([]);
    setPageHitCounts({});
    onHitCountChange(0);
    async function loadPdf(): Promise<void> {
      try {
        const bytes = base64ToBytes(fallbackBase64);
        const loadingTask = pdfjsLib.getDocument({ data: bytes });
        const document = (await loadingTask.promise) as PdfDocumentLike;
        if (disposed) {
          await document.destroy();
          return;
        }
        loadedPdf = document;
        setPdf(document);
        setLoading(false);
      } catch (loadError) {
        if (!disposed) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
          setLoading(false);
        }
      }
    }
    void loadPdf();
    return () => {
      disposed = true;
      void loadedPdf?.destroy();
    };
  }, [artifact.id, fallbackBase64, onHitCountChange]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const updateWidth = (): void => setAvailableWidth(Math.max(340, container.clientWidth - 72));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [pdf]);
  useEffect(() => {
    if (!pdf || !highlightQuery.trim()) {
      setHitPages([]);
      setPageHitCounts({});
      onHitCountChange(0);
      return undefined;
    }
    let cancelled = false;
    const tokens = buildHighlightTokens(highlightQuery).map((token) => token.toLowerCase());
    if (!tokens.length) {
      setHitPages([]);
      setPageHitCounts({});
      onHitCountChange(0);
      return undefined;
    }
    const currentPdf = pdf;
    async function scanPages(): Promise<void> {
      setScanning(true);
      try {
        const matches: number[] = [];
        const counts: Record<number, number> = {};
        for (let pageNumber = 1; pageNumber <= currentPdf.numPages; pageNumber += 1) {
          if (cancelled) return;
          const page = await currentPdf.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const text = textContent.items.map((item) => item.str ?? "").join(" ").toLowerCase();
          const pageHitCount = countPdfTextMatches(textContent.items, tokens);
          if (tokens.every((token) => text.includes(token)) && pageHitCount > 0) {
            matches.push(pageNumber);
            counts[pageNumber] = pageHitCount;
          }
        }
        if (cancelled) return;
        const fallbackPage = searchPage && Number.isInteger(searchPage) && searchPage > 0 ? Math.min(searchPage, currentPdf.numPages) : undefined;
        const pages = matches.length ? matches : fallbackPage ? [fallbackPage] : [];
        if (!matches.length && fallbackPage) counts[fallbackPage] = 1;
        setHitPages(pages);
        setPageHitCounts(counts);
        onHitCountChange(Math.max(0, Object.values(counts).reduce((total, count) => total + count, 0)));
        if (fallbackPage) {
          const targetIndex = getPdfPageHitOffset(pages, counts, fallbackPage);
          if (targetIndex >= 0) onActiveHitIndexChange(targetIndex);
        }
      } catch (scanError) {
        if (!cancelled) {
          const fallbackPage = searchPage && Number.isInteger(searchPage) && searchPage > 0 ? Math.min(searchPage, currentPdf.numPages) : undefined;
          const pages = fallbackPage ? [fallbackPage] : [];
          const counts = fallbackPage ? { [fallbackPage]: 1 } : {};
          setHitPages(pages);
          setPageHitCounts(counts);
          onHitCountChange(Object.values(counts).reduce((total, count) => total + count, 0));
        }
      } finally {
        if (!cancelled) setScanning(false);
      }
    }
    void scanPages();
    return () => {
      cancelled = true;
    };
  }, [highlightQuery, onActiveHitIndexChange, onHitCountChange, pdf, searchPage]);
  useEffect(() => {
    if (!pdf) return;
    const targetPage = getPdfPageForHit(hitPages, pageHitCounts, activeHitIndex) ?? searchPage ?? 1;
    const frame = window.requestAnimationFrame(() => {
      pageRefs.current[targetPage]?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeHitIndex, hitPages, pageHitCounts, pdf, searchPage]);
  if (loading) {
    return (
      <div className="grid h-full place-items-center">
        <div className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading PDF
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="max-w-xl rounded-md border border-[#e9b4c1] bg-white p-5 text-sm text-[#7b2d43] shadow-sm">
          Could not render this PDF. {error}
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#d8d2c7]">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-stone-300 bg-white px-4 text-xs text-stone-600">
        <div className="flex min-w-0 items-center gap-3">
          <span className="font-medium text-stone-800">{pdf?.numPages ?? 0} pages</span>
          {highlightQuery.trim() ? (
            <span className="truncate">
              {scanning
                ? "Finding matches..."
                : totalHitCount
                  ? `${totalHitCount} matches on ${hitPages.length} ${hitPages.length === 1 ? "page" : "pages"}`
                  : "No matching pages found"}
            </span>
          ) : null}
        </div>
        {scanning ? <Loader2 size={14} className="animate-spin text-[#175c62]" /> : null}
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto flex max-w-[980px] flex-col gap-5">
          {Array.from({ length: pdf?.numPages ?? 0 }, (_, index) => {
            const pageNumber = index + 1;
            return (
              <div
                key={pageNumber}
                ref={(node) => {
                  pageRefs.current[pageNumber] = node;
                }}
                className={`rounded-md border bg-white p-3 shadow-xl ${
                  hitPages.includes(pageNumber) ? "border-[#175c62] ring-2 ring-[#7fb0aa]" : "border-stone-300"
                }`}
              >
                <div className="mb-2 text-xs font-medium text-stone-500">Page {pageNumber}</div>
                {pdf ? (
                  <PdfPageCanvas
                    pdf={pdf}
                    pageNumber={pageNumber}
                    availableWidth={availableWidth}
                    highlightQuery={highlightQuery}
                    activeHitIndex={activeHitIndex}
                    pageHitOffset={getPdfPageHitOffset(hitPages, pageHitCounts, pageNumber)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
function PdfPageCanvas({
  pdf,
  pageNumber,
  availableWidth,
  highlightQuery,
  activeHitIndex,
  pageHitOffset
}: {
  pdf: PdfDocumentLike;
  pageNumber: number;
  availableWidth: number;
  highlightQuery: string;
  activeHitIndex: number;
  pageHitOffset: number;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeHighlightRef = useRef<HTMLSpanElement>(null);
  const [rendering, setRendering] = useState(true);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [highlightRects, setHighlightRects] = useState<PdfHighlightRect[]>([]);
  const shouldHighlightPage = pageHitOffset >= 0;
  const activeLocalHitIndex = shouldHighlightPage ? activeHitIndex - pageHitOffset : -1;
  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PdfPageLike["render"]> | undefined;
    async function renderPage(): Promise<void> {
      setRendering(true);
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.65, Math.min(1.7, availableWidth / baseViewport.width));
        const viewport = page.getViewport({ scale });
        const pixelRatio = window.devicePixelRatio || 1;
        setViewportSize({ width: viewport.width, height: viewport.height });
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
        });
        await renderTask.promise;
        if (cancelled) return;
        const tokens = shouldHighlightPage ? buildHighlightTokens(highlightQuery).map((token) => token.toLowerCase()) : [];
        if (!tokens.length) {
          setHighlightRects([]);
          return;
        }
        const textContent = await page.getTextContent();
        if (!cancelled) setHighlightRects(buildPdfHighlightRects(textContent.items, tokens, viewport, scale));
      } catch (renderError) {
        if (!cancelled && !(renderError instanceof Error && renderError.name === "RenderingCancelledException")) {
          // Keep the page slot visible even if one page fails; the modal-level loader already handled document errors.
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableWidth, highlightQuery, pageNumber, pdf, shouldHighlightPage]);
  useEffect(() => {
    if (activeLocalHitIndex < 0 || activeLocalHitIndex >= highlightRects.length) return;
    const frame = window.requestAnimationFrame(() => {
      activeHighlightRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeLocalHitIndex, highlightRects]);
  return (
    <div className="relative min-h-40">
      {rendering ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-white/75 text-xs text-stone-500">
          <Loader2 size={15} className="animate-spin" />
        </div>
      ) : null}
      <div
        className="relative mx-auto"
        style={{
          width: viewportSize.width ? `${viewportSize.width}px` : undefined,
          height: viewportSize.height ? `${viewportSize.height}px` : undefined
        }}
      >
        <canvas ref={canvasRef} className="block max-w-full bg-white" />
        <div className="pointer-events-none absolute inset-0">
          {highlightRects.map((rect, index) => {
            const active = index === activeLocalHitIndex;
            return (
              <span
                key={rect.id}
                ref={active ? activeHighlightRef : undefined}
                className="absolute rounded-[2px]"
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  backgroundColor: active ? "rgba(210, 176, 95, 0.7)" : "rgba(255, 226, 95, 0.46)",
                  boxShadow: active ? "0 0 0 2px rgba(23, 92, 98, 0.58)" : undefined,
                  mixBlendMode: "multiply"
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
function countPdfTextMatches(items: PdfTextItemLike[], tokens: string[]): number {
  if (!tokens.length) return 0;
  return items.reduce((total, item) => {
    const text = (item.str ?? "").toLowerCase();
    if (!text) return total;
    return total + tokens.reduce((itemTotal, token) => itemTotal + countOccurrences(text, token), 0);
  }, 0);
}
function buildPdfHighlightRects(items: PdfTextItemLike[], tokens: string[], viewport: PdfViewportLike, scale: number): PdfHighlightRect[] {
  if (!tokens.length) return [];
  const rects: PdfHighlightRect[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const text = item.str ?? "";
    const lowerText = text.toLowerCase();
    if (!text || !lowerText) continue;
    const itemRect = getPdfTextItemRect(item, viewport, scale);
    if (!itemRect) continue;
    for (const token of tokens) {
      let start = lowerText.indexOf(token);
      while (start >= 0) {
        const left = itemRect.left + (start / text.length) * itemRect.width;
        const width = Math.max(6, Math.min(itemRect.width - (left - itemRect.left), (token.length / text.length) * itemRect.width));
        if (width > 0) {
          rects.push({
            id: `${itemIndex}-${token}-${start}`,
            left: clamp(left + PDF_HIGHLIGHT_X_OFFSET, 0, viewport.width),
            top: clamp(itemRect.top + itemRect.height * 0.16 + PDF_HIGHLIGHT_Y_OFFSET, 0, viewport.height),
            width: clamp(width, 4, viewport.width),
            height: clamp(itemRect.height * 0.72, 5, viewport.height)
          });
        }
        start = lowerText.indexOf(token, start + Math.max(1, token.length));
      }
    }
  }
  return rects;
}
function getPdfTextItemRect(item: PdfTextItemLike, viewport: PdfViewportLike, scale: number): PdfHighlightRect | undefined {
  if (!item.transform || item.transform.length < 6 || !viewport.transform || viewport.transform.length < 6) return undefined;
  const transformed = multiplyPdfMatrix(viewport.transform, item.transform);
  const height = Math.max(6, Math.hypot(transformed[2], transformed[3]));
  const estimatedWidth = Math.max(6, (item.str?.length ?? 1) * height * 0.45);
  const width = Math.max(6, (item.width ?? estimatedWidth / scale) * scale);
  const left = transformed[4];
  const top = transformed[5] - height;
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  return {
    id: "",
    left: clamp(left, 0, viewport.width),
    top: clamp(top, 0, viewport.height),
    width: clamp(width, 4, viewport.width),
    height: clamp(height, 5, viewport.height)
  };
}
function multiplyPdfMatrix(left: number[], right: number[]): number[] {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5]
  ];
}
function getPdfPageForHit(hitPages: number[], pageHitCounts: Record<number, number>, hitIndex: number): number | undefined {
  let offset = 0;
  for (const pageNumber of hitPages) {
    const count = Math.max(1, pageHitCounts[pageNumber] ?? 0);
    if (hitIndex >= offset && hitIndex < offset + count) return pageNumber;
    offset += count;
  }
  return undefined;
}
function getPdfPageHitOffset(hitPages: number[], pageHitCounts: Record<number, number>, pageNumber: number): number {
  let offset = 0;
  for (const hitPage of hitPages) {
    if (hitPage === pageNumber) return offset;
    offset += Math.max(1, pageHitCounts[hitPage] ?? 0);
  }
  return -1;
}
