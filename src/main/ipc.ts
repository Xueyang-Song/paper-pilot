import electron from "electron";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import {
  artifactUpdateSchema,
  appSettingsSchema,
  aiProviderCheckRequestSchema,
  chatRequestSchema,
  credentialUpsertSchema,
  crawlConfigSchema,
  paperSchema,
  paperUpdateSchema,
  projectUpdateSchema,
  reindexRequestSchema,
  searchRequestSchema,
  type Artifact,
  type Paper,
  type ProjectPolicy
} from "../shared/schemas.js";
import type { PaperPilotDb } from "./db.js";
import { id, projectDataPath, safeFilename } from "./utils.js";
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

const { BrowserWindow, dialog, ipcMain, shell } = electron;
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
  dataRoot: string;
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
    services.db.deleteProject(parsed.projectId);
    await rm(projectDataPath(services.dataRoot, parsed.projectId), { recursive: true, force: true });
    return { ok: true };
  });

  ipcMain.handle("projects:duplicate", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), title: z.string().trim().min(1).max(120).optional() }).parse(input);
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
    const raw = JSON.parse(await readFile(filePath, "utf8")) as ProjectExportBundle;
    return importProjectBundle(services, raw);
  });

  ipcMain.handle("projects:updatePolicy", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string(), patch: z.record(z.string(), z.unknown()) }).parse(input);
    return services.db.updateProjectPolicy(parsed.projectId, parsed.patch as Partial<ProjectPolicy>);
  });

  ipcMain.handle("chat:send", (_event, input: unknown) => services.agent.handleChat(chatRequestSchema.parse(input)));

  ipcMain.handle("chat:clear", (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    return { cleared: services.db.clearMessages(parsed.projectId) };
  });

  ipcMain.handle("chat:export", async (_event, input: unknown) => {
    const parsed = z.object({ projectId: z.string() }).parse(input);
    const project = services.db.getProject(parsed.projectId);
    if (!project) throw new Error(`Project not found: ${parsed.projectId}`);
    const result = await dialog.showSaveDialog({
      title: "Export conversation",
      defaultPath: `${safeFilename(project.title)}-conversation.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }]
    });
    if (result.canceled || !result.filePath) return { ok: false };
    const messages = services.db.listMessages(parsed.projectId);
    const content = messages.map((message) => `## ${message.role}\n\n${message.content}`).join("\n\n");
    await writeFile(result.filePath, content, "utf8");
    return { ok: true, path: result.filePath, count: messages.length };
  });

  ipcMain.handle("sources:list", () => services.registry.list());

  ipcMain.handle("settings:get", () => services.settings.get());

  ipcMain.handle("settings:update", (_event, input: unknown) => services.settings.update(appSettingsSchema.partial().parse(input)));

  ipcMain.handle("app:openDataFolder", async () => {
    const error = await shell.openPath(services.dataRoot);
    if (error) throw new Error(error);
    return { ok: true };
  });

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

  ipcMain.handle("ai:checkProvider", (_event, input: unknown) => services.ai.checkProvider(aiProviderCheckRequestSchema.parse(input)));

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
      .object({ projectId: z.string(), paperIds: z.array(z.string()).optional(), format: z.enum(["bibtex", "ris", "csv"]).default("bibtex") })
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
    const exported = await services.artifacts.exportArtifacts({ projectId: parsed.projectId, artifactIds: parsed.artifactIds, targetDir });
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
}

interface ProjectExportBundle {
  version: 1;
  exportedAt: string;
  project: ReturnType<PaperPilotDb["getProject"]>;
  messages: ReturnType<PaperPilotDb["listMessages"]>;
  papers: Paper[];
  artifacts: Array<Artifact & { filename: string; contentBase64: string }>;
}

async function buildProjectExportBundle(services: IpcServices, projectId: string): Promise<ProjectExportBundle> {
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
    version: 1,
    exportedAt: new Date().toISOString(),
    project,
    messages: services.db.listMessages(projectId),
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

async function importProjectBundle(services: IpcServices, bundle: ProjectExportBundle) {
  if (!bundle.project) throw new Error("Project bundle is missing project metadata.");
  const project = services.db.createProject(bundle.project.title, bundle.project.topic, bundle.project.policy, bundle.project.description);
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
    const parentArtifactId = artifactInput.parentArtifactId ? artifactIdMap.get(artifactInput.parentArtifactId) : undefined;
    const artifact = await services.artifacts.writeArtifact({
      projectId: project.id,
      type: artifactInput.type,
      title: artifactInput.title,
      content: Buffer.from(artifactInput.contentBase64, "base64"),
      extension: extname(artifactInput.filename || artifactInput.path) || undefined,
      source: artifactInput.source,
      parentArtifactId,
      metadata,
      indexText: true
    });
    artifactIdMap.set(artifactInput.id, artifact.id);
  }
  for (const message of bundle.messages ?? []) {
    services.db.appendMessage({
      projectId: project.id,
      role: message.role,
      content: message.content,
      metadata: message.metadata
    });
  }
  return services.db.getProject(project.id) ?? project;
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
  const candidates = [artifact.metadata.url, artifact.metadata.pdfUrl, artifact.metadata.sourceUrl, artifact.metadata.doi, artifact.source];
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
