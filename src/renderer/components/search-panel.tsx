import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Loader2, Search, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, SearchRequest, SearchResult } from "../../shared/schemas";
import { HighlightedSnippet } from "../lib/highlight";
import { IconButton } from "./ui";
import { useDebouncedValue } from "../lib/hooks";
type SearchScopeType = "global" | "project" | "file";
export function SearchPanel({
  activeProject,
  activeArtifactId,
  onOpenArtifact,
  onClose
}: {
  activeProject?: Project;
  activeArtifactId?: string;
  onOpenArtifact(projectId: string, artifactId: string, query: string, result: SearchResult): void;
  onClose(): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [scopeType, setScopeType] = useState<SearchScopeType>(activeProject ? "project" : "global");
  const [kindFilter, setKindFilter] = useState<"all" | "paper" | "chunk">("all");
  const [recentQueries, setRecentQueries] = useState<string[]>(() => readRecentQueries());
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 220);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  useEffect(() => {
    if (!activeProject && scopeType !== "global") setScopeType("global");
    if (scopeType === "file" && (!activeProject || !activeArtifactId)) {
      setScopeType(activeProject ? "project" : "global");
    }
  }, [activeArtifactId, activeProject, scopeType]);
  const scope = useMemo<SearchRequest["scope"]>(() => {
    if (scopeType === "project" && activeProject) return { type: "project", projectId: activeProject.id };
    if (scopeType === "file" && activeProject && activeArtifactId) {
      return { type: "file", projectId: activeProject.id, artifactId: activeArtifactId };
    }
    return { type: "global" };
  }, [activeArtifactId, activeProject, scopeType]);
  const scopeKey = scope.type === "global" ? "global" : scope.type === "project" ? `project:${scope.projectId}` : `file:${scope.artifactId}`;
  const searchQuery = useQuery({
    queryKey: ["search", debouncedQuery, scopeKey],
    queryFn: () => window.paperPilot.search({ query: debouncedQuery, scope, limit: 40 }),
    enabled: debouncedQuery.length >= 2
  });
  useEffect(() => {
    if (debouncedQuery.length < 2 || searchQuery.isLoading) return;
    setRecentQueries((current) => {
      const next = [debouncedQuery, ...current.filter((item) => item !== debouncedQuery)].slice(0, 6);
      window.localStorage.setItem("paper-pilot:recent-searches", JSON.stringify(next));
      return next;
    });
  }, [debouncedQuery, searchQuery.isLoading]);
  const displayedResults = (searchQuery.data?.results ?? []).filter((result) => kindFilter === "all" || result.kind === kindFilter);
  const scopeOptions: Array<{ type: SearchScopeType; label: string; disabled: boolean }> = [
    { type: "global", label: "Global", disabled: false },
    { type: "project", label: "Project", disabled: !activeProject },
    { type: "file", label: "File", disabled: !activeProject || !activeArtifactId }
  ];
  return (
    <div className="fixed inset-0 z-[60] bg-stone-950/30 p-5">
      <motion.section
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="mx-auto flex h-full max-h-[760px] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-stone-300 bg-[#fbfaf6] shadow-2xl"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 px-5">
          <div>
            <div className="text-sm font-semibold">Search</div>
            <div className="text-xs text-stone-600">
              {scope.type === "global" ? "All projects" : scope.type === "project" ? activeProject?.title : "Current file"}
            </div>
          </div>
          <IconButton label="Close search" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="shrink-0 border-b border-stone-200 bg-white p-4">
          <div className="flex items-center gap-2 rounded-md border border-stone-300 bg-[#fbfaf6] px-3 focus-within:border-[#175c62] focus-within:shadow-[0_0_0_3px_rgba(23,92,98,0.14)]">
            <Search size={17} className="shrink-0 text-stone-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search papers, PDFs, notes, JSON, and briefs"
              className="h-11 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-stone-400"
            />
          </div>
          <div className="mt-3 flex gap-2">
            {scopeOptions.map((option) => (
              <button
                key={option.type}
                type="button"
                disabled={option.disabled}
                onClick={() => setScopeType(option.type)}
                className={`h-8 rounded-md border px-3 text-xs font-medium transition ${
                  scopeType === option.type && !option.disabled
                    ? "border-stone-950 bg-stone-950 text-white"
                    : "border-stone-300 bg-white text-stone-700 hover:border-[#175c62] hover:text-[#175c62] disabled:cursor-not-allowed disabled:opacity-45"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["all", "paper", "chunk"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => setKindFilter(kind)}
                className={`h-7 rounded-md border px-2 text-[11px] font-medium transition ${
                  kindFilter === kind ? "border-[#175c62] bg-[#d8eadf] text-[#175c62]" : "border-stone-300 bg-white text-stone-600"
                }`}
              >
                {kind === "all" ? "All" : kind === "paper" ? "Papers" : "Files"}
              </button>
            ))}
            {recentQueries.map((recent) => (
              <button
                key={recent}
                type="button"
                onClick={() => setQuery(recent)}
                className="h-7 max-w-40 truncate rounded-md border border-stone-300 bg-white px-2 text-[11px] text-stone-600 transition hover:border-[#175c62] hover:text-[#175c62]"
              >
                {recent}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {debouncedQuery.length < 2 ? (
            <div className="grid h-full place-items-center text-sm text-stone-500">Type at least 2 characters.</div>
          ) : searchQuery.isLoading ? (
            <div className="grid h-full place-items-center">
              <div className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
                <Loader2 size={16} className="animate-spin" />
                Searching
              </div>
            </div>
          ) : searchQuery.isError ? (
            <div className="rounded-md border border-[#e9b4c1] bg-white p-4 text-sm text-[#7b2d43]">
              Search failed. {searchQuery.error.message}
            </div>
          ) : displayedResults.length ? (
            <div className="space-y-2">
              {displayedResults.map((result) => (
                <SearchResultRow
                  key={result.id}
                  result={result}
                  query={debouncedQuery}
                  onOpenArtifact={(clickedResult) =>
                    onOpenArtifact(clickedResult.projectId, clickedResult.artifactId ?? "", debouncedQuery, clickedResult)
                  }
                />
              ))}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-stone-500">No matches found.</div>
          )}
        </div>
      </motion.section>
    </div>
  );
}
function readRecentQueries(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("paper-pilot:recent-searches") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
function SearchResultRow({
  result,
  query,
  onOpenArtifact
}: {
  result: SearchResult;
  query: string;
  onOpenArtifact(result: SearchResult): void;
}): JSX.Element {
  const clickable = Boolean(result.artifactId);
  const content = (
    <>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{result.title}</div>
          <div className="mt-0.5 truncate text-xs text-stone-500">{result.subtitle ?? result.projectTitle ?? result.kind}</div>
        </div>
        <span className="shrink-0 rounded-md border border-stone-200 bg-[#f7f4ee] px-2 py-1 text-[11px] font-medium text-stone-600">
          {result.kind === "paper" ? "Paper" : "File"}
        </span>
      </div>
      <div className="line-clamp-3 text-left text-xs leading-5 text-stone-700">
        <HighlightedSnippet value={result.snippet} query={query} />
      </div>
    </>
  );
  if (!clickable) {
    return <article className="rounded-md border border-stone-200 bg-white p-3 shadow-sm">{content}</article>;
  }
  return (
    <button
      type="button"
      onClick={() => onOpenArtifact(result)}
      className="w-full rounded-md border border-stone-200 bg-white p-3 text-left shadow-sm transition hover:border-[#175c62] hover:shadow-md"
    >
      {content}
    </button>
  );
}
