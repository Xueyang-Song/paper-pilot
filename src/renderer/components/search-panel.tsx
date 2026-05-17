import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, SearchRequest, SearchResult } from "../../shared/schemas";
import { HighlightedSnippet } from "../lib/highlight";
import { useDebouncedValue } from "../lib/hooks";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex h-[min(760px,calc(100dvh-2rem))] !w-[min(768px,calc(100vw-2rem))] !max-w-3xl flex-col gap-0 overflow-hidden border-border bg-popover p-0"
        showCloseButton
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>
            {scope.type === "global" ? "All projects" : scope.type === "project" ? activeProject?.title : "Current file"}
          </DialogDescription>
        </DialogHeader>
        <div className="shrink-0 border-b border-border bg-card/60 p-4">
          <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25">
            <Search size={17} className="shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search papers, PDFs, notes, JSON, and briefs"
              className="h-11 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <ToggleGroup type="single" value={scopeType} onValueChange={(value) => value && setScopeType(value as SearchScopeType)} variant="outline">
              {scopeOptions.map((option) => (
                <ToggleGroupItem key={option.type} value={option.type} disabled={option.disabled}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup type="single" value={kindFilter} onValueChange={(value) => value && setKindFilter(value as typeof kindFilter)} variant="outline">
              {(["all", "paper", "chunk"] as const).map((kind) => (
                <ToggleGroupItem key={kind} value={kind}>
                  {kind === "all" ? "All" : kind === "paper" ? "Papers" : "Files"}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {recentQueries.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {recentQueries.map((recent) => (
                <Button key={recent} type="button" variant="ghost" size="xs" onClick={() => setQuery(recent)} className="max-w-44 truncate">
                  {recent}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            {debouncedQuery.length < 2 ? (
              <div className="grid h-[360px] place-items-center text-sm text-muted-foreground">Type at least 2 characters.</div>
            ) : searchQuery.isLoading ? (
              <div className="grid h-[360px] place-items-center">
                <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
                  <Loader2 size={16} className="animate-spin" />
                  Searching
                </div>
              </div>
            ) : searchQuery.isError ? (
              <Alert variant="destructive">
                <AlertDescription>Search failed. {searchQuery.error.message}</AlertDescription>
              </Alert>
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
              <div className="grid h-[360px] place-items-center text-sm text-muted-foreground">No matches found.</div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
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
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{result.subtitle ?? result.projectTitle ?? result.kind}</div>
        </div>
        <Badge variant="outline" className="shrink-0">
          {result.kind === "paper" ? "Paper" : "File"}
        </Badge>
      </div>
      <div className="line-clamp-3 text-left text-xs leading-5 text-muted-foreground">
        <HighlightedSnippet value={result.snippet} query={query} />
      </div>
    </>
  );
  const className = cn("rounded-lg border-border bg-card p-3 py-3 text-left shadow-sm transition", clickable && "hover:border-primary/70 hover:shadow-md");
  if (!clickable) return <Card className={className}>{content}</Card>;
  return (
    <button type="button" onClick={() => onOpenArtifact(result)} className="w-full">
      <Card className={className}>{content}</Card>
    </button>
  );
}
