import electron from "electron";
import type { BrowserWindow as BrowserWindowType, IpcMainInvokeEvent } from "electron";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import {
  artifactSchema,
  artifactUpdateSchema,
  appSettingsSchema,
  aiModelListRequestSchema,
  aiProviderCheckRequestSchema,
  chatModeSchema,
  chatRunSchema,
  chatRunEventSchema,
  citationSchema,
  conversationSchema,
  credentialUpsertSchema,
  crawlConfigSchema,
  discoveryBatchSchema,
  extractionFieldSchema,
  extractionValueSchema,
  messageSchema,
  paperSchema,
  paperUpdateSchema,
  projectSchema,
  projectUpdateSchema,
  reindexRequestSchema,
  reviewAuditEventSchema,
  reviewEvidenceSchema,
  reviewProtocolRevisionSchema,
  reviewProtocolSchema,
  reviewRunItemSchema,
  reviewRunSchema,
  searchRequestSchema,
  screeningDecisionSchema,
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
import type { ReviewAgentService } from "./services/review-agent-service.js";
import type { SettingsService } from "./services/settings-service.js";
import type { UpdateService } from "./services/update-service.js";

const { BrowserWindow, dialog, ipcMain, shell } = electron;
const MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024;

export interface IpcServices {
  db: PaperPilotDb;
  registry: SourceRegistry;
  researchChat: ResearchChatService;
  reviewAgent: ReviewAgentService;
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
    if (services.reviewAgent.isProjectActive(parsed.projectId)) {
      throw new Error("Stop the active evidence-review run before deleting this project.");
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
    if (services.reviewAgent.isProjectActive(parsed.projectId)) {
      throw new Error("Stop the active evidence-review run before duplicating this project.");
    }
    return copyProject(services, parsed.projectId, parsed.title ?? `Copy of ${project.title}`);
  });

  ipcMain.handle("projects:export", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    const project = services.db.getProject(parsed.projectId);
    if (!project) throw new Error(`Project not found: ${parsed.projectId}`);
    if (services.reviewAgent.isProjectActive(parsed.projectId)) {
      throw new Error("Stop the active evidence-review run before exporting this project.");
    }
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

  ipcMain.handle("ai:listModels", (_event, input: unknown) =>
    services.ai.listModels(aiModelListRequestSchema.parse(input))
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

const reviewCandidateOriginPortabilitySchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  batchId: z.string(),
  paperId: z.string().optional(),
  matchedPaperId: z.string().optional(),
  sourceRecordId: z.string().optional(),
  resolution: z.enum(["created", "duplicate", "merged", "kept-separate", "skipped", "invalid", "filtered"]),
  paperSnapshot: z.record(z.string(), z.unknown()),
  recordSnapshot: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});

const reviewRereviewFlagPortabilitySchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  paperId: z.string(),
  stage: z.enum(["title-abstract", "full-text"]),
  protocolRevisionId: z.string(),
  paperSnapshot: z.record(z.string(), z.unknown()),
  invalidatesDownstream: z.boolean().optional(),
  createdAt: z.string(),
  resolvedAt: z.string().optional()
});

const discoveryBatchPortabilitySchema = discoveryBatchSchema.extend({
  config: z.record(z.string(), z.unknown()).default({})
});

const screeningDecisionPortabilitySchema = screeningDecisionSchema.extend({
  paperSnapshot: z.record(z.string(), z.unknown())
});

const extractionValuePortabilitySchema = extractionValueSchema.extend({
  paperSnapshot: z.record(z.string(), z.unknown())
});

const reviewRunItemPortabilitySchema = reviewRunItemSchema.omit({ evidence: true }).extend({
  evidenceIds: z.array(z.string()).default([]),
  paperSnapshot: z.record(z.string(), z.unknown()),
  stale: z.boolean().default(false)
});

const extractionFieldHistoryPortabilitySchema = extractionFieldSchema.extend({ recordedAt: z.string() });
const extractionValueHistoryPortabilitySchema = extractionValueSchema.extend({
  changeRevision: z.number().int().positive(),
  paperSnapshot: z.record(z.string(), z.unknown()),
  recordedAt: z.string()
});
const reviewEvidencePortabilitySchema = reviewEvidenceSchema.extend({
  paperSnapshot: z.record(z.string(), z.unknown()).optional()
});

export const reviewPortabilityStateSchema = z.object({
  review: reviewProtocolSchema,
  revisions: z.array(reviewProtocolRevisionSchema),
  discoveryBatches: z.array(discoveryBatchPortabilitySchema),
  candidateOrigins: z.array(reviewCandidateOriginPortabilitySchema),
  rereviewFlags: z.array(reviewRereviewFlagPortabilitySchema),
  screeningDecisions: z.array(screeningDecisionPortabilitySchema),
  extractionFields: z.array(extractionFieldSchema),
  extractionFieldHistory: z.array(extractionFieldHistoryPortabilitySchema).optional(),
  extractionValues: z.array(extractionValuePortabilitySchema),
  extractionValueHistory: z.array(extractionValueHistoryPortabilitySchema).optional(),
  evidence: z.array(reviewEvidencePortabilitySchema),
  runs: z.array(reviewRunSchema),
  runItems: z.array(reviewRunItemPortabilitySchema),
  auditEvents: z.array(reviewAuditEventSchema)
});
export type ReviewPortabilityState = z.infer<typeof reviewPortabilityStateSchema>;

const projectExportBundleSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
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
  ),
  review: reviewPortabilityStateSchema.optional()
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
  const review = services.db.getReview(projectId);
  const reviewState = review
    ? terminalReviewPortabilityState(
        reviewPortabilityStateSchema.parse(services.db.exportReviewPortabilityState(review.id))
      )
    : undefined;
  return {
    version: 3,
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
    artifacts,
    review: reviewState
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
  prevalidateProjectBundle(bundle);
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
  const writtenArtifactPaths = new Set<string>();
  try {
    if (bundle.project.pinnedAt) services.db.setProjectPinned(project.id, true);
    const paperIdMap = new Map<string, string>();
    for (const paperInput of bundle.papers ?? []) {
      const parsed = paperSchema.parse({ ...paperInput, id: id("paper"), projectId: project.id });
      const saved = services.db.savePaper(project.id, parsed);
      paperIdMap.set(paperInput.id, saved.id);
    }
    const artifactIdMap = new Map<string, string>();
    for (const artifactInput of orderArtifactsForImport(bundle.artifacts ?? [])) {
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
      writtenArtifactPaths.add(artifact.path);
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
    if (bundle.review) {
      const remappedReview = remapReviewPortabilityState({
        db: services.db,
        projectId: project.id,
        state: bundle.review,
        paperIdMap,
        artifactIdMap
      });
      services.db.importReviewPortabilityState(project.id, remappedReview);
    }
    return services.db.getProject(project.id) ?? project;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      for (const artifact of services.db.listArtifacts(project.id)) writtenArtifactPaths.add(artifact.path);
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError);
    }
    try {
      if (services.db.getProject(project.id)) services.db.deleteProject(project.id);
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError);
    }
    const fileResults = await Promise.allSettled([...writtenArtifactPaths].map((path) => rm(path, { force: true })));
    rollbackErrors.push(
      ...fileResults.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []))
    );
    if (services.dataRoot) {
      try {
        await rm(projectDataPath(services.dataRoot, project.id), { recursive: true, force: true });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Project import failed and rollback was incomplete.", {
        cause: error
      });
    }
    throw error;
  }
}

function prevalidateProjectBundle(bundle: ProjectExportBundle): void {
  if (bundle.version < 3 && bundle.review) {
    throw new Error("Evidence-review state requires project export bundle version 3.");
  }
  const paperIds = uniqueIds(bundle.papers, "paper");
  const artifactIds = uniqueIds(bundle.artifacts, "artifact");
  const conversations = bundle.conversations ?? [];
  const conversationIds = uniqueIds(conversations, "conversation");
  const messages = bundle.messages ?? [];
  const messageIds = uniqueIds(messages, "message");
  const runs = bundle.runs ?? [];
  const runIds = uniqueIds(runs, "chat run");
  const citations = bundle.citations ?? [];
  uniqueIds(citations, "citation");

  for (const paper of bundle.papers) {
    if (paper.projectId && paper.projectId !== bundle.project.id) {
      throw new Error(`Project paper belongs to a different project: ${paper.id}`);
    }
  }
  for (const artifact of bundle.artifacts) {
    if (artifact.projectId !== bundle.project.id) {
      throw new Error(`Project artifact belongs to a different project: ${artifact.id}`);
    }
    if (artifact.parentArtifactId && !artifactIds.has(artifact.parentArtifactId)) {
      throw new Error(`Project artifact references a missing parent: ${artifact.id}`);
    }
  }
  // This also detects parent cycles before any files are written.
  orderArtifactsForImport(bundle.artifacts);

  for (const conversation of conversations) {
    if (conversation.projectId !== bundle.project.id) {
      throw new Error(`Conversation belongs to a different project: ${conversation.id}`);
    }
  }
  for (const message of messages) {
    if (message.projectId !== bundle.project.id)
      throw new Error(`Message belongs to a different project: ${message.id}`);
    if (message.conversationId && conversations.length && !conversationIds.has(message.conversationId)) {
      throw new Error(`Message references a missing conversation: ${message.id}`);
    }
    if (message.runId && !runIds.has(message.runId)) throw new Error(`Message references a missing run: ${message.id}`);
  }
  for (const run of runs) {
    if (run.projectId !== bundle.project.id) throw new Error(`Chat run belongs to a different project: ${run.id}`);
    if (conversations.length && !conversationIds.has(run.conversationId)) {
      throw new Error(`Chat run references a missing conversation: ${run.id}`);
    }
    if (!messageIds.has(run.userMessageId) || (run.assistantMessageId && !messageIds.has(run.assistantMessageId))) {
      throw new Error(`Chat run references a missing message: ${run.id}`);
    }
    if (run.outputArtifactId && !artifactIds.has(run.outputArtifactId)) {
      throw new Error(`Chat run references a missing output artifact: ${run.id}`);
    }
    for (const sourceRef of run.sourceRefs) {
      if (sourceRef.type === "paper" && !paperIds.has(sourceRef.id)) {
        throw new Error(`Chat run references a missing paper: ${run.id}`);
      }
      if (sourceRef.type === "artifact" && !artifactIds.has(sourceRef.id)) {
        throw new Error(`Chat run references a missing artifact: ${run.id}`);
      }
    }
  }
  for (const citation of citations) {
    if (!runIds.has(citation.runId)) throw new Error(`Citation references a missing run: ${citation.id}`);
    if (citation.messageId && !messageIds.has(citation.messageId)) {
      throw new Error(`Citation references a missing message: ${citation.id}`);
    }
    if (citation.paperId && !paperIds.has(citation.paperId)) {
      throw new Error(`Citation references a missing paper: ${citation.id}`);
    }
    if (citation.artifactId && !artifactIds.has(citation.artifactId)) {
      throw new Error(`Citation references a missing artifact: ${citation.id}`);
    }
  }

  if (bundle.review) prevalidateReviewState(bundle.review, bundle.project.id, paperIds, bundle.artifacts);
}

function prevalidateReviewState(
  state: ReviewPortabilityState,
  sourceProjectId: string,
  livePaperIds: ReadonlySet<string>,
  liveArtifacts: readonly ProjectExportBundle["artifacts"][number][]
): void {
  if (state.review.projectId !== sourceProjectId) throw new Error("Portable review belongs to a different project.");
  const revisionIds = uniqueIds(state.revisions, "review protocol revision");
  if (!revisionIds.has(state.review.currentRevisionId)) {
    throw new Error("Portable review state does not include its current protocol revision.");
  }
  const revisionVersions = new Set<number>();
  const criteriaByRevision = new Map<string, Set<string>>();
  const allCriterionIds = new Set<string>();
  for (const revision of state.revisions) {
    if (revision.reviewId !== state.review.id)
      throw new Error(`Protocol revision has the wrong review: ${revision.id}`);
    if (revisionVersions.has(revision.version))
      throw new Error(`Duplicate protocol revision version: ${revision.version}`);
    revisionVersions.add(revision.version);
    const criterionIds = uniqueIds(revision.criteria, `criterion in protocol revision ${revision.id}`);
    for (const criterionId of criterionIds) {
      if (allCriterionIds.has(criterionId)) throw new Error(`Duplicate review criterion id: ${criterionId}`);
      allCriterionIds.add(criterionId);
    }
    criteriaByRevision.set(revision.id, criterionIds);
  }
  if (
    state.review.currentRevisionNumber !==
    state.revisions.find((item) => item.id === state.review.currentRevisionId)?.version
  ) {
    throw new Error("Portable review current revision number does not match its revision record.");
  }

  const batchIds = uniqueIds(state.discoveryBatches, "discovery batch");
  for (const batch of state.discoveryBatches) {
    if (batch.reviewId !== state.review.id) throw new Error(`Discovery batch has the wrong review: ${batch.id}`);
  }
  uniqueIds(state.candidateOrigins, "candidate origin");
  for (const origin of state.candidateOrigins) {
    if (origin.reviewId !== state.review.id || !batchIds.has(origin.batchId)) {
      throw new Error(`Candidate origin is outside the portable review: ${origin.id}`);
    }
    if (origin.paperId)
      assertPortablePaper(origin.paperId, origin.paperSnapshot, livePaperIds, `candidate origin ${origin.id}`);
    // matchedPaperId is provenance, not a live relationship: retain the opaque source identity even after deletion.
  }

  const runIds = uniqueIds(state.runs, "review run");
  const runById = new Map(state.runs.map((run) => [run.id, run]));
  const fieldIds = uniqueIds(state.extractionFields, "extraction field");
  for (const field of state.extractionFields) {
    if (field.reviewId !== state.review.id) throw new Error(`Extraction field has the wrong review: ${field.id}`);
  }
  for (const field of state.extractionFieldHistory ?? []) {
    if (field.reviewId !== state.review.id || !fieldIds.has(field.id)) {
      throw new Error(`Extraction field history is outside the portable review: ${field.id}`);
    }
  }
  for (const run of state.runs) {
    if (run.reviewId !== state.review.id || !revisionIds.has(run.protocolRevisionId)) {
      throw new Error(`Review run is outside the portable review: ${run.id}`);
    }
    if (run.status === "queued" || run.status === "running") {
      throw new Error(`Portable review run is not terminal: ${run.id}`);
    }
    if (run.fieldIds.some((fieldId) => !fieldIds.has(fieldId))) {
      throw new Error(`Review run references an unavailable extraction field: ${run.id}`);
    }
  }

  const runItemIds = uniqueIds(state.runItems, "review run item");
  const runItemById = new Map(state.runItems.map((item) => [item.id, item]));
  const snapshotPaperIds = new Set<string>();
  const rememberSnapshot = (value: Record<string, unknown>): void => {
    const snapshotId = typeof value.id === "string" ? value.id : undefined;
    if (snapshotId) snapshotPaperIds.add(snapshotId);
  };
  state.candidateOrigins.forEach((origin) => rememberSnapshot(origin.paperSnapshot));
  state.rereviewFlags.forEach((flag) => rememberSnapshot(flag.paperSnapshot));
  state.screeningDecisions.forEach((decision) => rememberSnapshot(decision.paperSnapshot));
  state.extractionValues.forEach((value) => rememberSnapshot(value.paperSnapshot));
  (state.extractionValueHistory ?? []).forEach((value) => rememberSnapshot(value.paperSnapshot));
  state.evidence.forEach((evidence) => {
    if (evidence.paperSnapshot) rememberSnapshot(evidence.paperSnapshot);
  });
  state.runItems.forEach((item) => rememberSnapshot(item.paperSnapshot));

  for (const item of state.runItems) {
    const run = runById.get(item.runId);
    if (!run) throw new Error(`Review run item references a missing run: ${item.id}`);
    if (item.status === "queued" || item.status === "running") {
      throw new Error(`Portable review run item is not terminal: ${item.id}`);
    }
    assertPortablePaper(item.paperId, item.paperSnapshot, livePaperIds, `review run item ${item.id}`);
    if (!run.paperIds.includes(item.paperId)) throw new Error(`Review run item paper is outside its run: ${item.id}`);
    const criterionIds = criteriaByRevision.get(run.protocolRevisionId)!;
    if (item.suggestedReasonCriterionId && !criterionIds.has(item.suggestedReasonCriterionId)) {
      throw new Error(`Review run item references a missing reason criterion: ${item.id}`);
    }
    for (const assessment of item.criterionAssessments) {
      if (!criterionIds.has(assessment.criterionId)) {
        throw new Error(`Review run item references a missing criterion assessment: ${item.id}`);
      }
    }
    for (const suggestion of item.extractionSuggestions) {
      if (!fieldIds.has(suggestion.fieldId)) {
        throw new Error(`Review run item references a missing extraction field: ${item.id}`);
      }
    }
  }
  for (const run of state.runs) {
    for (const paperId of run.paperIds) {
      if (!livePaperIds.has(paperId) && !snapshotPaperIds.has(paperId)) {
        throw new Error(`Review run references a paper without a retained snapshot: ${run.id}`);
      }
    }
  }

  const decisionIds = uniqueIds(state.screeningDecisions, "screening decision");
  const decisionById = new Map(state.screeningDecisions.map((decision) => [decision.id, decision]));
  for (const decision of state.screeningDecisions) {
    if (decision.reviewId !== state.review.id || !revisionIds.has(decision.protocolRevisionId)) {
      throw new Error(`Screening decision is outside the portable review: ${decision.id}`);
    }
    assertPortablePaper(decision.paperId, decision.paperSnapshot, livePaperIds, `screening decision ${decision.id}`);
    if (decision.previousDecisionId && !decisionIds.has(decision.previousDecisionId)) {
      throw new Error(`Screening decision references missing history: ${decision.id}`);
    }
    const previous = decision.previousDecisionId ? decisionById.get(decision.previousDecisionId) : undefined;
    if (previous && (previous.paperId !== decision.paperId || previous.stage !== decision.stage)) {
      throw new Error(`Screening decision history crosses papers or stages: ${decision.id}`);
    }
    const revisionCriterionIds = criteriaByRevision.get(decision.protocolRevisionId)!;
    if (decision.reasonCriterionId && !revisionCriterionIds.has(decision.reasonCriterionId)) {
      throw new Error(`Screening decision references a missing reason criterion: ${decision.id}`);
    }
    if (decision.reasonCriterionId) {
      const criterion = state.revisions
        .find((revision) => revision.id === decision.protocolRevisionId)!
        .criteria.find((candidate) => candidate.id === decision.reasonCriterionId)!;
      if (criterion.stage !== decision.stage || criterion.type !== "exclusion") {
        throw new Error(`Screening decision uses an invalid exclusion criterion: ${decision.id}`);
      }
    }
    if (decision.runItemId && !runItemIds.has(decision.runItemId)) {
      throw new Error(`Screening decision references a missing review run item: ${decision.id}`);
    }
  }

  uniqueIds(state.rereviewFlags, "re-review flag");
  for (const flag of state.rereviewFlags) {
    if (flag.reviewId !== state.review.id || !revisionIds.has(flag.protocolRevisionId)) {
      throw new Error(`Re-review flag is outside the portable review: ${flag.id}`);
    }
    assertPortablePaper(flag.paperId, flag.paperSnapshot, livePaperIds, `re-review flag ${flag.id}`);
  }

  const evidenceIds = uniqueIds(state.evidence, "review evidence");
  const artifactById = new Map(liveArtifacts.map((artifact) => [artifact.id, artifact]));
  for (const evidence of state.evidence) {
    if (evidence.reviewId !== state.review.id) throw new Error(`Review evidence has the wrong review: ${evidence.id}`);
    if (evidence.runId && !runIds.has(evidence.runId))
      throw new Error(`Review evidence references a missing run: ${evidence.id}`);
    if (evidence.runItemId && !runItemIds.has(evidence.runItemId)) {
      throw new Error(`Review evidence references a missing run item: ${evidence.id}`);
    }
    if (evidence.runItemId) {
      const item = runItemById.get(evidence.runItemId)!;
      if (
        (evidence.runId && evidence.runId !== item.runId) ||
        (evidence.paperId && evidence.paperId !== item.paperId)
      ) {
        throw new Error(`Review evidence ownership does not match its run item: ${evidence.id}`);
      }
    }
    if (evidence.paperId && !livePaperIds.has(evidence.paperId) && !snapshotPaperIds.has(evidence.paperId)) {
      throw new Error(`Review evidence references a paper without a retained snapshot: ${evidence.id}`);
    }
    if (evidence.sourceType === "artifact-chunk" && evidence.artifactId) {
      const artifact = artifactById.get(evidence.artifactId);
      const evidencePaperId = evidence.paperId ?? metadataString(evidence.paperSnapshot?.id);
      if (!artifact) throw new Error(`Review evidence references a missing artifact: ${evidence.id}`);
      if (!evidence.chunkId)
        throw new Error(`Review evidence references a live artifact without a chunk: ${evidence.id}`);
      if (
        !evidencePaperId ||
        (artifact.type !== "paper-pdf" && artifact.type !== "markdown" && artifact.type !== "table") ||
        artifact.source === "research-chat" ||
        metadataString(artifact.metadata.paperId) !== evidencePaperId
      ) {
        throw new Error(`Review evidence references an untrusted or mismatched artifact: ${evidence.id}`);
      }
    }
  }
  for (const item of state.runItems) {
    for (const evidenceId of item.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) throw new Error(`Review run item references missing evidence: ${item.id}`);
      if (state.evidence.find((entry) => entry.id === evidenceId)?.runItemId !== item.id) {
        throw new Error(`Review run item references evidence owned by another item: ${item.id}`);
      }
    }
    const ownedApplicationEvidenceIds = new Set(
      state.evidence
        .filter((entry) => entry.runItemId === item.id && item.evidenceIds.includes(entry.id))
        .map((entry) => entry.evidenceId)
    );
    for (const assessment of item.criterionAssessments) {
      if (assessment.evidenceIds.some((evidenceId) => !ownedApplicationEvidenceIds.has(evidenceId))) {
        throw new Error(`Review criterion assessment references missing evidence: ${item.id}`);
      }
    }
    for (const suggestion of item.extractionSuggestions) {
      if (suggestion.evidenceIds.some((evidenceId) => !ownedApplicationEvidenceIds.has(evidenceId))) {
        throw new Error(`Review extraction suggestion references missing evidence: ${item.id}`);
      }
    }
  }

  uniqueIds(state.extractionValues, "extraction value");
  const extractionValueIds = new Set(state.extractionValues.map((value) => value.id));
  for (const value of state.extractionValues) {
    if (value.reviewId !== state.review.id || !fieldIds.has(value.fieldId)) {
      throw new Error(`Extraction value is outside the portable review: ${value.id}`);
    }
    assertPortablePaper(value.paperId, value.paperSnapshot, livePaperIds, `extraction value ${value.id}`);
    if (value.runItemId && !runItemIds.has(value.runItemId)) {
      throw new Error(`Extraction value references a missing run item: ${value.id}`);
    }
    if (value.runItemId && runItemById.get(value.runItemId)?.paperId !== value.paperId) {
      throw new Error(`Extraction value references a run item for another paper: ${value.id}`);
    }
    if (value.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new Error(`Extraction value references missing evidence: ${value.id}`);
    }
  }
  for (const value of state.extractionValueHistory ?? []) {
    if (!extractionValueIds.has(value.id) || value.reviewId !== state.review.id || !fieldIds.has(value.fieldId)) {
      throw new Error(`Extraction value history is outside the portable review: ${value.id}`);
    }
    assertPortablePaper(value.paperId, value.paperSnapshot, livePaperIds, `extraction value history ${value.id}`);
    if (value.runItemId && !runItemIds.has(value.runItemId)) {
      throw new Error(`Extraction value history references a missing run item: ${value.id}`);
    }
    if (value.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))) {
      throw new Error(`Extraction value history references missing evidence: ${value.id}`);
    }
  }
  uniqueIds(state.auditEvents, "review audit event");
  for (const event of state.auditEvents) {
    if (event.reviewId !== state.review.id) throw new Error(`Audit event has the wrong review: ${event.id}`);
  }

  for (const decision of state.screeningDecisions) {
    if (!decision.runItemId) continue;
    const item = runItemById.get(decision.runItemId)!;
    const run = runById.get(item.runId)!;
    if (item.paperId !== decision.paperId || run.stage !== decision.stage) {
      throw new Error(`Screening decision references a run item for another paper: ${decision.id}`);
    }
  }
}

function uniqueIds<T extends { id: string }>(values: readonly T[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new Error(`Duplicate ${label} id: ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function assertPortablePaper(
  paperId: string,
  snapshot: Record<string, unknown>,
  livePaperIds: ReadonlySet<string>,
  label: string
): void {
  if (livePaperIds.has(paperId)) return;
  const parsed = paperSchema.safeParse(snapshot);
  if (!parsed.success || parsed.data.id !== paperId) {
    throw new Error(`${label} references a deleted paper without a valid retained snapshot: ${paperId}`);
  }
}

function orderArtifactsForImport(artifacts: ProjectExportBundle["artifacts"]): ProjectExportBundle["artifacts"] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ProjectExportBundle["artifacts"] = [];
  const visit = (artifact: ProjectExportBundle["artifacts"][number]): void => {
    if (visited.has(artifact.id)) return;
    if (visiting.has(artifact.id)) throw new Error(`Artifact parent cycle detected at: ${artifact.id}`);
    visiting.add(artifact.id);
    if (artifact.parentArtifactId) {
      const parent = byId.get(artifact.parentArtifactId);
      if (!parent) throw new Error(`Project artifact references a missing parent: ${artifact.id}`);
      visit(parent);
    }
    visiting.delete(artifact.id);
    visited.add(artifact.id);
    ordered.push(artifact);
  };
  artifacts.forEach(visit);
  return ordered;
}

function terminalReviewPortabilityState(state: ReviewPortabilityState): ReviewPortabilityState {
  const runs = state.runs.filter((run) => run.status !== "queued" && run.status !== "running");
  const runIds = new Set(runs.map((run) => run.id));
  const runItems = state.runItems.filter((item) => runIds.has(item.runId));
  const runItemIds = new Set(runItems.map((item) => item.id));
  return reviewPortabilityStateSchema.parse({
    ...state,
    runs,
    runItems,
    screeningDecisions: state.screeningDecisions.map((decision) => ({
      ...decision,
      runItemId: decision.runItemId && runItemIds.has(decision.runItemId) ? decision.runItemId : undefined
    })),
    extractionValues: state.extractionValues.map((value) => ({
      ...value,
      runItemId: value.runItemId && runItemIds.has(value.runItemId) ? value.runItemId : undefined
    })),
    evidence: state.evidence.map((evidence) => ({
      ...evidence,
      runId: evidence.runId && runIds.has(evidence.runId) ? evidence.runId : undefined,
      runItemId: evidence.runItemId && runItemIds.has(evidence.runItemId) ? evidence.runItemId : undefined
    }))
  });
}

interface ReviewRemapInput {
  db: PaperPilotDb;
  projectId: string;
  state: ReviewPortabilityState;
  paperIdMap: Map<string, string>;
  artifactIdMap: Map<string, string>;
}

interface ReviewIdentifierMaps {
  projectId: string;
  reviewIds: Map<string, string>;
  revisionIds: Map<string, string>;
  criterionIds: Map<string, string>;
  batchIds: Map<string, string>;
  originIds: Map<string, string>;
  decisionIds: Map<string, string>;
  rereviewIds: Map<string, string>;
  fieldIds: Map<string, string>;
  valueIds: Map<string, string>;
  evidenceIds: Map<string, string>;
  runIds: Map<string, string>;
  runItemIds: Map<string, string>;
  auditIds: Map<string, string>;
  paperIds: Map<string, string>;
  artifactIds: Map<string, string>;
  chunkIds: Map<string, string>;
}

function remapReviewPortabilityState(input: ReviewRemapInput): ReviewPortabilityState {
  const state = terminalReviewPortabilityState(input.state);
  const maps: ReviewIdentifierMaps = {
    projectId: input.projectId,
    reviewIds: new Map([[state.review.id, id("review")]]),
    revisionIds: idMap(state.revisions, "protocol"),
    criterionIds: idMap(
      state.revisions.flatMap((revision) => revision.criteria),
      "criterion"
    ),
    batchIds: idMap(state.discoveryBatches, "batch"),
    originIds: idMap(state.candidateOrigins, "origin"),
    decisionIds: idMap(state.screeningDecisions, "decision"),
    rereviewIds: idMap(state.rereviewFlags, "rereview"),
    fieldIds: idMap(state.extractionFields, "field"),
    valueIds: idMap(state.extractionValues, "value"),
    evidenceIds: idMap(state.evidence, "review_evidence"),
    runIds: idMap(state.runs, "review_run"),
    runItemIds: idMap(state.runItems, "review_item"),
    auditIds: idMap(state.auditEvents, "audit"),
    paperIds: input.paperIdMap,
    artifactIds: input.artifactIdMap,
    chunkIds: new Map()
  };
  const mappedReviewId = requiredMappedId(maps.reviewIds, state.review.id, "review");

  const evidence = state.evidence.map((item) => {
    const mappedArtifactId = item.artifactId ? maps.artifactIds.get(item.artifactId) : undefined;
    const mappedChunkId = mappedArtifactId
      ? findImportedReviewChunkId(input.db, input.projectId, mappedArtifactId, item)
      : undefined;
    if (item.chunkId && mappedChunkId) maps.chunkIds.set(item.chunkId, mappedChunkId);
    return {
      ...item,
      id: requiredMappedId(maps.evidenceIds, item.id, "review evidence"),
      reviewId: mappedReviewId,
      runId: item.runId ? maps.runIds.get(item.runId) : undefined,
      runItemId: item.runItemId ? maps.runItemIds.get(item.runItemId) : undefined,
      paperId: item.paperId ? maps.paperIds.get(item.paperId) : undefined,
      artifactId: mappedArtifactId,
      chunkId: mappedChunkId,
      paperSnapshot: item.paperSnapshot ? remapPaperSnapshot(item.paperSnapshot, maps) : undefined
    };
  });

  const remapped = {
    review: {
      ...state.review,
      id: mappedReviewId,
      projectId: input.projectId,
      currentRevisionId: requiredMappedId(maps.revisionIds, state.review.currentRevisionId, "current protocol revision")
    },
    revisions: state.revisions.map((revision) => ({
      ...revision,
      id: requiredMappedId(maps.revisionIds, revision.id, "protocol revision"),
      reviewId: mappedReviewId,
      criteria: revision.criteria.map((criterion) => ({
        ...criterion,
        id: requiredMappedId(maps.criterionIds, criterion.id, "review criterion")
      }))
    })),
    discoveryBatches: state.discoveryBatches.map((batch) => ({
      ...batch,
      id: requiredMappedId(maps.batchIds, batch.id, "discovery batch"),
      reviewId: mappedReviewId,
      config: remapPortableRecord(batch.config, maps)
    })),
    candidateOrigins: state.candidateOrigins.map((origin) => ({
      ...origin,
      id: requiredMappedId(maps.originIds, origin.id, "candidate origin"),
      reviewId: mappedReviewId,
      batchId: requiredMappedId(maps.batchIds, origin.batchId, "candidate origin batch"),
      paperId: origin.paperId ? (maps.paperIds.get(origin.paperId) ?? origin.paperId) : undefined,
      matchedPaperId: origin.matchedPaperId
        ? (maps.paperIds.get(origin.matchedPaperId) ?? origin.matchedPaperId)
        : undefined,
      paperSnapshot: remapPaperSnapshot(origin.paperSnapshot, maps),
      recordSnapshot: {
        ...remapPortableRecord(origin.recordSnapshot, maps),
        ...(origin.matchedPaperId && !maps.paperIds.has(origin.matchedPaperId)
          ? { unavailableMatchedPaperId: origin.matchedPaperId }
          : {})
      }
    })),
    rereviewFlags: state.rereviewFlags.map((flag) => ({
      ...flag,
      id: requiredMappedId(maps.rereviewIds, flag.id, "re-review flag"),
      reviewId: mappedReviewId,
      paperId: maps.paperIds.get(flag.paperId) ?? flag.paperId,
      protocolRevisionId: requiredMappedId(maps.revisionIds, flag.protocolRevisionId, "re-review protocol revision"),
      paperSnapshot: remapPaperSnapshot(flag.paperSnapshot, maps)
    })),
    screeningDecisions: state.screeningDecisions.map((decision) => ({
      ...decision,
      id: requiredMappedId(maps.decisionIds, decision.id, "screening decision"),
      reviewId: mappedReviewId,
      paperId: maps.paperIds.get(decision.paperId) ?? decision.paperId,
      protocolRevisionId: requiredMappedId(maps.revisionIds, decision.protocolRevisionId, "decision protocol revision"),
      reasonCriterionId: decision.reasonCriterionId ? maps.criterionIds.get(decision.reasonCriterionId) : undefined,
      previousDecisionId: decision.previousDecisionId ? maps.decisionIds.get(decision.previousDecisionId) : undefined,
      runItemId: decision.runItemId ? maps.runItemIds.get(decision.runItemId) : undefined,
      paperSnapshot: remapPaperSnapshot(decision.paperSnapshot, maps)
    })),
    extractionFields: state.extractionFields.map((field) => ({
      ...field,
      id: requiredMappedId(maps.fieldIds, field.id, "extraction field"),
      reviewId: mappedReviewId
    })),
    extractionFieldHistory: (state.extractionFieldHistory ?? []).map((field) => ({
      ...field,
      id: requiredMappedId(maps.fieldIds, field.id, "historical extraction field"),
      reviewId: mappedReviewId
    })),
    extractionValues: state.extractionValues.map((value) => ({
      ...value,
      id: requiredMappedId(maps.valueIds, value.id, "extraction value"),
      reviewId: mappedReviewId,
      paperId: maps.paperIds.get(value.paperId) ?? value.paperId,
      fieldId: requiredMappedId(maps.fieldIds, value.fieldId, "extraction value field"),
      evidenceIds: value.evidenceIds.flatMap((evidenceId) => {
        const mapped = maps.evidenceIds.get(evidenceId);
        return mapped ? [mapped] : [];
      }),
      runItemId: value.runItemId ? maps.runItemIds.get(value.runItemId) : undefined,
      paperSnapshot: remapPaperSnapshot(value.paperSnapshot, maps)
    })),
    extractionValueHistory: (state.extractionValueHistory ?? []).map((value) => ({
      ...value,
      id: requiredMappedId(maps.valueIds, value.id, "historical extraction value"),
      reviewId: mappedReviewId,
      paperId: maps.paperIds.get(value.paperId) ?? value.paperId,
      fieldId: requiredMappedId(maps.fieldIds, value.fieldId, "historical extraction value field"),
      evidenceIds: value.evidenceIds.map((evidenceId) =>
        requiredMappedId(maps.evidenceIds, evidenceId, "historical extraction value evidence")
      ),
      runItemId: value.runItemId ? maps.runItemIds.get(value.runItemId) : undefined,
      paperSnapshot: remapPaperSnapshot(value.paperSnapshot, maps)
    })),
    evidence,
    runs: state.runs.map((run) => ({
      ...run,
      id: requiredMappedId(maps.runIds, run.id, "review run"),
      reviewId: mappedReviewId,
      protocolRevisionId: requiredMappedId(maps.revisionIds, run.protocolRevisionId, "run protocol revision"),
      paperIds: run.paperIds.map((paperId) => maps.paperIds.get(paperId) ?? paperId),
      fieldIds: run.fieldIds.map((fieldId) => requiredMappedId(maps.fieldIds, fieldId, "run extraction field"))
    })),
    runItems: state.runItems.map((item) => ({
      ...item,
      id: requiredMappedId(maps.runItemIds, item.id, "review run item"),
      runId: requiredMappedId(maps.runIds, item.runId, "review run item run"),
      paperId: maps.paperIds.get(item.paperId) ?? item.paperId,
      suggestedReasonCriterionId: item.suggestedReasonCriterionId
        ? maps.criterionIds.get(item.suggestedReasonCriterionId)
        : undefined,
      criterionAssessments: item.criterionAssessments.map((assessment) => ({
        ...assessment,
        criterionId: requiredMappedId(maps.criterionIds, assessment.criterionId, "assessed review criterion")
      })),
      extractionSuggestions: item.extractionSuggestions.map((suggestion) => ({
        ...suggestion,
        fieldId: requiredMappedId(maps.fieldIds, suggestion.fieldId, "suggested extraction field")
      })),
      evidenceIds: item.evidenceIds.flatMap((evidenceId) => {
        const mapped = maps.evidenceIds.get(evidenceId);
        return mapped ? [mapped] : [];
      }),
      paperSnapshot: remapPaperSnapshot(item.paperSnapshot, maps)
    })),
    auditEvents: state.auditEvents.map((event) => ({
      ...event,
      id: requiredMappedId(maps.auditIds, event.id, "review audit event"),
      reviewId: mappedReviewId,
      entityId: remapAuditEntityId(event.entityType, event.entityId, maps),
      payload: remapPortableRecord(event.payload, maps)
    }))
  };
  return reviewPortabilityStateSchema.parse(remapped);
}

function idMap<T extends { id: string }>(values: T[], prefix: string): Map<string, string> {
  return new Map(values.map((value) => [value.id, id(prefix)]));
}

function requiredMappedId(map: Map<string, string>, value: string, label: string): string {
  const mapped = map.get(value);
  if (!mapped) throw new Error(`Project review references an unavailable ${label}: ${value}`);
  return mapped;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function remapPaperSnapshot(snapshot: Record<string, unknown>, maps: ReviewIdentifierMaps): Record<string, unknown> {
  const remapped = remapPortableRecord(snapshot, maps);
  if (typeof snapshot.id === "string") remapped.id = maps.paperIds.get(snapshot.id) ?? snapshot.id;
  remapped.projectId = maps.projectId;
  return remapped;
}

function remapPortableRecord(value: Record<string, unknown>, maps: ReviewIdentifierMaps): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapPortableValue(key, item, maps)]));
}

function remapPortableValue(key: string, value: unknown, maps: ReviewIdentifierMaps): unknown {
  if (Array.isArray(value)) {
    const singularKey = key.endsWith("Ids") ? `${key.slice(0, -3)}Id` : key;
    return value.map((item) => remapPortableValue(singularKey, item, maps));
  }
  if (value && typeof value === "object") return remapPortableRecord(value as Record<string, unknown>, maps);
  if (typeof value !== "string") return value;
  const map = identifierMapForKey(key, maps);
  return map?.get(value) ?? (key === "projectId" ? maps.projectId : value);
}

function identifierMapForKey(key: string, maps: ReviewIdentifierMaps): Map<string, string> | undefined {
  if (key === "reviewId") return maps.reviewIds;
  if (key === "revisionId" || key === "protocolRevisionId" || key === "currentRevisionId") return maps.revisionIds;
  if (key === "criterionId" || key === "reasonCriterionId") return maps.criterionIds;
  if (key === "batchId") return maps.batchIds;
  if (key === "originId") return maps.originIds;
  if (key === "decisionId" || key === "previousDecisionId" || key === "supersedesDecisionId") return maps.decisionIds;
  if (key === "rereviewId") return maps.rereviewIds;
  if (key === "fieldId") return maps.fieldIds;
  if (key === "valueId" || key === "extractionValueId") return maps.valueIds;
  if (key === "evidenceId" || key === "reviewEvidenceId") return maps.evidenceIds;
  if (key === "runId") return maps.runIds;
  if (key === "runItemId") return maps.runItemIds;
  if (key === "paperId" || key === "matchedPaperId") return maps.paperIds;
  if (key === "artifactId") return maps.artifactIds;
  if (key === "chunkId") return maps.chunkIds;
  return undefined;
}

function remapAuditEntityId(
  entityType: string | undefined,
  entityId: string | undefined,
  maps: ReviewIdentifierMaps
): string | undefined {
  if (!entityId) return undefined;
  const map =
    entityType === "review"
      ? maps.reviewIds
      : entityType === "protocol-revision"
        ? maps.revisionIds
        : entityType === "review-criterion"
          ? maps.criterionIds
          : entityType === "discovery-batch"
            ? maps.batchIds
            : entityType === "candidate-origin"
              ? maps.originIds
              : entityType === "screening-decision"
                ? maps.decisionIds
                : entityType === "extraction-field"
                  ? maps.fieldIds
                  : entityType === "extraction-value"
                    ? maps.valueIds
                    : entityType === "review-evidence"
                      ? maps.evidenceIds
                      : entityType === "review-run"
                        ? maps.runIds
                        : entityType === "review-run-item"
                          ? maps.runItemIds
                          : entityType === "paper"
                            ? maps.paperIds
                            : entityType === "artifact"
                              ? maps.artifactIds
                              : undefined;
  return map?.get(entityId) ?? entityId;
}

function findImportedReviewChunkId(
  db: PaperPilotDb,
  projectId: string,
  artifactId: string,
  evidence: ReviewPortabilityState["evidence"][number]
): string | undefined {
  const excerpt = evidence.excerpt.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!excerpt) return undefined;
  const chunks = db.listArtifactChunks(projectId, artifactId, 10_000);
  return chunks.find((chunk) => chunk.text.replace(/\s+/g, " ").includes(excerpt))?.chunkId;
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
  const safeValue = /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

function isTextArtifact(mime: string, type: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    ["metadata-json", "markdown", "crawl-log", "brief", "script", "table"].includes(type)
  );
}
