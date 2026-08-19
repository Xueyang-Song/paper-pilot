import { type CrawlConfig, type Paper, paperSchema } from "../../shared/schemas.js";
import { id } from "../utils.js";
import { googleScholarPlaywrightScript } from "../sources/browser-scripts.js";
import type { PythonService } from "./python-service.js";

export class BrowserCrawlerService {
  constructor(private readonly python: PythonService) {}

  async runGoogleScholar(projectId: string, config: CrawlConfig): Promise<{ papers: Paper[]; warnings: string[] }> {
    const result = await this.python.runProjectScript({
      projectId,
      name: "google-scholar-playwright-crawl",
      code: googleScholarPlaywrightScript,
      args: [config.topic, String(config.maxPapers)],
      approved: true
    });
    const jsonLine = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}"))
      .at(-1);
    if (!jsonLine) {
      return {
        papers: [],
        warnings: [`Google Scholar browser crawl produced no JSON output. ${browserFailureDiagnostics(result)}`.trim()]
      };
    }
    try {
      const parsed = JSON.parse(jsonLine) as { papers?: unknown[]; warnings?: string[] };
      return {
        papers: (parsed.papers ?? []).map((paper) => paperSchema.parse({ id: id("paper"), ...(paper as object) })),
        warnings: parsed.warnings ?? []
      };
    } catch (error) {
      return {
        papers: [],
        warnings: [
          `Google Scholar browser crawl returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
        ]
      };
    }
  }
}

function browserFailureDiagnostics(result: { status: string; stdout: string; stderr: string }): string {
  const combinedOutput = `${result.stderr}\n${result.stdout}`;
  return [
    result.status === "failed" ? "The Playwright browser script failed." : undefined,
    classifyBrowserFailure(combinedOutput),
    result.stderr ? `stderr: ${result.stderr.slice(0, 500)}` : undefined,
    result.stdout ? "stdout did not contain a JSON result line." : "stdout was empty."
  ]
    .filter(Boolean)
    .join(" ");
}

function classifyBrowserFailure(output: string): string | undefined {
  if (/Executable doesn't exist|playwright install|browserType\.launch|chromium.*not.*found/i.test(output)) {
    return "Playwright Chromium is not installed or could not be found. Use the browser install approval flow and retry.";
  }
  if (/No module named ['"]?playwright|ModuleNotFoundError|pip.*install.*playwright/i.test(output)) {
    return "The Playwright Python package is missing or failed to install.";
  }
  if (/TargetClosedError|host system is missing dependencies|browser.*launch|failed to launch/i.test(output)) {
    return "Playwright could not launch Chromium on this machine.";
  }
  if (/captcha|unusual traffic|blocked|\/sorry/i.test(output)) {
    return "The browser source appears to be blocked by a CAPTCHA or anti-automation page.";
  }
  if (/Timeout|timed out|waiting for selector/i.test(output)) {
    return "The browser source timed out waiting for visible results.";
  }
  return undefined;
}
