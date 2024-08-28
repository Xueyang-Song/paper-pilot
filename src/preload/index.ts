import electron from "electron";
import type {
  AppSettings,
  Artifact,
  ChatRequest,
  ChatResponse,
  CredentialUpsert,
  CrawlConfig,
  Job,
  Message,
  Paper,
  Project,
  ProjectPolicy,
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

export interface PaperPilotApi {
  listProjects(): Promise<Project[]>;
  getProjectBundle(projectId: string): Promise<ProjectBundle>;
  createProject(input: { title: string; topic?: string }): Promise<Project>;
  updateProjectPolicy(input: { projectId: string; patch: Partial<ProjectPolicy> }): Promise<ProjectPolicy>;
  sendChat(input: ChatRequest): Promise<ChatResponse>;
  listSources(): Promise<SourceDefinition[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  saveCredential(input: CredentialUpsert): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  listCredentialFlags(): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  runCrawl(input: { projectId: string; config: Partial<CrawlConfig>; approved?: boolean }): Promise<unknown>;
  generateBrief(input: { projectId: string; prompt: string }): Promise<{ content: string; artifactId: string; jobId: string }>;
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
  onJobChanged(listener: (job: Job) => void): () => void;
}

const api: PaperPilotApi = {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  getProjectBundle: (projectId) => ipcRenderer.invoke("projects:getBundle", projectId),
  createProject: (input) => ipcRenderer.invoke("projects:create", input),
  updateProjectPolicy: (input) => ipcRenderer.invoke("projects:updatePolicy", input),
  sendChat: (input) => ipcRenderer.invoke("chat:send", input),
  listSources: () => ipcRenderer.invoke("sources:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (input) => ipcRenderer.invoke("settings:update", input),
  saveCredential: (input) => ipcRenderer.invoke("credentials:save", input),
  listCredentialFlags: () => ipcRenderer.invoke("credentials:listFlags"),
  runCrawl: (input) => ipcRenderer.invoke("crawl:run", input),
  generateBrief: (input) => ipcRenderer.invoke("brief:generate", input),
  runPythonScript: (input) => ipcRenderer.invoke("python:runScript", input),
  installBrowser: (input) => ipcRenderer.invoke("python:installBrowser", input),
  convertMarkItDown: (input) => ipcRenderer.invoke("python:convertMarkItDown", input),
  listJobs: (projectId) => ipcRenderer.invoke("jobs:list", projectId),
  approveJob: (jobId) => ipcRenderer.invoke("jobs:approve", jobId),
  denyJob: (jobId) => ipcRenderer.invoke("jobs:deny", jobId),
  onJobChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, job: Job) => listener(job);
    ipcRenderer.on("jobs:changed", handler);
    return () => ipcRenderer.off("jobs:changed", handler);
  }
};

contextBridge.exposeInMainWorld("paperPilot", api);
