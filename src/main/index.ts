import electron from "electron";
import type { BrowserWindow as BrowserWindowType } from "electron";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { PaperPilotDb } from "./db.js";
import { registerIpc } from "./ipc.js";
import { SourceRegistry } from "./sources/registry.js";
import { AgentService } from "./services/agent-service.js";
import { AiService } from "./services/ai-service.js";
import { ArtifactService } from "./services/artifact-service.js";
import { BrowserCrawlerService } from "./services/browser-crawler-service.js";
import { CredentialService } from "./services/credential-service.js";
import { CrawlService } from "./services/crawl-service.js";
import { FullTextService } from "./services/full-text-service.js";
import { JobQueue } from "./services/job-queue.js";
import { LocalAgentService } from "./services/local-agent-service.js";
import { PaperScoringService } from "./services/paper-scoring-service.js";
import { PythonService } from "./services/python-service.js";
import { SearchService } from "./services/search-service.js";
import { SettingsService } from "./services/settings-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const { app, BrowserWindow, shell } = electron;

let mainWindow: BrowserWindowType | undefined;

function createWindow(): BrowserWindowType {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    title: "Paper Pilot",
    backgroundColor: "#f6f2ea",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.once("ready-to-show", () => window.show());
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

app.whenReady().then(() => {
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
  const crawl = new CrawlService(db, registry, credentials, artifacts, jobs, browserCrawler, fullText, scoring);
  const ai = new AiService(db, settings, credentials, artifacts, jobs);
  const localAgent = new LocalAgentService(db, registry, crawl, ai, jobs);
  const agent = new AgentService(db, crawl, ai, artifacts, jobs, localAgent);

  registerIpc({ db, registry, agent, crawl, ai, artifacts, credentials, settings, python, jobs, scoring, search });
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
