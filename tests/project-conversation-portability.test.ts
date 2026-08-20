import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { buildProjectExportBundle, importProjectBundle, type IpcServices } from "../src/main/ipc";
import { ArtifactService } from "../src/main/services/artifact-service";

let dir: string;
let db: PaperPilotDb;
let artifacts: ArtifactService;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-portability-"));
  db = new PaperPilotDb(join(dir, "portability.db"));
  artifacts = new ArtifactService(db, dir);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("project conversation portability", () => {
  it("remaps conversation source scope and citation targets during duplication", async () => {
    const project = db.createProject("Portable project");
    const paper = db.savePaper(project.id, {
      id: "original_paper",
      title: "Portable evidence",
      abstract: "Portable evidence supports the measured result.",
      authors: ["Author"],
      source: "openalex",
      isOpenAccess: true,
      fieldsOfStudy: []
    });
    const source = await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Portable source",
      content: "Portable evidence supports the measured result.",
      metadata: { paperId: paper.id }
    });
    const originalChunk = db.listArtifactChunks(project.id, source.id, 1)[0];
    const conversation = db.ensureDefaultConversation(project.id);
    const runId = "original_run";
    const sourceRefs = [
      { type: "paper" as const, id: paper.id },
      { type: "artifact" as const, id: source.id }
    ];
    const user = db.appendMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId,
      role: "user",
      content: "What is supported?",
      metadata: { sourceRefs }
    });
    const assistant = db.appendMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId,
      role: "assistant",
      content: "The measured result is supported. [[S1]]",
      metadata: { sourceRefs, citationIds: ["original_citation"] }
    });
    const timestamp = new Date().toISOString();
    db.saveChatRun({
      id: runId,
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      provider: "ollama",
      model: "test-model",
      mode: "grounded",
      status: "completed",
      sourceRefs,
      includedMessageCount: 1,
      omittedMessageCount: 0,
      trace: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    db.replaceCitations(runId, [
      {
        id: "original_citation",
        runId,
        messageId: assistant.id,
        evidenceId: "S1",
        sourceType: "artifact",
        paperId: paper.id,
        artifactId: source.id,
        chunkId: originalChunk.chunkId,
        title: source.title,
        excerpt: originalChunk.text,
        retrievalScore: 1
      }
    ]);

    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    const duplicate = await importProjectBundle(services, bundle);
    const duplicateConversation = db.listConversations(duplicate.id)[0];
    const duplicateRun = db.listChatRuns(duplicateConversation.id)[0];
    const duplicatePaper = db.listPapers(duplicate.id)[0];
    const duplicateSource = db.listArtifacts(duplicate.id).find((artifact) => artifact.title === source.title)!;
    const duplicateCitation = db.listCitations(duplicateRun.id)[0];
    const duplicateUser = db.listMessages(duplicate.id, duplicateConversation.id)[0];
    const duplicateAssistant = db.listMessages(duplicate.id, duplicateConversation.id)[1];

    expect(duplicateRun.sourceRefs).toEqual([
      { type: "paper", id: duplicatePaper.id },
      { type: "artifact", id: duplicateSource.id }
    ]);
    expect(duplicateUser.metadata.sourceRefs).toEqual(duplicateRun.sourceRefs);
    expect(duplicateUser.createdAt).toBe(user.createdAt);
    expect(duplicateCitation).toMatchObject({
      paperId: duplicatePaper.id,
      artifactId: duplicateSource.id
    });
    expect(duplicateCitation.chunkId).toBeTruthy();
    expect(duplicateCitation.chunkId).not.toBe(originalChunk.chunkId);
    expect(duplicateAssistant.metadata.citationIds).toEqual([duplicateCitation.id]);
  });

  it("rejects a corrupt bundle before creating a partial project", async () => {
    const project = db.createProject("Original project");
    await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Original artifact",
      content: "trusted content"
    });
    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    const corrupt = {
      ...bundle,
      project: { ...bundle.project, title: "Corrupt import" },
      artifacts: [{ ...bundle.artifacts[0], contentBase64: Buffer.from("tampered").toString("base64") }]
    };

    await expect(importProjectBundle(services, corrupt)).rejects.toThrow(/checksum mismatch/i);
    expect(db.listProjects().some((candidate) => candidate.title === "Corrupt import")).toBe(false);
  });
});
