import electron from "electron";
import type {
  AppSettings,
  AiModelList,
  AiModelListRequest,
  AiProviderCheckRequest,
  AiProviderHealth,
  ActivateReviewRequest,
  Artifact,
  AttachReviewPaperPdfRequest,
  CancelReviewRunRequest,
  ChatMode,
  ChatRun,
  ChatRunEvent,
  Citation,
  Conversation,
  CredentialUpsert,
  CrawlConfig,
  DiscoveryBatch,
  ExportReviewRequest,
  ExtractionField,
  ExtractionValue,
  FetchReviewPaperFullTextRequest,
  Job,
  MarkReviewPapersForReviewRequest,
  Message,
  Paper,
  PaperUpdate,
  Project,
  ProjectPolicy,
  ProjectUpdate,
  ReferenceImportCommitRequest,
  ReferenceImportCommitResponse,
  ReferenceImportMapping,
  ReferenceImportPreview,
  ReferenceImportPreviewRequest,
  ReindexRequest,
  ReindexResponse,
  ReorderExtractionFieldsRequest,
  RetryReviewRunRequest,
  ReviewFlowSummary,
  ReviewEvidence,
  ReviewPaperPage,
  ReviewPaperQuery,
  ReviewProtocol,
  ReviewProtocolRevision,
  ReviewRun,
  ReviewRunEvent,
  ReviewRunItem,
  ReviseReviewProtocolRequest,
  SaveExtractionValueRequest,
  SaveScreeningDecisionRequest,
  SearchRequest,
  SearchResponse,
  SourceDefinition,
  StartChatRunRequest,
  StartChatRunResponse,
  StartReviewRunRequest,
  ScreeningDecision,
  UpsertExtractionFieldRequest,
  UpdateStatus
} from "../shared/schemas.js";
import { reviewRunEventSchema } from "../shared/schemas.js";

const { contextBridge, ipcRenderer } = electron;

export interface ProjectBundle {
  project: Project;
  conversations: Conversation[];
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

export interface ReviewState {
  protocol: ReviewProtocol;
  revision: ReviewProtocolRevision;
}

export interface ReviewFileActionResult {
  ok: boolean;
  artifactId?: string;
  warning?: string;
}

export interface ReviewExportResult {
  ok: boolean;
  path?: string;
  fileCount?: number;
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
  listConversations(projectId: string): Promise<Conversation[]>;
  createConversation(input: { projectId: string; title?: string; mode?: ChatMode }): Promise<Conversation>;
  updateConversation(input: { conversationId: string; title?: string; mode?: ChatMode }): Promise<Conversation>;
  deleteConversation(conversationId: string): Promise<Conversation>;
  listConversationMessages(input: { projectId: string; conversationId: string }): Promise<Message[]>;
  listChatRuns(conversationId: string): Promise<ChatRun[]>;
  listChatCitations(runId: string): Promise<Citation[]>;
  startChatRun(input: StartChatRunRequest): Promise<StartChatRunResponse>;
  cancelChatRun(runId: string): Promise<{ cancelled: boolean }>;
  onChatRunEvent(listener: (event: ChatRunEvent) => void): () => void;
  clearChat(input: { projectId: string; conversationId?: string }): Promise<{ cleared: number }>;
  exportChat(input: {
    projectId: string;
    conversationId?: string;
  }): Promise<{ ok: boolean; path?: string; count?: number }>;
  listSources(): Promise<SourceDefinition[]>;
  getSettings(): Promise<AppSettings>;
  updateSettings(input: Partial<AppSettings>): Promise<AppSettings>;
  openDataFolder(): Promise<{ ok: boolean }>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  downloadUpdate(): Promise<UpdateStatus>;
  installUpdateNow(): Promise<UpdateStatus>;
  onUpdateStatusChanged(listener: (status: UpdateStatus) => void): () => void;
  saveCredential(input: CredentialUpsert): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  listCredentialFlags(): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  removeCredential(input: {
    sourceId: string;
    label?: string;
  }): Promise<Array<{ sourceId: string; label: string; updatedAt: string }>>;
  testCredential(input: {
    sourceId: string;
    label?: string;
  }): Promise<{ sourceId: string; label: string; ok: boolean; detail: string }>;
  runCrawl(input: { projectId: string; config: Partial<CrawlConfig>; approved?: boolean }): Promise<unknown>;
  generateBrief(input: {
    projectId: string;
    prompt: string;
  }): Promise<{ content: string; artifactId: string; jobId: string }>;
  listAiModels(input: AiModelListRequest): Promise<AiModelList>;
  checkAiProvider(input?: AiProviderCheckRequest): Promise<AiProviderHealth>;
  scorePapers(input: { projectId: string }): Promise<{ scoredCount: number; papers: Paper[] }>;
  updatePaper(input: PaperUpdate): Promise<Paper>;
  deletePaper(input: { projectId: string; paperId: string }): Promise<{ ok: boolean }>;
  exportCitations(input: {
    projectId: string;
    paperIds?: string[];
    format?: "bibtex" | "ris" | "csv";
  }): Promise<{ ok: boolean; path?: string; count?: number }>;
  search(input: SearchRequest): Promise<SearchResponse>;
  reindexSearch(input?: ReindexRequest): Promise<ReindexResponse>;
  importArtifacts(input: { projectId: string }): Promise<Artifact[]>;
  readArtifact(input: { projectId: string; artifactId: string }): Promise<ArtifactContent>;
  renameArtifact(input: { projectId: string; artifactId: string; title: string }): Promise<Artifact>;
  deleteArtifacts(input: { projectId: string; artifactIds: string[] }): Promise<{ ok: boolean; deleted: number }>;
  exportArtifacts(input: {
    projectId: string;
    artifactIds: string[];
  }): Promise<{ ok: boolean; exported?: number; paths?: string[] }>;
  reindexArtifacts(input: {
    projectId: string;
    artifactIds: string[];
  }): Promise<{ artifactCount: number; chunkCount: number; warnings: string[] }>;
  revealArtifact(input: { projectId: string; artifactId: string }): Promise<{ ok: boolean }>;
  openArtifactSource(input: { projectId: string; artifactId: string }): Promise<{ ok: boolean }>;
  runPythonScript(input: {
    projectId: string;
    name: string;
    code: string;
    args?: string[];
    approved?: boolean;
  }): Promise<unknown>;
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
  getReview(projectId: string): Promise<ReviewState | undefined>;
  activateReview(input: ActivateReviewRequest): Promise<ReviewState>;
  listReviewProtocolRevisions(reviewId: string): Promise<ReviewProtocolRevision[]>;
  reviseReviewProtocol(input: ReviseReviewProtocolRequest): Promise<ReviewProtocolRevision>;
  listReviewPapers(input: ReviewPaperQuery): Promise<ReviewPaperPage>;
  listDiscoveryBatches(reviewId: string): Promise<DiscoveryBatch[]>;
  previewReferenceImport(input: ReferenceImportPreviewRequest): Promise<ReferenceImportPreview | undefined>;
  remapReferenceImport(input: { previewId: string; mapping: ReferenceImportMapping }): Promise<ReferenceImportPreview>;
  commitReferenceImport(input: ReferenceImportCommitRequest): Promise<ReferenceImportCommitResponse>;
  saveScreeningDecision(input: SaveScreeningDecisionRequest): Promise<ScreeningDecision>;
  markReviewPapersForReview(input: MarkReviewPapersForReviewRequest): Promise<{ ok: true; marked: number }>;
  listExtractionFields(reviewId: string): Promise<ExtractionField[]>;
  upsertExtractionField(input: UpsertExtractionFieldRequest): Promise<ExtractionField>;
  reorderExtractionFields(input: ReorderExtractionFieldsRequest): Promise<ExtractionField[]>;
  listExtractionValues(input: { reviewId: string; paperIds?: string[] }): Promise<ExtractionValue[]>;
  listReviewEvidence(input: { reviewId: string; evidenceIds?: string[] }): Promise<ReviewEvidence[]>;
  saveExtractionValue(input: SaveExtractionValueRequest): Promise<ExtractionValue>;
  startReviewRun(input: StartReviewRunRequest): Promise<ReviewRun>;
  cancelReviewRun(input: CancelReviewRunRequest): Promise<{ cancelled: boolean }>;
  retryReviewRun(input: RetryReviewRunRequest): Promise<ReviewRun>;
  listReviewRuns(reviewId: string): Promise<ReviewRun[]>;
  listReviewRunItems(runId: string): Promise<ReviewRunItem[]>;
  onReviewRunEvent(listener: (event: ReviewRunEvent) => void): () => void;
  getReviewSummary(reviewId: string): Promise<ReviewFlowSummary>;
  fetchReviewPaperFullText(input: FetchReviewPaperFullTextRequest): Promise<ReviewFileActionResult>;
  attachReviewPaperPdf(input: AttachReviewPaperPdfRequest): Promise<ReviewFileActionResult>;
  exportReview(input: ExportReviewRequest): Promise<ReviewExportResult>;
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
  listConversations: (projectId) => ipcRenderer.invoke("conversations:list", projectId),
  createConversation: (input) => ipcRenderer.invoke("conversations:create", input),
  updateConversation: (input) => ipcRenderer.invoke("conversations:update", input),
  deleteConversation: (conversationId) => ipcRenderer.invoke("conversations:delete", conversationId),
  listConversationMessages: (input) => ipcRenderer.invoke("conversations:messages", input),
  listChatRuns: (conversationId) => ipcRenderer.invoke("conversations:runs", conversationId),
  listChatCitations: (runId) => ipcRenderer.invoke("chat:citations", runId),
  startChatRun: (input) => ipcRenderer.invoke("chat:start", input),
  cancelChatRun: (runId) => ipcRenderer.invoke("chat:cancel", runId),
  onChatRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, runEvent: ChatRunEvent) => listener(runEvent);
    ipcRenderer.on("chat:run-event", handler);
    return () => ipcRenderer.off("chat:run-event", handler);
  },
  clearChat: (input) => ipcRenderer.invoke("chat:clear", input),
  exportChat: (input) => ipcRenderer.invoke("chat:export", input),
  listSources: () => ipcRenderer.invoke("sources:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (input) => ipcRenderer.invoke("settings:update", input),
  openDataFolder: () => ipcRenderer.invoke("app:openDataFolder"),
  getUpdateStatus: () => ipcRenderer.invoke("updates:getStatus"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdateNow: () => ipcRenderer.invoke("updates:installNow"),
  onUpdateStatusChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus) => listener(status);
    ipcRenderer.on("updates:changed", handler);
    return () => ipcRenderer.off("updates:changed", handler);
  },
  saveCredential: (input) => ipcRenderer.invoke("credentials:save", input),
  listCredentialFlags: () => ipcRenderer.invoke("credentials:listFlags"),
  removeCredential: (input) => ipcRenderer.invoke("credentials:remove", input),
  testCredential: (input) => ipcRenderer.invoke("credentials:test", input),
  runCrawl: (input) => ipcRenderer.invoke("crawl:run", input),
  generateBrief: (input) => ipcRenderer.invoke("brief:generate", input),
  listAiModels: (input) => ipcRenderer.invoke("ai:listModels", input),
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
  },
  getReview: (projectId) => ipcRenderer.invoke("review:get", projectId),
  activateReview: (input) => ipcRenderer.invoke("review:activate", input),
  listReviewProtocolRevisions: (reviewId) => ipcRenderer.invoke("review:listProtocolRevisions", reviewId),
  reviseReviewProtocol: (input) => ipcRenderer.invoke("review:reviseProtocol", input),
  listReviewPapers: (input) => ipcRenderer.invoke("review:listPapers", input),
  listDiscoveryBatches: (reviewId) => ipcRenderer.invoke("review:listDiscoveryBatches", reviewId),
  previewReferenceImport: (input) => ipcRenderer.invoke("review:previewImport", input),
  remapReferenceImport: (input) => ipcRenderer.invoke("review:remapImport", input),
  commitReferenceImport: (input) => ipcRenderer.invoke("review:commitImport", input),
  saveScreeningDecision: (input) => ipcRenderer.invoke("review:saveDecision", input),
  markReviewPapersForReview: (input) => ipcRenderer.invoke("review:markForReview", input),
  listExtractionFields: (reviewId) => ipcRenderer.invoke("review:listExtractionFields", reviewId),
  upsertExtractionField: (input) => ipcRenderer.invoke("review:upsertExtractionField", input),
  reorderExtractionFields: (input) => ipcRenderer.invoke("review:reorderExtractionFields", input),
  listExtractionValues: (input) => ipcRenderer.invoke("review:listExtractionValues", input),
  listReviewEvidence: (input) => ipcRenderer.invoke("review:listEvidence", input),
  saveExtractionValue: (input) => ipcRenderer.invoke("review:saveExtractionValue", input),
  startReviewRun: (input) => ipcRenderer.invoke("review:startRun", input),
  cancelReviewRun: (input) => ipcRenderer.invoke("review:cancelRun", input),
  retryReviewRun: (input) => ipcRenderer.invoke("review:retryRun", input),
  listReviewRuns: (reviewId) => ipcRenderer.invoke("review:listRuns", reviewId),
  listReviewRunItems: (runId) => ipcRenderer.invoke("review:listRunItems", runId),
  onReviewRunEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, runEvent: unknown) =>
      listener(reviewRunEventSchema.parse(runEvent));
    ipcRenderer.on("review:run-event", handler);
    return () => ipcRenderer.off("review:run-event", handler);
  },
  getReviewSummary: (reviewId) => ipcRenderer.invoke("review:getSummary", { reviewId }),
  fetchReviewPaperFullText: (input) => ipcRenderer.invoke("review:fetchFullText", input),
  attachReviewPaperPdf: (input) => ipcRenderer.invoke("review:attachPdf", input),
  exportReview: (input) => ipcRenderer.invoke("review:export", input)
};

contextBridge.exposeInMainWorld("paperPilot", api);
