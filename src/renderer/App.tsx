import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { atom, useAtom } from "jotai";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Job } from "../shared/schemas";
import { ArtifactPanel, ArtifactViewerModal } from "./components/artifacts";
import { ChatWorkspace } from "./components/chat-workspace";
import { JobDrawer } from "./components/job-drawer";
import { ProjectRail } from "./components/project-rail";
import { SearchPanel } from "./components/search-panel";
import { SettingsPanel } from "./components/settings-panel";
import { TopBar } from "./components/top-bar";
import "./styles.css";

const queryClient = new QueryClient();
const activeProjectIdAtom = atom<string | undefined>(undefined);

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

  const aiHealthQuery = useQuery({
    queryKey: ["ai-health", settingsQuery.data?.ai.provider, settingsQuery.data?.ai.baseUrl, settingsQuery.data?.ai.model, settingsQuery.data?.ai.hasApiKey],
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

  const renameProject = useMutation({
    mutationFn: (input: { projectId: string; title: string }) => window.paperPilot.renameProject(input),
    onSuccess: (project) => {
      queryClient.setQueryData(["bundle", project.id], (bundle: typeof bundleQuery.data) =>
        bundle?.project.id === project.id ? { ...bundle, project } : bundle
      );
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["bundle", project.id] });
    }
  });

  const updateProject = useMutation({
    mutationFn: (input: { projectId: string; title?: string; topic?: string; description?: string }) => window.paperPilot.updateProject(input),
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
          onRename={(projectId, title) => renameProject.mutateAsync({ projectId, title })}
          onUpdate={(input) => updateProject.mutateAsync(input)}
          onPin={(projectId, pinned) => pinProject.mutateAsync({ projectId, pinned })}
          onArchive={(projectId, archived) => archiveProject.mutateAsync({ projectId, archived })}
          onDelete={(projectId) => deleteProject.mutateAsync(projectId)}
          onDuplicate={(projectId) => duplicateProject.mutateAsync(projectId)}
          onExport={(projectId) => exportProject.mutateAsync(projectId)}
          onImport={() => importProject.mutateAsync()}
        />
        <section className="relative flex min-h-0 min-w-0 flex-col border-l border-stone-300/80 bg-[#fbfaf6]">
          <TopBar
            project={activeBundle?.project}
            paperCount={activeBundle?.papers.length ?? 0}
            artifactCount={activeBundle?.artifacts.length ?? 0}
            aiHealth={aiHealthQuery.data}
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
      {settingsOpen ? (
        <SettingsPanel
          sources={sourcesQuery.data ?? []}
          activeProject={activeBundle?.project}
          aiHealth={aiHealthQuery.data}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
