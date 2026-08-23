import electron from "electron";
import type { BrowserWindow as BrowserWindowType } from "electron";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { PaperPilotDb } from "./db.js";
import { registerIpc } from "./ipc.js";
import { registerReviewIpc } from "./review-ipc.js";
import { SourceRegistry } from "./sources/registry.js";
import { AiService } from "./services/ai-service.js";
import { ArtifactService } from "./services/artifact-service.js";
import { BrowserCrawlerService } from "./services/browser-crawler-service.js";
import { CredentialService } from "./services/credential-service.js";
import { CrawlService } from "./services/crawl-service.js";
import { FullTextService } from "./services/full-text-service.js";
import { JobQueue } from "./services/job-queue.js";
import { PaperScoringService } from "./services/paper-scoring-service.js";
import { PythonService } from "./services/python-service.js";
import { SearchService } from "./services/search-service.js";
import { ResearchChatService } from "./services/research-chat-service.js";
import { ReviewAgentService } from "./services/review-agent-service.js";
import { ReviewImportManager } from "./services/review-import-manager.js";
import { SettingsService } from "./services/settings-service.js";
import { createUpdateService } from "./services/update-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { app, BrowserWindow, Menu, shell } = electron;

let mainWindow: BrowserWindowType | undefined;

function createWindow(): BrowserWindowType {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: "Paper Pilot",
    titleBarStyle: "hidden",
    ...(process.platform !== "darwin" ? { titleBarOverlay: titleBarOverlayOptions("dark") } : {}),
    autoHideMenuBar: true,
    backgroundColor: "#0f141c",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  wireWindowStateEvents(window);
  window.once("ready-to-show", () => {
    window.show();
    emitWindowState(window);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(__dirname, "../../dist/index.html"));
  }
  return window;
}

function wireWindowStateEvents(window: BrowserWindowType): void {
  window.on("maximize", () => emitWindowState(window));
  window.on("unmaximize", () => emitWindowState(window));
  window.on("restore", () => emitWindowState(window));
  window.on("focus", () => emitWindowState(window));
  window.on("blur", () => emitWindowState(window));
  window.on("enter-full-screen", () => emitWindowState(window));
  window.on("leave-full-screen", () => emitWindowState(window));
}

function emitWindowState(window: BrowserWindowType): void {
  if (window.isDestroyed()) return;
  window.webContents.send("window:state-changed", {
    isMaximized: window.isMaximized(),
    isFocused: window.isFocused(),
    isFullScreen: window.isFullScreen()
  });
}

export function titleBarOverlayOptions(theme: "light" | "dark"): Electron.TitleBarOverlay {
  return {
    color: "#00000000",
    symbolColor: theme === "dark" ? "#d8e3eaff" : "#17212bff",
    height: 44
  };
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  const dataRoot = app.getPath("userData");
  const db = new PaperPilotDb(join(dataRoot, "paper-pilot.db"));
  const registry = new SourceRegistry();
  const jobs = new JobQueue(db);
  const artifacts = new ArtifactService(db, dataRoot);
  const credentials = new CredentialService(db);
  const settings = new SettingsService(join(dataRoot, "settings", "app-settings.json"), credentials);
  const python = new PythonService(db, dataRoot, settings, artifacts, jobs);
  const browserCrawler = new BrowserCrawlerService(python);
  const fullText = new FullTextService(artifacts);
  const scoring = new PaperScoringService(db);
  const search = new SearchService(db, artifacts);
  const crawl = new CrawlService(
    db,
    registry,
    credentials,
    artifacts,
    jobs,
    browserCrawler,
    fullText,
    scoring,
    settings
  );
  const ai = new AiService(db, settings, credentials, artifacts, jobs);
  const researchChat = new ResearchChatService(db, artifacts, settings, credentials, registry, crawl, ai, jobs);
  const reviewImports = new ReviewImportManager(db);
  const reviewAgent = new ReviewAgentService(db, settings, credentials);
  const updates = createUpdateService({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform
  });

  registerIpc({
    db,
    registry,
    researchChat,
    reviewAgent,
    crawl,
    ai,
    artifacts,
    credentials,
    settings,
    python,
    jobs,
    scoring,
    search,
    updates,
    dataRoot
  });
  registerReviewIpc({
    db,
    imports: reviewImports,
    agent: reviewAgent,
    artifacts,
    fullText,
    settings
  });
  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  updates.start();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
