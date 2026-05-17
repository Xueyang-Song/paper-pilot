import electron from "electron";
import type {
  AppSettings,
  AiProviderCheckRequest,
  AiProviderHealth,
  Artifact,
  ChatRequest,
  ChatResponse,
  CredentialUpsert,
  CrawlConfig,
  Job,
  Message,
  Paper,
  PaperUpdate,
  Project,
  ProjectPolicy,
  ProjectUpdate,
  ReindexRequest,
  ReindexResponse,
  SearchRequest,
  SearchResponse,
  SourceDefinition
} from "../shared/schemas.js";

const { contextBridge, ipcRenderer } = electron;

export interface ProjectBundle {
  project: Project;
  messages: Message[];
  artifacts: Artifact[];
  papers: Paper[];
  jobs: Job[];
}

export interface ArtifactContent {
  artifact: Artifact;
  encoding: "utf8" | "base64";
  content: string;
  size: number;
  truncated: boolean;
}

export interface WindowState {
  isMaximized: boolean;
  isFocused: boolean;
  isFullScreen?: boolean;
}

export interface PaperPilotApi {
  platform(): Promise<"darwin" | "win32" | "linux" | string>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<{ isMaximized: boolean }>;
  closeWindow(): Promise<void>;
  getWindowState(): Promise<WindowState>;
  setTitleBarTheme(theme: "light" | "dark"): Promise<void>;
  onWindowStateChanged(listener: (state: WindowState) => void): () => void;
  listProjects(): Promise<Project[]>;
  getProjectBundle(projectId: string): Promise<ProjectBundle>;
  createProject(input: { title: string; topic?: string }): Promise<Project>;
  renameProject(input: { projectId: string; title: string }): Promise<Project>;
  updateProject(input: ProjectUpdate): Promise<Project>;
  setProjectPinned(input: { projectId: string; pinned: boolean }): Promise<Project>;
  setProjectArchived(input: { projectId: string; archived: boolean }): Promise<Project>;
  deleteProject(input: { projectId: string }): Promise<{ ok: boolean }>;
  duplicateProject(input: { projectId: string; title?: string }): Promise<Project>;
  exportProject(input: { projectId: string }): Promise<{ ok: boolean; path?: string }>;
  importProject(): Promise<Project | undefined>;
  updateProjectPolicy(input: { projectId: string; patch: Partial<ProjectPolicy> }): Promise<ProjectPolicy>;
  sendChat(input: ChatRequest): Promise<ChatResponse>;
  clearChat(input: { projectId: string }): Promise<{ cleared: number }>;
  exportChat(input: { projectId: string }): Promise<{ ok: boolean; path?: string; count?: number }>;
  listSources(): Promise<SourceDefinition[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  openDataFolder(): Promise<{ ok: boolean }>;
  saveCredential(input: CredentialUpsert): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  listCredentialFlags(): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  removeCredential(input: { sourceId: string; label?: string }): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  testCredential(input: { sourceId: string; label?: string }): Promise<{ sourceId: string; label: string; ok: boolean; detail: string }>;
  runCrawl(input: { projectId: string; config: Partial<CrawlConfig>; approved?: boolean }): Promise<unknown>;
  generateBrief(input: { projectId: string; prompt: string }): Promise<{ content: string; artifactId: string; jobId: string }>;
  checkAiProvider(input?: AiProviderCheckRequest): Promise<AiProviderHealth>;
  scorePapers(input: { projectId: string }): Promise<{ scoredCount: number; papers: Paper[] }>;
  updatePaper(input: PaperUpdate): Promise<Paper>;
  deletePaper(input: { projectId: string; paperId: string }): Promise<{ ok: boolean }>;
  exportCitations(input: { projectId: string; paperIds?: string[]; format?: "bibtex" | "ris" | "csv" }): Promise<{ ok: boolean; path?: string; count?: number }>;
  search(input: SearchRequest): Promise<SearchResponse>;
  reindexSearch(input?: ReindexRequest): Promise<ReindexResponse>;
  importArtifacts(input: { projectId: string }): Promise<Artifact[]>;
  readArtifact(input: { projectId: string; artifactId: string }): Promise<ArtifactContent>;
  renameArtifact(input: { projectId: string; artifactId: string; title: string }): Promise<Artifact>;
  deleteArtifacts(input: { projectId: string; artifactIds: string[] }): Promise<{ ok: boolean; deleted: number }>;
  exportArtifacts(input: { projectId: string; artifactIds: string[] }): Promise<{ ok: boolean; exported?: number; paths?: string[] }>;
  reindexArtifacts(input: { projectId: string; artifactIds: string[] }): Promise<{ artifactCount: number; chunkCount: number; warnings: string[] }>;
  revealArtifact(input: { projectId: string; artifactId: string }): Promise<{ ok: boolean }>;
  openArtifactSource(input: { projectId: string; artifactId: string }): Promise<{ ok: boolean }>;
  runPythonScript(input: { projectId: string; name: string; code: string; args?: string[]; approved?: boolean }): Promise<unknown>;
  installBrowser(input: { projectId: string; approved?: boolean }): Promise<unknown>;
  convertMarkItDown(input: {
    projectId: string;
    sourcePath: string;
    approved?: boolean;
    parentArtifactId?: string;
  }): Promise<unknown>;
  listJobs(projectId?: string): Promise<Job[]>;
  approveJob(jobId: string): Promise<unknown>;
  denyJob(jobId: string): Promise<Job>;
  cancelJob(jobId: string): Promise<Job>;
  retryJob(jobId: string): Promise<Job>;
  clearTerminalJobs(projectId?: string): Promise<{ cleared: number }>;
  onJobChanged(listener: (job: Job) => void): () => void;
}

const api: PaperPilotApi = {
  platform: () => ipcRenderer.invoke("window:platform"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  getWindowState: () => ipcRenderer.invoke("window:getState"),
  setTitleBarTheme: (theme) => ipcRenderer.invoke("window:setTitleBarTheme", theme),
  onWindowStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WindowState) => listener(state);
    ipcRenderer.on("window:state-changed", handler);
    return () => ipcRenderer.off("window:state-changed", handler);
  },
  listProjects: () => ipcRenderer.invoke("projects:list"),
  getProjectBundle: (projectId) => ipcRenderer.invoke("projects:getBundle", projectId),
  createProject: (input) => ipcRenderer.invoke("projects:create", input),
  renameProject: (input) => ipcRenderer.invoke("projects:rename", input),
  updateProject: (input) => ipcRenderer.invoke("projects:update", input),
  setProjectPinned: (input) => ipcRenderer.invoke("projects:setPinned", input),
  setProjectArchived: (input) => ipcRenderer.invoke("projects:setArchived", input),
  deleteProject: (input) => ipcRenderer.invoke("projects:delete", input),
  duplicateProject: (input) => ipcRenderer.invoke("projects:duplicate", input),
  exportProject: (input) => ipcRenderer.invoke("projects:export", input),
  importProject: () => ipcRenderer.invoke("projects:import"),
  updateProjectPolicy: (input) => ipcRenderer.invoke("projects:updatePolicy", input),
  sendChat: (input) => ipcRenderer.invoke("chat:send", input),
  clearChat: (input) => ipcRenderer.invoke("chat:clear", input),
  exportChat: (input) => ipcRenderer.invoke("chat:export", input),
  listSources: () => ipcRenderer.invoke("sources:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (input) => ipcRenderer.invoke("settings:update", input),
  openDataFolder: () => ipcRenderer.invoke("app:openDataFolder"),
  saveCredential: (input) => ipcRenderer.invoke("credentials:save", input),
  listCredentialFlags: () => ipcRenderer.invoke("credentials:listFlags"),
  removeCredential: (input) => ipcRenderer.invoke("credentials:remove", input),
  testCredential: (input) => ipcRenderer.invoke("credentials:test", input),
  runCrawl: (input) => ipcRenderer.invoke("crawl:run", input),
  generateBrief: (input) => ipcRenderer.invoke("brief:generate", input),
  checkAiProvider: (input) => ipcRenderer.invoke("ai:checkProvider", input),
  scorePapers: (input) => ipcRenderer.invoke("papers:score", input),
  updatePaper: (input) => ipcRenderer.invoke("papers:update", input),
  deletePaper: (input) => ipcRenderer.invoke("papers:delete", input),
  exportCitations: (input) => ipcRenderer.invoke("papers:exportCitations", input),
  search: (input) => ipcRenderer.invoke("search:run", input),
  reindexSearch: (input) => ipcRenderer.invoke("search:reindex", input),
  importArtifacts: (input) => ipcRenderer.invoke("artifacts:import", input),
  readArtifact: (input) => ipcRenderer.invoke("artifacts:read", input),
  renameArtifact: (input) => ipcRenderer.invoke("artifacts:rename", input),
  deleteArtifacts: (input) => ipcRenderer.invoke("artifacts:delete", input),
  exportArtifacts: (input) => ipcRenderer.invoke("artifacts:export", input),
  reindexArtifacts: (input) => ipcRenderer.invoke("artifacts:reindex", input),
  revealArtifact: (input) => ipcRenderer.invoke("artifacts:reveal", input),
  openArtifactSource: (input) => ipcRenderer.invoke("artifacts:openSource", input),
  runPythonScript: (input) => ipcRenderer.invoke("python:runScript", input),
  installBrowser: (input) => ipcRenderer.invoke("python:installBrowser", input),
  convertMarkItDown: (input) => ipcRenderer.invoke("python:convertMarkItDown", input),
  listJobs: (projectId) => ipcRenderer.invoke("jobs:list", projectId),
  approveJob: (jobId) => ipcRenderer.invoke("jobs:approve", jobId),
  denyJob: (jobId) => ipcRenderer.invoke("jobs:deny", jobId),
  cancelJob: (jobId) => ipcRenderer.invoke("jobs:cancel", jobId),
  retryJob: (jobId) => ipcRenderer.invoke("jobs:retry", jobId),
  clearTerminalJobs: (projectId) => ipcRenderer.invoke("jobs:clearTerminal", projectId),
  onJobChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
    ipcRenderer.on("jobs:changed", handler);
    return () => ipcRenderer.off("jobs:changed", handler);
  }
};

contextBridge.exposeInMainWorld("paperPilot", api);
