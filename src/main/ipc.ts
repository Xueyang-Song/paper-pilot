import electron from "electron";
import { stat } from "node:fs/promises";
import { z } from "zod";
import {
  appSettingsSchema,
  aiProviderCheckRequestSchema,
  chatRequestSchema,
  credentialUpsertSchema,
  crawlConfigSchema,
  reindexRequestSchema,
  searchRequestSchema,
  type ProjectPolicy
} from "../shared/schemas.js";
import type { PaperPilotDb } from "./db.js";
import type { SourceRegistry } from "./sources/registry.js";
import type { AgentService } from "./services/agent-service.js";
import type { AiService } from "./services/ai-service.js";
import type { ArtifactService } from "./services/artifact-service.js";
import type { CredentialService } from "./services/credential-service.js";
import type { CrawlService } from "./services/crawl-service.js";
import type { JobQueue } from "./services/job-queue.js";
import type { PaperScoringService } from "./services/paper-scoring-service.js";
import type { PythonService } from "./services/python-service.js";
import type { SearchService } from "./services/search-service.js";
import type { SettingsService } from "./services/settings-service.js";

const { BrowserWindow, ipcMain, shell } = electron;
const MAX_TEXT_VIEW_BYTES = 2 * 1024 * 1024;

export interface IpcServices {
  db: PaperPilotDb;
  registry: SourceRegistry;
  agent: AgentService;
  crawl: CrawlService;
  ai: AiService;
  artifacts: ArtifactService;
  credentials: CredentialService;
  settings: SettingsService;
  python: PythonService;
  jobs: JobQueue;
  scoring: PaperScoringService;
  search: SearchService;
}

export function registerIpc(services: IpcServices): void {
  ipcMain.handle("projects:list", () => services.db.listProjects());

  ipcMain.handle("projects:getBundle", (_event, projectId: unknown) => {
    const id = z.string().parse(projectId);
    const project = services.db.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return {
      project,
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

  ipcMain.handle("projects:updatePolicy", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), patch: z.record(z.string(), z.unknown()) }).parse(input);
    return services.db.updateProjectPolicy(parsed.projectId, parsed.patch as Partial<ProjectPolicy>);
  });

  ipcMain.handle("chat:send", (_event, input: unknown) => services.agent.handleChat(chatRequestSchema.parse(input)));

  ipcMain.handle("sources:list", () => services.registry.list());

  ipcMain.handle("settings:get", () => services.settings.get());

  ipcMain.handle("settings:update", (_event, input: unknown) => services.settings.update(appSettingsSchema.partial().parse(input)));

  ipcMain.handle("credentials:save", (_event, input: unknown) => {
    services.credentials.upsert(credentialUpsertSchema.parse(input));
    return services.credentials.listFlags();
  });

  ipcMain.handle("credentials:listFlags", () => services.credentials.listFlags());

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

  ipcMain.handle("ai:checkProvider", (_event, input: unknown) => services.ai.checkProvider(aiProviderCheckRequestSchema.parse(input)));

  ipcMain.handle("papers:score", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    return services.scoring.scoreProjectPapers(parsed.projectId);
  });

  ipcMain.handle("search:run", (_event, input: unknown) => services.search.search(searchRequestSchema.parse(input)));

  ipcMain.handle("search:reindex", (_event, input: unknown) => services.search.reindex(reindexRequestSchema.parse(input ?? {})));

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

  ipcMain.handle("artifacts:reveal", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), artifactId: z.string() }).parse(input);
    const artifact = services.db.listArtifacts(parsed.projectId).find((item) => item.id === parsed.artifactId);
    if (!artifact) throw new Error(`Artifact not found: ${parsed.artifactId}`);
    shell.showItemInFolder(artifact.path);
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
    return services.python.convertWithMarkItDown(parsed.projectId, parsed.sourcePath, parsed.approved, parsed.parentArtifactId);
  });

  ipcMain.handle("jobs:list", (_event, projectId: unknown) => services.jobs.list(typeof projectId === "string" ? projectId : undefined));

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

  services.jobs.onChanged((job) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("jobs:changed", job);
    }
  });
}

function isTextArtifact(mime: string, type: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    ["metadata-json", "markdown", "crawl-log", "brief", "script", "table"].includes(type)
  );
}
