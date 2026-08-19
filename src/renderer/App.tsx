import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atom, useAtom } from "jotai";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { AppSettings, Job } from "../shared/schemas";
import { ArtifactPanel, ArtifactViewerModal } from "./components/artifacts";
import { ChatWorkspace } from "./components/chat-workspace";
import { JobDrawer } from "./components/job-drawer";
import { ProjectRail } from "./components/project-rail";
import { SearchPanel } from "./components/search-panel";
import { SettingsPanel } from "./components/settings-panel";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowTitleBar } from "./components/window-title-bar";

const queryClient = new QueryClient();
const activeProjectIdAtom = atom<string | undefined>(undefined);
type ThemePreference = AppSettings["ui"]["theme"];
type ResolvedTheme = Exclude<ThemePreference, "system">;

export function Root(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={250}>
        <App />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export function App(): JSX.Element {
  const [activeProjectId, setActiveProjectId] = useAtom(activeProjectIdAtom);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewerArtifactId, setViewerArtifactId] = useState<string | undefined>(undefined);
  const [viewerHighlightQuery, setViewerHighlightQuery] = useState("");
  const [viewerSearchPage, setViewerSearchPage] = useState<number | undefined>(undefined);
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

  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.paperPilot.getSettings()
  });
  const themePreference = settingsQuery.data?.ui.theme ?? "system";
  const resolvedTheme = useResolvedTheme(themePreference);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
    void window.paperPilot.setTitleBarTheme(resolvedTheme).catch(() => undefined);
  }, [resolvedTheme]);

  const aiHealthQuery = useQuery({
    queryKey: [
      "ai-health",
      settingsQuery.data?.ai.provider,
      settingsQuery.data?.ai.baseUrl,
      settingsQuery.data?.ai.model,
      settingsQuery.data?.ai.hasApiKey
    ],
    queryFn: () => window.paperPilot.checkAiProvider(),
    enabled: Boolean(settingsQuery.data)
  });

  const createProject = useMutation({
    mutationFn: () => window.paperPilot.createProject({ title: "Untitled research project" }),
    onSuccess: (project) => {
      setActiveProjectId(project.id);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const updateProject = useMutation({
    mutationFn: (input: { projectId: string; title?: string; topic?: string; description?: string }) =>
      window.paperPilot.updateProject(input),
    onSuccess: (project) => {
      queryClient.setQueryData(["bundle", project.id], (bundle: typeof bundleQuery.data) =>
        bundle?.project.id === project.id ? { ...bundle, project } : bundle
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["bundle", project.id] });
    }
  });

  const pinProject = useMutation({
    mutationFn: (input: { projectId: string; pinned: boolean }) => window.paperPilot.setProjectPinned(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects"] })
  });

  const archiveProject = useMutation({
    mutationFn: (input: { projectId: string; archived: boolean }) => window.paperPilot.setProjectArchived(input),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["bundle", project.id] });
    }
  });

  const deleteProject = useMutation({
    mutationFn: (projectId: string) => window.paperPilot.deleteProject({ projectId }),
    onSuccess: (_result, projectId) => {
      const remaining = (projectsQuery.data ?? []).filter((project) => project.id !== projectId);
      if (activeProjectId === projectId) setActiveProjectId(remaining[0]?.id);
      queryClient.removeQueries({ queryKey: ["bundle", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const duplicateProject = useMutation({
    mutationFn: (projectId: string) => window.paperPilot.duplicateProject({ projectId }),
    onSuccess: (project) => {
      setActiveProjectId(project.id);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const exportProject = useMutation({
    mutationFn: (projectId: string) => window.paperPilot.exportProject({ projectId })
  });

  const importProject = useMutation({
    mutationFn: () => window.paperPilot.importProject(),
    onSuccess: (project) => {
      if (project) setActiveProjectId(project.id);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    }
  });

  const updateTheme = useMutation({
    mutationFn: (theme: ThemePreference) => window.paperPilot.updateSettings({ ui: { theme } }),
    onMutate: async (theme) => {
      await queryClient.cancelQueries({ queryKey: ["settings"] });
      const previous = queryClient.getQueryData<AppSettings>(["settings"]);
      if (previous) {
        queryClient.setQueryData<AppSettings>(["settings"], { ...previous, ui: { ...previous.ui, theme } });
      }
      return { previous };
    },
    onError: (_error, _theme, context) => {
      if (context?.previous) queryClient.setQueryData(["settings"], context.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

  const activeBundle = bundleQuery.data?.project.id === activeProjectId ? bundleQuery.data : undefined;
  const artifacts = activeBundle?.artifacts ?? [];

  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowTitleBar
        project={activeBundle?.project}
        paperCount={activeBundle?.papers.length ?? 0}
        artifactCount={activeBundle?.artifacts.length ?? 0}
        aiHealth={aiHealthQuery.data}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] bg-background">
        <ProjectRail
          projects={projectsQuery.data ?? []}
          activeProjectId={activeProjectId}
          onSelect={setActiveProjectId}
          onCreate={() => createProject.mutate()}
          onUpdate={(input) => updateProject.mutateAsync(input)}
          onPin={(projectId, pinned) => pinProject.mutateAsync({ projectId, pinned })}
          onArchive={(projectId, archived) => archiveProject.mutateAsync({ projectId, archived })}
          onDelete={(projectId) => deleteProject.mutateAsync(projectId)}
          onDuplicate={(projectId) => duplicateProject.mutateAsync(projectId)}
          onExport={(projectId) => exportProject.mutateAsync(projectId)}
          onImport={() => importProject.mutateAsync()}
        />
        <section className="relative flex min-h-0 min-w-0 flex-col border-l border-border bg-card">
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,340px)] overflow-hidden">
            <ChatWorkspace
              bundle={activeBundle}
              activeProjectId={activeProjectId}
              onProjectCreated={setActiveProjectId}
            />
            <ArtifactPanel
              projectId={activeProjectId}
              artifacts={artifacts}
              papers={activeBundle?.papers ?? []}
              onOpenArtifact={(artifactId) => {
                setViewerHighlightQuery("");
                setViewerSearchPage(undefined);
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
          onClearHighlight={() => {
            setViewerHighlightQuery("");
            setViewerSearchPage(undefined);
          }}
          onOpenSearch={() => setSearchOpen(true)}
          onClose={() => {
            setViewerArtifactId(undefined);
            setViewerHighlightQuery("");
            setViewerSearchPage(undefined);
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
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      <SettingsPanel
        open={settingsOpen}
        sources={sourcesQuery.data ?? []}
        activeProject={activeBundle?.project}
        aiHealth={aiHealthQuery.data}
        themePreference={themePreference}
        isThemeSaving={updateTheme.isPending}
        onThemeChange={(theme) => updateTheme.mutate(theme)}
        onClose={() => setSettingsOpen(false)}
      />
    </main>
  );
}

function useResolvedTheme(preference: ThemePreference): ResolvedTheme {
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncPreference = () => setSystemPrefersDark(mediaQuery.matches);
    syncPreference();
    mediaQuery.addEventListener("change", syncPreference);
    return () => mediaQuery.removeEventListener("change", syncPreference);
  }, []);

  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
