import electron from "electron";
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent } from "electron";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import {
  artifactSchema,
  artifactUpdateSchema,
  appSettingsSchema,
  aiProviderCheckRequestSchema,
  chatModeSchema,
  chatRunSchema,
  chatRunEventSchema,
  citationSchema,
  conversationSchema,
  credentialUpsertSchema,
  crawlConfigSchema,
  messageSchema,
  paperSchema,
  paperUpdateSchema,
  projectSchema,
  projectUpdateSchema,
  reindexRequestSchema,
  searchRequestSchema,
  startChatRunRequestSchema,
  type Artifact,
  type Citation,
  type Paper,
  type ProjectPolicy,
  type SourceRef
} from "../shared/schemas.js";
import type { PaperPilotDb } from "./db.js";
import { id, projectDataPath, safeFilename, sha256 } from "./utils.js";
import type { SourceRegistry } from "./sources/registry.js";
import type { AiService } from "./services/ai-service.js";
import type { ArtifactService } from "./services/artifact-service.js";
import type { CredentialService } from "./services/credential-service.js";
import type { CrawlService } from "./services/crawl-service.js";
import type { JobQueue } from "./services/job-queue.js";
import type { PaperScoringService } from "./services/paper-scoring-service.js";
import type { PythonService } from "./services/python-service.js";
import type { SearchService } from "./services/search-service.js";
import type { ResearchChatService } from "./services/research-chat-service.js";
import type { SettingsService } from "./services/settings-service.js";
import type { UpdateService } from "./services/update-service.js";

const { BrowserWindow, dialog, ipcMain, shell } = electron;
const MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024;

export interface IpcServices {
  db: PaperPilotDb;
  registry: SourceRegistry;
  researchChat: ResearchChatService;
  crawl: CrawlService;
  ai: AiService;
  artifacts: ArtifactService;
  credentials: CredentialService;
  settings: SettingsService;
  python: PythonService;
  jobs: JobQueue;
  scoring: PaperScoringService;
  search: SearchService;
  updates: UpdateService;
  dataRoot: string;
}

export function registerIpc(services: IpcServices): void {
  ipcMain.handle("window:platform", () => process.platform);

  ipcMain.handle("window:minimize", (event) => {
    const window = windowFromEvent(event);
    window.minimize();
  });

  ipcMain.handle("window:toggleMaximize", (event) => {
    const window = windowFromEvent(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    const state = getWindowState(window);
    window.webContents.send("window:state-changed", state);
    return { isMaximized: state.isMaximized };
  });

  ipcMain.handle("window:close", (event) => {
    windowFromEvent(event).close();
  });

  ipcMain.handle("window:getState", (event) => getWindowState(windowFromEvent(event)));

  ipcMain.handle("window:setTitleBarTheme", (event, input: unknown) => {
    const theme = z.enum(["light", "dark"]).parse(input);
    const window = windowFromEvent(event);
    if (process.platform !== "darwin") {
      window.setTitleBarOverlay(titleBarOverlayOptions(theme));
    }
  });

  ipcMain.handle("projects:list", () => services.db.listProjects());

  ipcMain.handle("projects:getBundle", (_event, projectId: unknown) => {
    const id = z.string().parse(projectId);
    const project = services.db.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    services.db.ensureDefaultConversation(id);
    return {
      project,
      conversations: services.db.listConversations(id),
      messages: services.db.listMessages(id),
      artifacts: services.db.listArtifacts(id),
      papers: services.db.listPapers(id),
      jobs: services.jobs.list(id)
    };
  });

  ipcMain.handle("projects:create", (_event, input: unknown) => {
    const parsed = z.object({ title: z.string().min(1), topic: z.string().optional() }).parse(input);
    return services.db.createProject(parsed.title, parsed.topic);
  });

  ipcMain.handle("projects:rename", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), title: z.string().trim().min(1).max(120) }).parse(input);
    return services.db.renameProject(parsed.projectId, parsed.title);
  });

  ipcMain.handle("projects:update", (_event, input: unknown) => {
    const parsed = projectUpdateSchema.parse(input);
    return services.db.updateProject(parsed);
  });

  ipcMain.handle("projects:setPinned", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), pinned: z.boolean() }).parse(input);
    return services.db.setProjectPinned(parsed.projectId, parsed.pinned);
  });

  ipcMain.handle("projects:setArchived", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), archived: z.boolean() }).parse(input);
    return services.db.setProjectArchived(parsed.projectId, parsed.archived);
  });

  ipcMain.handle("projects:delete", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    if (services.researchChat.isProjectActive(parsed.projectId)) {
      throw new Error("Stop active research responses before deleting this project.");
    }
    services.db.deleteProject(parsed.projectId);
    await rm(projectDataPath(services.dataRoot, parsed.projectId), { recursive: true, force: true });
    return { ok: true };
  });

  ipcMain.handle("projects:duplicate", async (_event, input: unknown) => {
    const parsed = z
      .object({ projectId: z.string(), title: z.string().trim().min(1).max(120).optional() })
      .parse(input);
    const project = services.db.getProject(parsed.projectId);
    if (!project) throw new Error(`Project not found: ${parsed.projectId}`);
    return copyProject(services, parsed.projectId, parsed.title ?? `Copy of ${project.title}`);
  });

  ipcMain.handle("projects:export", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    const project = services.db.getProject(parsed.projectId);
    if (!project) throw new Error(`Project not found: ${parsed.projectId}`);
    const result = await dialog.showSaveDialog({
      title: "Export project",
      defaultPath: `${safeFilename(project.title)}.paperpilot.json`,
      filters: [{ name: "Paper Pilot project", extensions: ["json"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const bundle = await buildProjectExportBundle(services, parsed.projectId);
    await writeFile(result.filePath, JSON.stringify(bundle, null, 2), "utf8");
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle("projects:import", async () => {
    const result = await dialog.showOpenDialog({
      title: "Import project",
      properties: ["openFile"],
      filters: [{ name: "Paper Pilot project", extensions: ["json"] }]
    });
    const filePath = result.filePaths[0];
    if (result.canceled || !filePath) return undefined;
    const raw = projectExportBundleSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    return importProjectBundle(services, raw);
  });

  ipcMain.handle("projects:updatePolicy", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), patch: z.record(z.string(), z.unknown()) }).parse(input);
    return services.db.updateProjectPolicy(parsed.projectId, parsed.patch as Partial<ProjectPolicy>);
  });

  ipcMain.handle("conversations:list", (_event, projectIdInput: unknown) => {
    const projectId = z.string().parse(projectIdInput);
    services.db.ensureDefaultConversation(projectId);
    return services.db.listConversations(projectId);
  });

  ipcMain.handle("conversations:create", (_event, input: unknown) => {
    const parsed = z
      .object({
        projectId: z.string(),
        title: z.string().trim().min(1).max(120).optional(),
        mode: chatModeSchema.optional()
      })
      .parse(input);
    return services.db.createConversation(parsed.projectId, parsed.title, parsed.mode);
  });

  ipcMain.handle("conversations:update", (_event, input: unknown) => {
    const parsed = z
      .object({
        conversationId: z.string(),
        title: z.string().trim().min(1).max(120).optional(),
        mode: chatModeSchema.optional()
      })
      .parse(input);
    return services.db.updateConversation(parsed.conversationId, { title: parsed.title, mode: parsed.mode });
  });

  ipcMain.handle("conversations:delete", (_event, conversationIdInput: unknown) => {
    const conversationId = z.string().parse(conversationIdInput);
    if (services.researchChat.isConversationActive(conversationId)) {
      throw new Error("Stop the active response before deleting this conversation.");
    }
    return services.db.deleteConversation(conversationId);
  });

  ipcMain.handle("conversations:messages", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), conversationId: z.string() }).parse(input);
    return services.db.listMessages(parsed.projectId, parsed.conversationId);
  });

  ipcMain.handle("conversations:runs", (_event, conversationIdInput: unknown) =>
    services.db.listChatRuns(z.string().parse(conversationIdInput))
  );

  ipcMain.handle("chat:citations", (_event, runIdInput: unknown) =>
    services.db.listCitations(z.string().parse(runIdInput))
  );

  ipcMain.handle("chat:start", async (event, input: unknown) => {
    const parsed = startChatRunRequestSchema.parse(input);
    return services.researchChat.start(parsed, (runEvent) => {
      const validated = chatRunEventSchema.parse(runEvent);
      if (!event.sender.isDestroyed()) event.sender.send("chat:run-event", validated);
    });
  });

  ipcMain.handle("chat:cancel", (_event, runIdInput: unknown) => ({
    cancelled: services.researchChat.cancel(z.string().parse(runIdInput))
  }));

  ipcMain.handle("chat:clear", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), conversationId: z.string().optional() }).parse(input);
    return { cleared: services.db.clearMessages(parsed.projectId, parsed.conversationId) };
  });

  ipcMain.handle("chat:export", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), conversationId: z.string().optional() }).parse(input);
    const project = services.db.getProject(parsed.projectId);
    if (!project) throw new Error(`Project not found: ${parsed.projectId}`);
    const conversation = parsed.conversationId ? services.db.getConversation(parsed.conversationId) : undefined;
    const result = await dialog.showSaveDialog({
      title: "Export conversation",
      defaultPath: `${safeFilename(project.title)}-${safeFilename(conversation?.title ?? "conversation")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const messages = services.db.listMessages(parsed.projectId, parsed.conversationId);
    const content = [
      `# ${conversation?.title ?? project.title}`,
      "",
      `Project: ${project.title}`,
      ...(conversation ? [`Mode: ${conversation.mode}`] : []),
      "",
      ...messages.flatMap((message) => {
        const citations = message.runId ? services.db.listCitations(message.runId) : [];
        return [
          `## ${message.role}`,
          "",
          message.content,
          ...(citations.length
            ? [
                "",
                "### Evidence",
                "",
                ...citations.map(
                  (citation) =>
                    `- **${citation.evidenceId}: ${citation.title}**${citation.locator ? ` (${citation.locator})` : ""}`
                )
              ]
            : []),
          ""
        ];
      })
    ].join("\n");
    await writeFile(result.filePath, content, "utf8");
    return { ok: true, path: result.filePath, count: messages.length };
  });

  ipcMain.handle("sources:list", () => services.registry.list());

  ipcMain.handle("settings:get", () => services.settings.get());

  ipcMain.handle("settings:update", (_event, input: unknown) =>
    services.settings.update(appSettingsSchema.partial().parse(input))
  );

  ipcMain.handle("app:openDataFolder", async () => {
    const error = await shell.openPath(services.dataRoot);
    if (error) throw new Error(error);
    return { ok: true };
  });

  ipcMain.handle("updates:getStatus", () => services.updates.getStatus());

  ipcMain.handle("updates:check", () => services.updates.checkForUpdates(true));

  ipcMain.handle("updates:download", () => services.updates.downloadUpdate(true));

  ipcMain.handle("updates:installNow", () => services.updates.installUpdateNow());

  ipcMain.handle("credentials:save", (_event, input: unknown) => {
    services.credentials.upsert(credentialUpsertSchema.parse(input));
    return services.credentials.listFlags();
  });

  ipcMain.handle("credentials:listFlags", () => services.credentials.listFlags());

  ipcMain.handle("credentials:remove", (_event, input: unknown) => {
    const parsed = z.object({ sourceId: z.string(), label: z.string().default("default") }).parse(input);
    services.credentials.remove(parsed.sourceId, parsed.label);
    return services.credentials.listFlags();
  });

  ipcMain.handle("credentials:test", (_event, input: unknown) => {
    const parsed = z.object({ sourceId: z.string(), label: z.string().default("default") }).parse(input);
    return services.credentials.test(parsed.sourceId, parsed.label);
  });

  ipcMain.handle("crawl:run", (_event, input: unknown) => {
    const parsed = z
      .object({ projectId: z.string(), config: crawlConfigSchema.partial(), approved: z.boolean().default(false) })
      .parse(input);
    return services.crawl.runCrawl(parsed.projectId, parsed.config, { approved: parsed.approved });
  });

  ipcMain.handle("brief:generate", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), prompt: z.string().min(1) }).parse(input);
    return services.ai.generateResearchBrief(parsed.projectId, parsed.prompt);
  });

  ipcMain.handle("ai:checkProvider", (_event, input: unknown) =>
    services.ai.checkProvider(aiProviderCheckRequestSchema.parse(input))
  );

  ipcMain.handle("papers:score", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    return services.scoring.scoreProjectPapers(parsed.projectId);
  });

  ipcMain.handle("papers:update", (_event, input: unknown) => {
    const parsed = paperUpdateSchema.parse(input);
    return services.db.updatePaper(parsed.projectId, parsed.paperId, parsed.patch as Partial<Paper>);
  });

  ipcMain.handle("papers:delete", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), paperId: z.string() }).parse(input);
    services.db.deletePaper(parsed.projectId, parsed.paperId);
    return { ok: true };
  });

  ipcMain.handle("papers:exportCitations", async (_event, input: unknown) => {
    const parsed = z
      .object({
        projectId: z.string(),
        paperIds: z.array(z.string()).optional(),
        format: z.enum(["bibtex", "ris", "csv"]).default("bibtex")
      })
      .parse(input);
    const papers = services.db
      .listPapers(parsed.projectId)
      .filter((paper) => !parsed.paperIds?.length || parsed.paperIds.includes(paper.id));
    const project = services.db.getProject(parsed.projectId);
    const extension = parsed.format === "bibtex" ? "bib" : parsed.format;
    const result = await dialog.showSaveDialog({
      title: "Export citations",
      defaultPath: `${safeFilename(project?.title ?? "paper-pilot")}-citations.${extension}`,
      filters: [{ name: parsed.format.toUpperCase(), extensions: [extension] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    await writeFile(result.filePath, renderCitationExport(papers, parsed.format), "utf8");
    return { ok: true, path: result.filePath, count: papers.length };
  });

  ipcMain.handle("search:run", (_event, input: unknown) => services.search.search(searchRequestSchema.parse(input)));

  ipcMain.handle("search:reindex", (_event, input: unknown) =>
    services.search.reindex(reindexRequestSchema.parse(input ?? {}))
  );

  ipcMain.handle("artifacts:read", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactId: z.string() }).parse(input);
    const artifact = services.db.listArtifacts(parsed.projectId).find((item) => item.id === parsed.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${parsed.artifactId}`);
    const buffer = await services.artifacts.readArtifact(artifact);
    const fileStat = await stat(artifact.path).catch(() => undefined);
    const isText = isTextArtifact(artifact.mime, artifact.type);
    const contentBuffer = isText ? buffer.subarray(0, MAX_TEXT_VIEW_BYTES) : buffer;
    return {
      artifact,
      encoding: isText ? "utf8" : "base64",
      content: isText ? contentBuffer.toString("utf8") : contentBuffer.toString("base64"),
      size: fileStat?.size ?? buffer.byteLength,
      truncated: isText && buffer.byteLength > MAX_TEXT_VIEW_BYTES
    };
  });

  ipcMain.handle("artifacts:import", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    const result = await dialog.showOpenDialog({
      title: "Import file",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Research files", extensions: ["pdf", "md", "markdown", "txt", "json", "csv", "tsv", "py"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled || !result.filePaths.length) return [];
    const imported: Artifact[] = [];
    for (const sourcePath of result.filePaths) {
      imported.push(await services.artifacts.importUnknownFile({ projectId: parsed.projectId, sourcePath }));
    }
    return imported;
  });

  ipcMain.handle("artifacts:rename", (_event, input: unknown) => {
    const parsed = artifactUpdateSchema.parse(input);
    if (!parsed.title) throw new Error("Artifact title is required.");
    return services.artifacts.renameArtifact(parsed.projectId, parsed.artifactId, parsed.title);
  });

  ipcMain.handle("artifacts:delete", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactIds: z.array(z.string()).min(1) }).parse(input);
    for (const artifactId of parsed.artifactIds) {
      await services.artifacts.deleteArtifact(parsed.projectId, artifactId);
    }
    return { ok: true, deleted: parsed.artifactIds.length };
  });

  ipcMain.handle("artifacts:export", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactIds: z.array(z.string()).min(1) }).parse(input);
    const result = await dialog.showOpenDialog({
      title: "Export files to folder",
      properties: ["openDirectory", "createDirectory"]
    });
    const targetDir = result.filePaths[0];
    if (result.canceled || !targetDir) return { ok: false };
    const exported = await services.artifacts.exportArtifacts({
      projectId: parsed.projectId,
      artifactIds: parsed.artifactIds,
      targetDir
    });
    return { ok: true, ...exported };
  });

  ipcMain.handle("artifacts:reindex", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactIds: z.array(z.string()).min(1) }).parse(input);
    const warnings: string[] = [];
    let chunkCount = 0;
    for (const artifactId of parsed.artifactIds) {
      const artifact = services.db.getArtifact(parsed.projectId, artifactId);
      if (!artifact) continue;
      const result = await services.artifacts.indexArtifact(artifact, { replace: true });
      chunkCount += result.chunkCount;
      if (result.warning) warnings.push(result.warning);
    }
    return { artifactCount: parsed.artifactIds.length, chunkCount, warnings };
  });

  ipcMain.handle("artifacts:reveal", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactId: z.string() }).parse(input);
    const artifact = services.db.listArtifacts(parsed.projectId).find((item) => item.id === parsed.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${parsed.artifactId}`);
    shell.showItemInFolder(artifact.path);
    return { ok: true };
  });

  ipcMain.handle("artifacts:openSource", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactId: z.string() }).parse(input);
    const artifact = services.db.getArtifact(parsed.projectId, parsed.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${parsed.artifactId}`);
    const sourceUrl = artifactSourceUrl(artifact);
    if (!sourceUrl) throw new Error("This artifact does not have an external source URL.");
    void shell.openExternal(sourceUrl);
    return { ok: true };
  });

  ipcMain.handle("python:runScript", (_event, input: unknown) => {
    const parsed = z
      .object({
        projectId: z.string(),
        name: z.string().min(1),
        code: z.string().min(1),
        args: z.array(z.string()).optional(),
        approved: z.boolean().default(false)
      })
      .parse(input);
    return services.python.runProjectScript(parsed);
  });

  ipcMain.handle("python:installBrowser", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), approved: z.boolean().default(false) }).parse(input);
    return services.python.installPlaywrightChromium(parsed.projectId, parsed.approved);
  });

  ipcMain.handle("python:convertMarkItDown", (_event, input: unknown) => {
    const parsed = z
      .object({
        projectId: z.string(),
        sourcePath: z.string().min(1),
        approved: z.boolean().default(false),
        parentArtifactId: z.string().optional()
      })
      .parse(input);
    return services.python.convertWithMarkItDown(
      parsed.projectId,
      parsed.sourcePath,
      parsed.approved,
      parsed.parentArtifactId
    );
  });

  ipcMain.handle("jobs:list", (_event, projectId: unknown) =>
    services.jobs.list(typeof projectId === "string" ? projectId : undefined)
  );

  ipcMain.handle("jobs:approve", async (_event, jobIdInput: unknown) => {
    const jobId = z.string().parse(jobIdInput);
    const job = services.jobs.get(jobId);
    const approval = job?.result?.approval as { action?: string } | undefined;
    if (!job || job.status !== "waiting-approval" || !approval?.action) {
      throw new Error(`No pending approval found for job ${jobId}.`);
    }
    if (approval.action === "crawl") {
      return services.crawl.approvePendingCrawl(jobId);
    }
    if (approval.action === "python-script" || approval.action === "browser-install") {
      return services.python.approvePendingPythonJob(jobId);
    }
    throw new Error(`Unsupported approval action: ${approval.action}`);
  });

  ipcMain.handle("jobs:deny", (_event, jobIdInput: unknown) => {
    const jobId = z.string().parse(jobIdInput);
    const job = services.jobs.get(jobId);
    if (!job || job.status !== "waiting-approval") {
      throw new Error(`No pending approval found for job ${jobId}.`);
    }
    return services.jobs.update(jobId, {
      status: "cancelled",
      progress: 1,
      detail: "Denied by user.",
      result: { ...(job.result ?? {}), approval: undefined }
    });
  });

  ipcMain.handle("jobs:cancel", (_event, jobIdInput: unknown) => services.jobs.cancel(z.string().parse(jobIdInput)));

  ipcMain.handle("jobs:retry", (_event, jobIdInput: unknown) => services.jobs.retry(z.string().parse(jobIdInput)));

  ipcMain.handle("jobs:clearTerminal", (_event, projectIdInput: unknown) => {
    const projectId = typeof projectIdInput === "string" ? projectIdInput : undefined;
    return { cleared: services.jobs.clearTerminal(projectId) };
  });

  services.jobs.onChanged((job) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("jobs:changed", job);
    }
  });

  services.updates.on("changed", (status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("updates:changed", status);
    }
  });
}

interface WindowState {
  isMaximized: boolean;
  isFocused: boolean;
  isFullScreen: boolean;
}

function windowFromEvent(event: IpcMainInvokeEvent): BrowserWindowType {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error("No active window is associated with this request.");
  return window;
}

function getWindowState(window: BrowserWindowType): WindowState {
  return {
    isMaximized: window.isMaximized(),
    isFocused: window.isFocused(),
    isFullScreen: window.isFullScreen()
  };
}

function titleBarOverlayOptions(theme: "light" | "dark") {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#d8e3eaff" : "#17212bff",
    height: 44
  };
}

const projectExportBundleSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string(),
  project: projectSchema,
  conversations: z.array(conversationSchema).optional(),
  messages: z.array(messageSchema),
  runs: z.array(chatRunSchema).optional(),
  citations: z.array(citationSchema).optional(),
  papers: z.array(paperSchema),
  artifacts: z.array(
    artifactSchema.extend({
      filename: z.string(),
      contentBase64: z.string()
    })
  )
});
type ProjectExportBundle = z.infer<typeof projectExportBundleSchema>;

export async function buildProjectExportBundle(services: IpcServices, projectId: string): Promise<ProjectExportBundle> {
  const project = services.db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const artifacts = await Promise.all(
    services.db.listArtifacts(projectId).map(async (artifact) => ({
      ...artifact,
      filename: basename(artifact.path),
      contentBase64: (await readFile(artifact.path)).toString("base64")
    }))
  );
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    project,
    conversations: services.db.listConversations(projectId),
    messages: services.db.listMessages(projectId),
    runs: services.db.listConversations(projectId).flatMap((conversation) => services.db.listChatRuns(conversation.id)),
    citations: services.db
      .listConversations(projectId)
      .flatMap((conversation) => services.db.listChatRuns(conversation.id))
      .flatMap((run) => services.db.listCitations(run.id)),
    papers: services.db.listPapers(projectId),
    artifacts
  };
}

async function copyProject(services: IpcServices, projectId: string, title: string) {
  const project = services.db.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const bundle = await buildProjectExportBundle(services, projectId);
  return importProjectBundle(services, { ...bundle, project: { ...project, title } });
}

export async function importProjectBundle(services: IpcServices, bundleInput: unknown) {
  const bundle = projectExportBundleSchema.parse(bundleInput);
  for (const artifact of bundle.artifacts) {
    const content = Buffer.from(artifact.contentBase64, "base64");
    if (sha256(content) !== artifact.hash) throw new Error(`Artifact checksum mismatch: ${artifact.title}`);
  }
  const project = services.db.createProject(
    bundle.project.title,
    bundle.project.topic,
    bundle.project.policy,
    bundle.project.description
  );
  if (bundle.project.pinnedAt) services.db.setProjectPinned(project.id, true);
  const paperIdMap = new Map<string, string>();
  for (const paperInput of bundle.papers ?? []) {
    const parsed = paperSchema.parse({ ...paperInput, id: id("paper"), projectId: project.id });
    const saved = services.db.savePaper(project.id, parsed);
    paperIdMap.set(paperInput.id, saved.id);
  }
  const artifactIdMap = new Map<string, string>();
  for (const artifactInput of bundle.artifacts ?? []) {
    const metadata = { ...(artifactInput.metadata ?? {}) };
    const paperId = typeof metadata.paperId === "string" ? paperIdMap.get(metadata.paperId) : undefined;
    if (paperId) metadata.paperId = paperId;
    const parentArtifactId = artifactInput.parentArtifactId
      ? artifactIdMap.get(artifactInput.parentArtifactId)
      : undefined;
    const artifact = await services.artifacts.writeArtifact({
      projectId: project.id,
      type: artifactInput.type,
      title: artifactInput.title,
      content: Buffer.from(artifactInput.contentBase64, "base64"),
      extension: extname(artifactInput.filename || artifactInput.path) || undefined,
      source: artifactInput.source,
      parentArtifactId,
      metadata,
      indexText: artifactInput.type !== "chat-answer"
    });
    artifactIdMap.set(artifactInput.id, artifact.id);
  }
  const defaultConversation = services.db.ensureDefaultConversation(project.id);
  const conversationIdMap = new Map<string, string>();
  for (const [index, conversationInput] of (bundle.conversations ?? []).entries()) {
    const conversation =
      index === 0
        ? services.db.updateConversation(defaultConversation.id, {
            title: conversationInput.title,
            mode: conversationInput.mode
          })
        : services.db.createConversation(project.id, conversationInput.title, conversationInput.mode);
    conversationIdMap.set(conversationInput.id, conversation.id);
  }
  const runIdMap = new Map((bundle.runs ?? []).map((run) => [run.id, id("run")]));
  const citationIdMap = new Map((bundle.citations ?? []).map((citation) => [citation.id, id("cite")]));
  const messageIdMap = new Map<string, string>();
  for (const message of bundle.messages ?? []) {
    const metadata = remapResearchMetadata(message.metadata, paperIdMap, artifactIdMap, citationIdMap);
    const saved = services.db.appendMessage({
      projectId: project.id,
      conversationId: message.conversationId
        ? (conversationIdMap.get(message.conversationId) ?? defaultConversation.id)
        : defaultConversation.id,
      runId: message.runId ? runIdMap.get(message.runId) : undefined,
      role: message.role,
      content: message.content,
      status: message.status,
      metadata,
      createdAt: message.createdAt
    });
    messageIdMap.set(message.id, saved.id);
  }
  for (const artifactInput of bundle.artifacts ?? []) {
    if (artifactInput.type !== "chat-answer") continue;
    const mappedArtifactId = artifactIdMap.get(artifactInput.id);
    if (!mappedArtifactId) continue;
    const imported = services.db.getArtifact(project.id, mappedArtifactId);
    if (!imported) continue;
    const metadata = remapResearchMetadata(imported.metadata, paperIdMap, artifactIdMap, citationIdMap);
    if (typeof metadata.conversationId === "string") {
      metadata.conversationId = conversationIdMap.get(metadata.conversationId) ?? metadata.conversationId;
    }
    if (typeof metadata.runId === "string") metadata.runId = runIdMap.get(metadata.runId) ?? metadata.runId;
    if (typeof metadata.messageId === "string") {
      metadata.messageId = messageIdMap.get(metadata.messageId) ?? metadata.messageId;
    }
    services.db.updateArtifact(project.id, mappedArtifactId, { metadata });
  }
  for (const run of bundle.runs ?? []) {
    services.db.saveChatRun({
      ...run,
      id: runIdMap.get(run.id)!,
      projectId: project.id,
      conversationId: conversationIdMap.get(run.conversationId) ?? defaultConversation.id,
      userMessageId: messageIdMap.get(run.userMessageId) ?? run.userMessageId,
      assistantMessageId: run.assistantMessageId ? messageIdMap.get(run.assistantMessageId) : undefined,
      outputArtifactId: run.outputArtifactId ? artifactIdMap.get(run.outputArtifactId) : undefined,
      sourceRefs: remapSourceRefs(run.sourceRefs, paperIdMap, artifactIdMap),
      status: run.status === "running" || run.status === "queued" ? "failed" : run.status,
      error:
        run.status === "running" || run.status === "queued"
          ? "Imported run was incomplete in the source project."
          : run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    });
  }
  const citationsByRun = new Map<string, Citation[]>();
  for (const citation of bundle.citations ?? []) {
    const mappedRunId = runIdMap.get(citation.runId);
    if (!mappedRunId) continue;
    const artifactId = citation.artifactId ? artifactIdMap.get(citation.artifactId) : undefined;
    const mapped: Citation = {
      ...citation,
      id: citationIdMap.get(citation.id)!,
      runId: mappedRunId,
      messageId: citation.messageId ? messageIdMap.get(citation.messageId) : undefined,
      paperId: citation.paperId ? paperIdMap.get(citation.paperId) : undefined,
      artifactId,
      chunkId: artifactId ? findImportedChunkId(services.db, project.id, artifactId, citation) : undefined
    };
    citationsByRun.set(mappedRunId, [...(citationsByRun.get(mappedRunId) ?? []), mapped]);
  }
  for (const [runId, citations] of citationsByRun) {
    services.db.replaceCitations(runId, citations);
  }
  return services.db.getProject(project.id) ?? project;
}

function remapResearchMetadata(
  input: Record<string, unknown>,
  paperIdMap: Map<string, string>,
  artifactIdMap: Map<string, string>,
  citationIdMap: Map<string, string>
): Record<string, unknown> {
  const metadata = { ...input };
  if (Array.isArray(metadata.sourceRefs)) {
    metadata.sourceRefs = remapSourceRefs(metadata.sourceRefs, paperIdMap, artifactIdMap);
  }
  if (Array.isArray(metadata.citations)) {
    metadata.citations = metadata.citations.map((value) => {
      if (!value || typeof value !== "object") return value;
      const citation = { ...(value as Record<string, unknown>) };
      if (typeof citation.id === "string") citation.id = citationIdMap.get(citation.id) ?? citation.id;
      if (typeof citation.paperId === "string") citation.paperId = paperIdMap.get(citation.paperId);
      if (typeof citation.artifactId === "string") citation.artifactId = artifactIdMap.get(citation.artifactId);
      delete citation.chunkId;
      return citation;
    });
  }
  if (Array.isArray(metadata.citationIds)) {
    metadata.citationIds = metadata.citationIds.flatMap((value) =>
      typeof value === "string" && citationIdMap.has(value) ? [citationIdMap.get(value)!] : []
    );
  }
  return metadata;
}

function remapSourceRefs(
  values: unknown[],
  paperIdMap: Map<string, string>,
  artifactIdMap: Map<string, string>
): SourceRef[] {
  return values.flatMap<SourceRef>((value) => {
    if (!value || typeof value !== "object") return [];
    const candidate = value as { type?: unknown; id?: unknown };
    if (candidate.type === "paper" && typeof candidate.id === "string") {
      const mapped = paperIdMap.get(candidate.id);
      return mapped ? [{ type: "paper" as const, id: mapped }] : [];
    }
    if (candidate.type === "artifact" && typeof candidate.id === "string") {
      const mapped = artifactIdMap.get(candidate.id);
      return mapped ? [{ type: "artifact" as const, id: mapped }] : [];
    }
    return [];
  });
}

function findImportedChunkId(
  db: PaperPilotDb,
  projectId: string,
  artifactId: string,
  citation: Citation
): string | undefined {
  const excerpt = citation.excerpt.replace(/\s+/g, " ").trim().slice(0, 160);
  const chunks = db.listArtifactChunks(projectId, artifactId, 10_000);
  const exact = chunks.find((chunk) => chunk.text.replace(/\s+/g, " ").includes(excerpt));
  if (exact) return exact.chunkId;
  if (!citation.page) return undefined;
  return chunks.find((chunk) => {
    try {
      return Number((JSON.parse(chunk.metadataJson) as { page?: unknown }).page) === citation.page;
    } catch {
      return false;
    }
  })?.chunkId;
}

function renderCitationExport(papers: Paper[], format: "bibtex" | "ris" | "csv"): string {
  if (format === "csv") {
    const rows = [["Title", "Authors", "Year", "Venue", "DOI", "URL"]];
    for (const paper of papers) {
      rows.push([
        paper.title,
        paper.authors.join("; "),
        paper.year ? String(paper.year) : "",
        paper.venue ?? "",
        paper.doi ?? "",
        paper.url ?? ""
      ]);
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\n");
  }
  if (format === "ris") {
    return papers
      .map((paper) =>
        [
          "TY  - JOUR",
          ...paper.authors.map((author) => `AU  - ${author}`),
          paper.title ? `TI  - ${paper.title}` : undefined,
          paper.year ? `PY  - ${paper.year}` : undefined,
          paper.venue ? `JO  - ${paper.venue}` : undefined,
          paper.doi ? `DO  - ${paper.doi}` : undefined,
          paper.url ? `UR  - ${paper.url}` : undefined,
          "ER  -"
        ]
          .filter(Boolean)
          .join("\n")
      )
      .join("\n\n");
  }
  return papers
    .map((paper, index) => {
      const key = citationKey(paper, index);
      const fields = [
        bibField("title", paper.title),
        paper.authors.length ? bibField("author", paper.authors.join(" and ")) : undefined,
        paper.year ? bibField("year", String(paper.year)) : undefined,
        paper.venue ? bibField("journal", paper.venue) : undefined,
        paper.doi ? bibField("doi", paper.doi) : undefined,
        paper.url ? bibField("url", paper.url) : undefined
      ].filter(Boolean);
      return `@article{${key},\n${fields.join(",\n")}\n}`;
    })
    .join("\n\n");
}

function artifactSourceUrl(artifact: Artifact): string | undefined {
  const candidates = [
    artifact.metadata.url,
    artifact.metadata.pdfUrl,
    artifact.metadata.sourceUrl,
    artifact.metadata.doi,
    artifact.source
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    if (/^https?:\/\//i.test(candidate)) return candidate;
    if (/^10\.\d{4,9}\//.test(candidate)) return `https://doi.org/${candidate}`;
  }
  return undefined;
}

function citationKey(paper: Paper, index: number): string {
  const author = paper.authors[0]?.split(/\s+/).at(-1) ?? "paper";
  return `${author}${paper.year ?? "nd"}${index + 1}`.replace(/[^A-Za-z0-9:_-]/g, "");
}

function bibField(name: string, value: string): string {
  return `  ${name} = {${value.replace(/[{}]/g, "")}}`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isTextArtifact(mime: string, type: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    ["metadata-json", "markdown", "crawl-log", "brief", "script", "table"].includes(type)
  );
}
