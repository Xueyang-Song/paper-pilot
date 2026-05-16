import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atom, useAtom } from "jotai";
import {
  Archive,
  Bot,
  Brain,
  ChevronDown,
  ChevronUp,
  Database,
  FileCode,
  FileJson,
  FileText,
  FlaskConical,
  FolderOpen,
  FolderPlus,
  Gauge,
  Info,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  TerminalSquare,
  X
} from "lucide-react";
import { motion } from "framer-motion";
import type { FormEvent, JSX, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type {
  AppSettings,
  Artifact,
  CrawlConfig,
  Job,
  Message,
  Paper,
  PaperScore,
  Project,
  SearchRequest,
  SearchResult,
  SourceDefinition,
  SourceId
} from "../shared/schemas";
import "./styles.css";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const queryClient = new QueryClient();
const activeProjectIdAtom = atom<string | undefined>(undefined);

interface ProjectBundle {
  project: Project;
  messages: Message[];
  artifacts: Artifact[];
  papers: Paper[];
  jobs: Job[];
}

function Root(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  );
}

function App(): JSX.Element {
  const [activeProjectId, setActiveProjectId] = useAtom(activeProjectIdAtom);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewerArtifactId, setViewerArtifactId] = useState<string | undefined>(undefined);
  const [viewerHighlightQuery, setViewerHighlightQuery] = useState("");
  const [viewerSearchPage, setViewerSearchPage] = useState<number | undefined>(undefined);
  const [viewerSearchResultId, setViewerSearchResultId] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: () => window.paperPilot.listProjects()
  });

  useEffect(() => {
    if (!activeProjectId && projectsQuery.data?.[0]) {
      setActiveProjectId(projectsQuery.data[0].id);
    }
  }, [activeProjectId, projectsQuery.data, setActiveProjectId]);

  useEffect(() => {
    return window.paperPilot.onJobChanged((job) => {
      queryClient.setQueryData<Job[]>(["jobs", job.projectId], (jobs = []) => {
        const rest = jobs.filter((existing) => existing.id !== job.id);
        return [job, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      void queryClient.invalidateQueries({ queryKey: ["bundle", job.projectId] });
    });
  }, [queryClient]);

  const bundleQuery = useQuery({
    queryKey: ["bundle", activeProjectId],
    queryFn: () => window.paperPilot.getProjectBundle(activeProjectId ?? ""),
    enabled: Boolean(activeProjectId)
  });

  const sourcesQuery = useQuery({
    queryKey: ["sources"],
    queryFn: () => window.paperPilot.listSources()
  });

  const createProject = useMutation({
    mutationFn: () => window.paperPilot.createProject({ title: "Untitled research project" }),
    onSuccess: (project) => {
      setActiveProjectId(project.id);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const activeBundle = bundleQuery.data?.project.id === activeProjectId ? bundleQuery.data : undefined;
  const artifacts = activeBundle?.artifacts ?? [];

  return (
    <main className="h-dvh min-h-0 overflow-hidden bg-[#f4efe6] text-stone-950">
      <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
        <ProjectRail
          projects={projectsQuery.data ?? []}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onCreate={() => createProject.mutate()}
        />
        <section className="relative flex min-h-0 min-w-0 flex-col border-l border-stone-300/80 bg-[#fbfaf6]">
          <TopBar
            project={activeBundle?.project}
            paperCount={activeBundle?.papers.length ?? 0}
            artifactCount={activeBundle?.artifacts.length ?? 0}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
            <ChatWorkspace bundle={activeBundle} activeProjectId={activeProjectId} onProjectCreated={setActiveProjectId} />
            <ArtifactPanel
              projectId={activeProjectId}
              artifacts={artifacts}
              papers={activeBundle?.papers ?? []}
              onOpenArtifact={(artifactId) => {
                setViewerHighlightQuery("");
                setViewerSearchPage(undefined);
                setViewerSearchResultId(undefined);
                setViewerArtifactId(artifactId);
              }}
            />
          </div>
          <JobDrawer projectId={activeProjectId} initialJobs={activeBundle?.jobs ?? []} />
        </section>
      </div>
      {viewerArtifactId && activeProjectId ? (
        <ArtifactViewerModal
          projectId={activeProjectId}
          artifacts={artifacts}
          papers={activeBundle?.papers ?? []}
          selectedArtifactId={viewerArtifactId}
          onSelect={setViewerArtifactId}
          highlightQuery={viewerHighlightQuery}
          initialSearchPage={viewerSearchPage}
          initialSearchResultId={viewerSearchResultId}
          onClearHighlight={() => {
            setViewerHighlightQuery("");
            setViewerSearchPage(undefined);
            setViewerSearchResultId(undefined);
          }}
          onOpenSearch={() => setSearchOpen(true)}
          onClose={() => {
            setViewerArtifactId(undefined);
            setViewerHighlightQuery("");
            setViewerSearchPage(undefined);
            setViewerSearchResultId(undefined);
          }}
        />
      ) : null}
      {searchOpen ? (
        <SearchPanel
          activeProject={activeBundle?.project}
          activeArtifactId={viewerArtifactId}
          onOpenArtifact={(projectId, artifactId, query, result) => {
            setActiveProjectId(projectId);
            setViewerArtifactId(artifactId);
            setViewerHighlightQuery(query);
            setViewerSearchPage(result.page);
            setViewerSearchResultId(result.id);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsPanel
          sources={sourcesQuery.data ?? []}
          activeProject={activeBundle?.project}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}

function ProjectRail(props: {
  projects: Project[];
  activeProjectId?: string;
  onSelect(projectId: string): void;
  onCreate(): void;
}): JSX.Element {
  return (
    <aside className="flex min-h-0 flex-col bg-[#e8dfd2]">
      <div className="flex h-16 items-center justify-between border-b border-stone-300 px-4">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-md bg-stone-950 text-[#f4efe6]">
            <FlaskConical size={18} />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide">Paper Pilot</div>
            <div className="text-xs text-stone-600">Local research agent</div>
          </div>
        </div>
        <IconButton label="New project" onClick={props.onCreate}>
          <FolderPlus size={18} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600">Projects</div>
        <div className="space-y-1">
          {props.projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => props.onSelect(project.id)}
              className={`w-full rounded-md px-3 py-2 text-left transition ${
                project.id === props.activeProjectId
                  ? "bg-stone-950 text-[#f4efe6] shadow-sm"
                  : "text-stone-800 hover:bg-white/60"
              }`}
            >
              <div className="truncate text-sm font-medium">{project.title}</div>
              <div className={`mt-1 truncate text-xs ${project.id === props.activeProjectId ? "text-stone-300" : "text-stone-600"}`}>
                {new Date(project.updatedAt).toLocaleString()}
              </div>
            </button>
          ))}
          {!props.projects.length ? (
            <div className="rounded-md border border-dashed border-stone-400 px-3 py-4 text-sm text-stone-600">
              Create a project from chat or the toolbar.
            </div>
          ) : null}
        </div>
      </div>
      <div className="border-t border-stone-300 p-3">
        <div className="rounded-md bg-[#d8eadf] p-3 text-xs text-stone-800">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <ShieldCheck size={14} />
            Local-first storage
          </div>
          SQLite, artifacts, keys, scripts, and logs stay on this machine.
        </div>
      </div>
    </aside>
  );
}

function TopBar(props: {
  project?: Project;
  paperCount: number;
  artifactCount: number;
  onOpenSearch(): void;
  onOpenSettings(): void;
}): JSX.Element {
  return (
    <header className="flex h-16 items-center justify-between border-b border-stone-200 bg-[#fbfaf6]/95 px-5">
      <div className="min-w-0">
        <div className="truncate text-base font-semibold">{props.project?.title ?? "New research workspace"}</div>
        <div className="mt-0.5 flex gap-4 text-xs text-stone-600">
          <span>{props.paperCount} papers</span>
          <span>{props.artifactCount} artifacts</span>
          <span>{props.project?.policy.autonomy ?? "project"} autonomy</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill icon={<Database size={14} />} label="SQLite" />
        <StatusPill icon={<Brain size={14} />} label="Ollama testing" />
        <IconButton label="Search" onClick={props.onOpenSearch}>
          <Search size={18} />
        </IconButton>
        <IconButton label="Settings" onClick={props.onOpenSettings}>
          <Settings size={18} />
        </IconButton>
      </div>
    </header>
  );
}

type SearchScopeType = "global" | "project" | "file";

function SearchPanel({
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
          ) : searchQuery.data?.results.length ? (
            <div className="space-y-2">
              {searchQuery.data.results.map((result) => (
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

function ChatWorkspace(props: {
  bundle?: ProjectBundle;
  activeProjectId?: string;
  onProjectCreated(projectId: string): void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const sendChat = useMutation({
    mutationFn: (content: string) => window.paperPilot.sendChat({ projectId: props.activeProjectId, content }),
    onSuccess: (response) => {
      props.onProjectCreated(response.project.id);
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["bundle", response.project.id] });
    }
  });

  const runBrief = useMutation({
    mutationFn: () =>
      window.paperPilot.sendChat({
        projectId: props.activeProjectId,
        content: "Generate a citation-backed research brief with comparison table, gaps, controversies, and next reads."
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["bundle", response.project.id] });
    }
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendChat.isPending) return;
    sendChat.mutate(content);
  }

  const messages = props.bundle?.messages ?? [];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      transcriptEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, sendChat.isPending]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div ref={scrollRegionRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {messages.length ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {sendChat.isPending ? <ThinkingBubble /> : null}
            <div ref={transcriptEndRef} aria-hidden="true" />
          </div>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="w-full max-w-3xl">
              <div className="mb-5 flex items-center justify-center">
                <div className="grid size-12 place-items-center rounded-md bg-stone-950 text-[#f4efe6]">
                  <Bot size={24} />
                </div>
              </div>
              <h1 className="mb-3 text-center text-2xl font-semibold tracking-normal">Start a research project</h1>
              <div className="grid grid-cols-3 gap-2">
                {[
                  "Crawl recent papers on CRISPR delivery vectors",
                  "Find open-access work about perovskite solar stability",
                  "Search literature on climate attribution models since 2022"
                ].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setDraft(prompt)}
                    className="min-h-20 rounded-md border border-stone-300 bg-white px-3 py-2 text-left text-sm text-stone-700 shadow-sm transition hover:border-stone-500"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-stone-200 bg-[#fbfaf6] p-5">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-md border border-stone-300 bg-white shadow-sm">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              placeholder="Ask Paper Pilot to crawl papers, analyze findings, or generate a brief..."
              className="block max-h-40 min-h-24 w-full resize-none rounded-t-md border-0 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-stone-400"
            />
            <div className="flex items-center justify-between border-t border-stone-200 px-3 py-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => runBrief.mutate()}
                  disabled={!props.activeProjectId || runBrief.isPending}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 text-sm text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
                >
                  <FileText size={16} />
                  Brief
                </button>
                <button
                  type="button"
                  onClick={() => setDraft("Crawl open-access papers about ")}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 text-sm text-stone-700 transition hover:bg-stone-100"
                >
                  <Search size={16} />
                  Crawl
                </button>
              </div>
              <button
                type="submit"
                disabled={!draft.trim() || sendChat.isPending}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[#175c62] px-4 text-sm font-medium text-white transition hover:bg-[#11494e] disabled:opacity-50"
              >
                {sendChat.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Send
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}

function MessageBubble({ message }: { message: Message }): JSX.Element {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-md px-4 py-3 text-sm leading-6 shadow-sm ${
          isUser ? "bg-[#175c62] text-white" : "border border-stone-200 bg-white text-stone-800"
        }`}
      >
        <MarkdownMessage content={message.content} isUser={isUser} />
      </div>
    </div>
  );
}

function MarkdownMessage({ content, isUser }: { content: string; isUser: boolean }): JSX.Element {
  return (
    <div className={`markdown-body ${isUser ? "markdown-body-user" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ThinkingBubble(): JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
        <Loader2 size={16} className="animate-spin" />
        Working through the project tools
      </div>
    </div>
  );
}

function ArtifactPanel({
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

function ArtifactScoreControl({ target }: { target?: ArtifactScoreTarget }): JSX.Element | null {
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

function ScoreChip({ score }: { score?: PaperScore }): JSX.Element {
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

interface ArtifactScoreTarget {
  kind: "paper" | "aggregate";
  title: string;
  subtitle: string;
  sourceLabel?: string;
  score?: PaperScore;
}

interface ArtifactRow {
  artifact: Artifact;
  scoreTarget?: ArtifactScoreTarget;
  sourceLabel?: string;
  originalIndex: number;
}

function buildArtifactRows(artifacts: Artifact[], papers: Paper[]): ArtifactRow[] {
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

function scoreComponentRows(score: PaperScore): Array<{ key: keyof PaperScore["components"]; label: string; value: number }> {
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

function ArtifactViewerModal({
  projectId,
  artifacts,
  papers,
  selectedArtifactId,
  onSelect,
  highlightQuery,
  initialSearchPage,
  initialSearchResultId,
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
  initialSearchResultId?: string;
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

function PdfArtifactPreview({
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

function HighlightedSnippet({ value, query }: { value: string; query: string }): JSX.Element {
  const segments = parseMarkedSegments(value);
  if (segments.some((segment) => segment.match)) {
    return (
      <>
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={`${segment.text}-${index}`} className="rounded bg-[#fbf0c9] px-0.5 text-[#77581b]">
              {segment.text}
            </mark>
          ) : (
            <span key={`${segment.text}-${index}`}>{segment.text}</span>
          )
        )}
      </>
    );
  }
  return <HighlightedText value={value} query={query} tone="light" />;
}

function HighlightedText({
  value,
  query,
  tone,
  activeHitIndex = 0,
  onHitCountChange,
  scrollToActive = false
}: {
  value: string;
  query: string;
  tone: "light" | "dark";
  activeHitIndex?: number;
  onHitCountChange?(hitCount: number): void;
  scrollToActive?: boolean;
}): JSX.Element {
  const segments = useMemo(() => splitHighlightedText(value, query), [query, value]);
  const hitRefs = useRef<HTMLElement[]>([]);
  hitRefs.current = [];
  const hitCount = segments.filter((segment) => segment.match).length;

  useEffect(() => {
    onHitCountChange?.(hitCount);
  }, [hitCount, onHitCountChange]);

  useEffect(() => {
    if (!scrollToActive || !hitCount) return;
    const target = hitRefs.current[Math.max(0, Math.min(activeHitIndex, hitCount - 1))];
    const frame = window.requestAnimationFrame(() => {
      target?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeHitIndex, hitCount, scrollToActive, segments]);

  let matchIndex = 0;
  return (
    <>
      {segments.map((segment, index) => {
        if (!segment.match) return <span key={`${segment.text}-${index}`}>{segment.text}</span>;
        const currentMatchIndex = matchIndex;
        matchIndex += 1;
        const active = currentMatchIndex === activeHitIndex;
        return (
          <mark
            key={`${segment.text}-${index}`}
            ref={(node) => {
              if (node) hitRefs.current[currentMatchIndex] = node;
            }}
            className={`rounded px-0.5 ${
              active
                ? tone === "dark"
                  ? "bg-[#d8eadf] text-[#0f3f43] ring-2 ring-[#7fb0aa]"
                  : "bg-[#d8eadf] text-[#175c62] ring-2 ring-[#7fb0aa]"
                : tone === "dark"
                  ? "bg-[#fbf0c9] text-[#171412]"
                  : "bg-[#fbf0c9] text-[#77581b]"
            }`}
          >
            {segment.text}
          </mark>
        );
      })}
    </>
  );
}

function ArtifactIcon({ artifact, className }: { artifact: Artifact; className?: string }): JSX.Element {
  const props = { size: 16, className };
  if (artifact.type === "metadata-json" || artifact.mime === "application/json") return <FileJson {...props} />;
  if (artifact.type === "script") return <FileCode {...props} />;
  return <FileText {...props} />;
}

function formatBytes(bytes: number): string {
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

function formatJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = base64ToBytes(base64);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mime });
}

function base64ToBytes(base64: string): Uint8Array {
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function parseMarkedSegments(value: string): Array<{ text: string; match: boolean }> {
  const segments: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("[[", index);
    if (start === -1) {
      segments.push({ text: value.slice(index), match: false });
      break;
    }
    if (start > index) segments.push({ text: value.slice(index, start), match: false });
    const end = value.indexOf("]]", start + 2);
    if (end === -1) {
      segments.push({ text: value.slice(start), match: false });
      break;
    }
    segments.push({ text: value.slice(start + 2, end), match: true });
    index = end + 2;
  }
  return segments.filter((segment) => segment.text.length > 0);
}

function splitHighlightedText(value: string, query: string): Array<{ text: string; match: boolean }> {
  const tokens = buildHighlightTokens(query);
  if (!tokens.length) return [{ text: value, match: false }];
  const matcher = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const match of value.matchAll(matcher)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: value.slice(cursor, index), match: false });
    segments.push({ text: matchText, match: true });
    cursor = index + matchText.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), match: false });
  return segments.length ? segments : [{ text: value, match: false }];
}

function buildHighlightTokens(query: string): string[] {
  const normalized = query
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return Array.from(new Set(normalized)).slice(0, 8).sort((left, right) => right.length - left.length);
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

function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = value.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(token, index + Math.max(1, token.length));
  }
  return count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function JobDrawer({ projectId, initialJobs }: { projectId?: string; initialJobs: Job[] }): JSX.Element {
  const queryClient = useQueryClient();
  const jobsQuery = useQuery({
    queryKey: ["jobs", projectId],
    queryFn: () => window.paperPilot.listJobs(projectId),
    enabled: Boolean(projectId),
    initialData: initialJobs
  });
  const approveJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.approveJob(jobId),
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
      }
    }
  });
  const denyJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.denyJob(jobId),
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
      }
    }
  });
  const jobs = jobsQuery.data ?? [];
  const active = jobs.filter((job) => job.status === "running" || job.status === "waiting-approval");
  if (!active.length) return <div className="pointer-events-none absolute bottom-3 right-[360px]" />;
  return (
    <div className="absolute bottom-4 right-[360px] z-20 w-80 space-y-2">
      {active.slice(0, 3).map((job) => (
        <motion.div
          key={job.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-md border border-stone-300 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              {job.status === "running" ? <Loader2 size={15} className="animate-spin text-[#175c62]" /> : <Gauge size={15} />}
              <span className="truncate">{job.title}</span>
            </div>
            <span className="text-xs text-stone-500">{job.status}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full bg-[#175c62]" style={{ width: `${Math.max(6, job.progress * 100)}%` }} />
          </div>
          {job.detail ? <div className="mt-2 text-xs text-stone-600">{job.detail}</div> : null}
          {job.status === "waiting-approval" ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => approveJob.mutate(job.id)}
                disabled={approveJob.isPending || denyJob.isPending}
                className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-[#175c62] px-3 text-xs font-medium text-white transition hover:bg-[#11494e] disabled:opacity-50"
              >
                <Play size={13} />
                Approve
              </button>
              <button
                type="button"
                onClick={() => denyJob.mutate(job.id)}
                disabled={approveJob.isPending || denyJob.isPending}
                className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          ) : null}
        </motion.div>
      ))}
    </div>
  );
}

function SettingsPanel({
  sources,
  activeProject,
  onClose
}: {
  sources: SourceDefinition[];
  activeProject?: Project;
  onClose(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => window.paperPilot.getSettings() });
  const flagsQuery = useQuery({ queryKey: ["credentialFlags"], queryFn: () => window.paperPilot.listCredentialFlags() });
  const [selectedSource, setSelectedSource] = useState<SourceId | "ai-gateway">("ai-gateway");
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("openai/gpt-5.4");
  const [baseUrl, setBaseUrl] = useState("https://ai-gateway.vercel.sh/v1");

  useEffect(() => {
    if (settingsQuery.data) {
      setModel(settingsQuery.data.ai.model);
      setBaseUrl(settingsQuery.data.ai.baseUrl);
    }
  }, [settingsQuery.data]);

  const saveCredential = useMutation({
    mutationFn: () => window.paperPilot.saveCredential({ sourceId: selectedSource, label: "default", secret }),
    onSuccess: () => {
      setSecret("");
      void queryClient.invalidateQueries({ queryKey: ["credentialFlags"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      window.paperPilot.updateSettings({
        ai: {
          ...(settingsQuery.data?.ai as AppSettings["ai"]),
          baseUrl,
          model
        }
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

  const updatePolicy = useMutation({
    mutationFn: (patch: Partial<Project["policy"]>) =>
      window.paperPilot.updateProjectPolicy({ projectId: activeProject?.id ?? "", patch }),
    onSuccess: () => {
      if (activeProject) void queryClient.invalidateQueries({ queryKey: ["bundle", activeProject.id] });
    }
  });

  const reindexSearch = useMutation({
    mutationFn: (projectId?: string) => window.paperPilot.reindexSearch(projectId ? { projectId } : {}),
    onSuccess: () => {
      if (activeProject) void queryClient.invalidateQueries({ queryKey: ["bundle", activeProject.id] });
    }
  });

  const flags = flagsQuery.data ?? [];
  const credentialed = useMemo(() => new Set(flags.map((flag) => flag.sourceId)), [flags]);

  return (
    <div className="fixed inset-0 z-40 bg-stone-950/20">
      <motion.aside
        initial={{ x: 420 }}
        animate={{ x: 0 }}
        className="absolute right-0 top-0 flex h-full w-[420px] flex-col border-l border-stone-300 bg-[#fbfaf6] shadow-2xl"
      >
        <div className="flex h-16 items-center justify-between border-b border-stone-200 px-5">
          <div>
            <div className="text-sm font-semibold">Settings</div>
            <div className="text-xs text-stone-600">Sources, AI, policy</div>
          </div>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <PanelSection icon={<Brain size={17} />} title="AI Gateway">
            <label className="field-label">Base URL</label>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="field-input" />
            <label className="field-label">Model</label>
            <input value={model} onChange={(event) => setModel(event.target.value)} className="field-input" />
            <button type="button" onClick={() => saveSettings.mutate()} className="primary-button">
              Save AI settings
            </button>
          </PanelSection>

          <PanelSection icon={<Search size={17} />} title="Search Index">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => reindexSearch.mutate(activeProject?.id)}
                disabled={!activeProject || reindexSearch.isPending}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Project
              </button>
              <button
                type="button"
                onClick={() => reindexSearch.mutate(undefined)}
                disabled={reindexSearch.isPending}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                All
              </button>
            </div>
            {reindexSearch.data ? (
              <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs leading-5 text-stone-600">
                Indexed {reindexSearch.data.chunkCount} chunks from {reindexSearch.data.artifactCount} files and{" "}
                {reindexSearch.data.paperCount} papers.
                {reindexSearch.data.warnings.length ? (
                  <div className="mt-1 text-[#77581b]">{reindexSearch.data.warnings.slice(0, 2).join(" ")}</div>
                ) : null}
              </div>
            ) : null}
            {reindexSearch.isError ? (
              <div className="rounded-md border border-[#e9b4c1] bg-white px-3 py-2 text-xs text-[#7b2d43]">
                Reindex failed. {reindexSearch.error.message}
              </div>
            ) : null}
          </PanelSection>

          <PanelSection icon={<KeyRound size={17} />} title="Credentials">
            <select
              value={selectedSource}
              onChange={(event) => setSelectedSource(event.target.value as SourceId | "ai-gateway")}
              className="field-input"
            >
              <option value="ai-gateway">Vercel AI Gateway</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
            </select>
            <label className="field-label">API key, email, or token</label>
            <input
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              type="password"
              className="field-input"
              placeholder={credentialed.has(selectedSource) ? "Stored" : "Not configured"}
            />
            <button type="button" onClick={() => saveCredential.mutate()} disabled={!secret.trim()} className="primary-button">
              Save credential
            </button>
          </PanelSection>

          <PanelSection icon={<Search size={17} />} title="Sources">
            <div className="space-y-2">
              {sources.map((source) => (
                <div key={source.id} className="rounded-md border border-stone-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{source.displayName}</div>
                      <div className="mt-1 text-xs text-stone-600">{source.kind}</div>
                    </div>
                    <span
                      className={`rounded px-2 py-1 text-[11px] ${
                        source.stable ? "bg-[#d8eadf] text-[#175c62]" : "bg-[#f3d4dc] text-[#7b2d43]"
                      }`}
                    >
                      {source.stable ? "stable" : "experimental"}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-stone-600">{source.description}</div>
                </div>
              ))}
            </div>
          </PanelSection>

          {activeProject ? (
            <PanelSection icon={<ShieldCheck size={17} />} title="Project Policy">
              <div className="grid grid-cols-3 gap-2">
                {(["confirm", "project", "yolo"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updatePolicy.mutate({ autonomy: mode })}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      activeProject.policy.autonomy === mode ? "border-stone-950 bg-stone-950 text-white" : "border-stone-300 bg-white"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <PolicyToggle
                label="Auto-approve API source crawls"
                checked={activeProject.policy.autoApproveSources}
                onChange={(checked) => updatePolicy.mutate({ autoApproveSources: checked })}
              />
              <PolicyToggle
                label="Auto-approve Python scripts"
                checked={activeProject.policy.autoApproveScripts}
                onChange={(checked) => updatePolicy.mutate({ autoApproveScripts: checked })}
              />
              <PolicyToggle
                label="Auto-approve browser installs"
                checked={activeProject.policy.autoApproveBrowserInstall}
                onChange={(checked) => updatePolicy.mutate({ autoApproveBrowserInstall: checked })}
              />
            </PanelSection>
          ) : null}
        </div>
      </motion.aside>
    </div>
  );
}

function PolicyToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }): JSX.Element {
  return (
    <label className="mt-3 flex items-center justify-between rounded-md border border-stone-200 bg-white px-3 py-2 text-sm">
      {label}
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[#175c62]" />
    </label>
  );
}

function PanelSection({ icon, title, children }: { icon: JSX.Element; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-stone-600">{label}</div>
    </div>
  );
}

function StatusPill({ icon, label }: { icon: JSX.Element; label: string }): JSX.Element {
  return (
    <div className="hidden h-8 items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs text-stone-700 lg:inline-flex">
      {icon}
      {label}
    </div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-md border border-stone-300 bg-white text-stone-700 transition hover:border-stone-500 hover:bg-stone-100"
    >
      {children}
    </button>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
