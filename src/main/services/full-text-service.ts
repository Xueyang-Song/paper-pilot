import type { Artifact, Paper } from "../../shared/schemas.js";
import type { ArtifactService } from "./artifact-service.js";

export class FullTextService {
  constructor(private readonly artifacts: ArtifactService) {}

  async fetchOpenAccessPdf(projectId: string, paper: Paper): Promise<{ artifact?: Artifact; warning?: string }> {
    if (
      !paper.pdfUrl ||
      (!paper.isOpenAccess && !paper.pdfUrl.includes("arxiv.org") && !paper.pdfUrl.includes("pmc.ncbi.nlm.nih.gov"))
    ) {
      return {};
    }
    try {
      const response = await fetch(paper.pdfUrl, {
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/pdf,*/*",
          "User-Agent": "PaperPilot/0.1 open-access-fetcher"
        }
      });
      if (!response.ok) {
        return { warning: `${paper.title}: PDF fetch failed ${response.status} ${response.statusText}` };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("pdf") && !buffer.subarray(0, 5).toString("utf8").startsWith("%PDF")) {
        return { warning: `${paper.title}: full-text URL did not return a PDF.` };
      }
      const artifact = await this.artifacts.writeArtifact({
        projectId,
        type: "paper-pdf",
        title: paper.title,
        content: buffer,
        extension: ".pdf",
        source: paper.source,
        metadata: {
          paperId: paper.id,
          doi: paper.doi,
          sourcePaperId: paper.sourcePaperId,
          pdfUrl: paper.pdfUrl
        }
      });
      return { artifact };
    } catch (error) {
      return {
        warning: `${paper.title}: PDF fetch failed gracefully: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
}
