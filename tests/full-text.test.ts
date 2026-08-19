import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { ArtifactService } from "../src/main/services/artifact-service";
import { FullTextService } from "../src/main/services/full-text-service";

let dir: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-full-text-"));
  db = new PaperPilotDb(join(dir, "full-text.db"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("FullTextService", () => {
  it("stores open-access PDF responses as artifacts", async () => {
    const project = db.createProject("OA PDF");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(Buffer.from("%PDF-1.7\nfixture"), {
            status: 200,
            headers: { "content-type": "application/pdf" }
          })
      )
    );
    const service = new FullTextService(new ArtifactService(db, dir));
    const result = await service.fetchOpenAccessPdf(project.id, {
      id: "paper_pdf",
      title: "Open PDF",
      authors: [],
      source: "arxiv",
      pdfUrl: "https://arxiv.org/pdf/1234.5678",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    expect(result.warning).toBeUndefined();
    expect(result.artifact?.type).toBe("paper-pdf");
    expect(db.listArtifacts(project.id)).toHaveLength(1);
  });
});
