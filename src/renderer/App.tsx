import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atom, useAtom } from "jotai";
import {
  Archive,
  Bot,
  Brain,
  Database,
  FileText,
  FlaskConical,
  FolderPlus,
  Gauge,
  KeyRound,
  Loader2,
  Play,
  Search,
  Send,
  Settings,
  ShieldCheck,
  TerminalSquare,
  X
} from "lucide-react";
import { motion } from "framer-motion";
import type { FormEvent, JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppSettings,
  Artifact,
  CrawlConfig,
  Job,
  Message,
  Paper,
  Project,
  SourceDefinition,
  SourceId
} from "../shared/schemas";
import "./styles.css";

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

  return (
    <main className="h-screen overflow-hidden bg-[#f4efe6] text-stone-950">
      <div className="grid h-full grid-cols-[280px_minmax(0,1fr)]">
        <ProjectRail
          projects={projectsQuery.data ?? []}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onCreate={() => createProject.mutate()}
        />
        <section className="relative flex min-w-0 flex-col border-l border-stone-300/80 bg-[#fbfaf6]">
          <TopBar
            project={bundleQuery.data?.project}
            paperCount={bundleQuery.data?.papers.length ?? 0}
            artifactCount={bundleQuery.data?.artifacts.length ?? 0}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
            <ChatWorkspace bundle={bundleQuery.data} activeProjectId={activeProjectId} onProjectCreated={setActiveProjectId} />
            <ArtifactPanel artifacts={bundleQuery.data?.artifacts ?? []} papers={bundleQuery.data?.papers ?? []} />
          </div>
          <JobDrawer projectId={activeProjectId} initialJobs={bundleQuery.data?.jobs ?? []} />
        </section>
      </div>
      {settingsOpen ? (
        <SettingsPanel
          sources={sourcesQuery.data ?? []}
          activeProject={bundleQuery.data?.project}
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
        <StatusPill icon={<Brain size={14} />} label="Vercel-first AI" />
        <IconButton label="Settings" onClick={props.onOpenSettings}>
          <Settings size={18} />
        </IconButton>
      </div>
    </header>
  );
}

function ChatWorkspace(props: {
  bundle?: ProjectBundle;
  activeProjectId?: string;
  onProjectCreated(projectId: string): void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
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

  return (
    <section className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {messages.length ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {sendChat.isPending ? <ThinkingBubble /> : null}
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
      <form onSubmit={submit} className="border-t border-stone-200 bg-[#fbfaf6] p-5">
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
        <div className="whitespace-pre-wrap">{message.content}</div>
      </div>
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

function ArtifactPanel({ artifacts, papers }: { artifacts: Artifact[]; papers: Paper[] }): JSX.Element {
  return (
    <aside className="min-h-0 border-l border-stone-200 bg-[#f1f5f1]">
      <div className="flex h-12 items-center justify-between border-b border-stone-200 px-4">
        <div className="text-sm font-semibold">Artifacts</div>
        <Archive size={16} className="text-stone-600" />
      </div>
      <div className="min-h-0 overflow-y-auto p-3">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Metric label="Papers" value={papers.length} />
          <Metric label="Files" value={artifacts.length} />
        </div>
        <div className="space-y-2">
          {artifacts.map((artifact) => (
            <div key={artifact.id} className="rounded-md border border-stone-200 bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-start gap-2">
                <FileText size={16} className="mt-0.5 shrink-0 text-[#7b2d43]" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{artifact.title}</div>
                  <div className="mt-0.5 text-xs text-stone-500">{artifact.type}</div>
                </div>
              </div>
              <div className="truncate rounded bg-stone-100 px-2 py-1 text-[11px] text-stone-600">{artifact.path}</div>
            </div>
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
