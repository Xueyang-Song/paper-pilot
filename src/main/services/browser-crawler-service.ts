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
        warnings: [`Google Scholar browser crawl produced no JSON output. ${result.stderr}`.trim()]
      };
    }
    const parsed = JSON.parse(jsonLine) as { papers?: unknown[]; warnings?: string[] };
    return {
      papers: (parsed.papers ?? []).map((paper) => paperSchema.parse({ id: id("paper"), ...(paper as object) })),
      warnings: parsed.warnings ?? []
    };
  }
}
