import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
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

  it("rejects invalid review references before creating project rows or artifact files", async () => {
    const project = db.createProject("Semantic source");
    db.createReview({ projectId: project.id, researchQuestion: "Is this portable?" });
    await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Semantic source artifact",
      content: "source"
    });
    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    const invalid = {
      ...bundle,
      project: { ...bundle.project, title: "Invalid semantic import" },
      review: {
        ...bundle.review!,
        review: { ...bundle.review!.review, currentRevisionId: "missing-revision" }
      }
    };
    const beforeEntries = await readdir(join(dir, "projects"), { recursive: true });

    await expect(importProjectBundle(services, invalid)).rejects.toThrow(/current protocol revision/i);

    expect(db.listProjects().some((candidate) => candidate.title === "Invalid semantic import")).toBe(false);
    expect(await readdir(join(dir, "projects"), { recursive: true })).toEqual(beforeEntries);
  });

  it("compensates project rows and imported files when a late review import fails", async () => {
    const project = db.createProject("Late failure source");
    db.createReview({ projectId: project.id, researchQuestion: "Can a late failure be recovered?" });
    await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Late failure artifact",
      content: "recoverable content"
    });
    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    const beforeFiles = (await readdir(join(dir, "projects"), { recursive: true })).filter((path) =>
      path.endsWith(".md")
    );
    vi.spyOn(db, "importReviewPortabilityState").mockImplementationOnce(() => {
      throw new Error("simulated late review failure");
    });

    await expect(
      importProjectBundle(services, {
        ...bundle,
        project: { ...bundle.project, title: "Recovered failed import" }
      })
    ).rejects.toThrow("simulated late review failure");

    expect(db.listProjects().some((candidate) => candidate.title === "Recovered failed import")).toBe(false);
    expect((await readdir(join(dir, "projects"), { recursive: true })).filter((path) => path.endsWith(".md"))).toEqual(
      beforeFiles
    );
  });

  it("exports and remaps a complete version 3 evidence review without losing its audit graph", async () => {
    const project = db.createProject("Portable evidence review");
    const paper = db.savePaper(project.id, {
      id: "original_review_paper",
      title: "Portable randomized trial",
      abstract: "The trial reports a measured recovery benefit.",
      authors: ["Review Author"],
      year: 2025,
      doi: "10.1000/portable-review",
      source: "pubmed",
      isOpenAccess: true,
      fieldsOfStudy: ["Medicine"]
    });
    const source = await artifacts.writeArtifact({
      projectId: project.id,
      type: "markdown",
      title: "Portable full text",
      content: "Methods\n\nThe trial randomized 120 participants.\n\nResults\n\nRecovery improved by 20 percent.",
      metadata: { paperId: paper.id }
    });
    const chunk = db
      .listArtifactChunks(project.id, source.id, 100)
      .find((item) => item.text.includes("randomized 120 participants"))!;

    const review = db.createReview({
      projectId: project.id,
      template: "general-empirical",
      researchQuestion: "Do interventions improve recovery?",
      objectives: ["Measure recovery"],
      criteria: [
        {
          id: "criterion_original_abstract",
          stage: "title-abstract",
          type: "inclusion",
          label: "Reports recovery outcomes",
          order: 0
        },
        {
          id: "criterion_original_fulltext",
          stage: "full-text",
          type: "exclusion",
          label: "Wrong population",
          order: 0
        }
      ]
    });
    const revisionOne = db.getReviewProtocolRevision(review.id)!;
    const initialFullTextCriterion = revisionOne.criteria.find((criterion) => criterion.stage === "full-text")!;
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "title-abstract",
      decision: "include",
      protocolRevisionId: revisionOne.id
    });
    db.setScreeningDecision({
      reviewId: review.id,
      paperId: paper.id,
      stage: "full-text",
      decision: "include",
      protocolRevisionId: revisionOne.id
    });
    const field = db.saveExtractionField({
      id: "field_original",
      reviewId: review.id,
      name: "Primary outcome",
      type: "short-text",
      order: 0
    });
    const runTimestamp = "2026-08-20T10:00:00.000Z";
    db.saveReviewRun({
      id: "review_run_original",
      reviewId: review.id,
      stage: "extraction",
      provider: "ollama",
      model: "portable-model",
      protocolRevisionId: revisionOne.id,
      status: "completed",
      paperIds: [paper.id],
      fieldIds: [field.id],
      completedCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: runTimestamp,
      updatedAt: runTimestamp,
      startedAt: runTimestamp,
      completedAt: runTimestamp
    });
    db.saveReviewRunItem({
      id: "review_item_original",
      runId: "review_run_original",
      paperId: paper.id,
      status: "completed",
      attemptCount: 1,
      rationale: "The full text reports a quantified recovery outcome.",
      criterionAssessments: [
        {
          criterionId: initialFullTextCriterion.id,
          assessment: "not-met",
          explanation: "The population exclusion criterion was not met.",
          evidenceIds: ["S1"]
        }
      ],
      extractionSuggestions: [
        {
          fieldId: field.id,
          value: "Recovery improved by 20 percent",
          status: "suggested",
          evidenceIds: ["S1"]
        }
      ],
      evidence: [
        {
          id: "review_evidence_original",
          reviewId: review.id,
          evidenceId: "S1",
          runId: "review_run_original",
          runItemId: "review_item_original",
          paperId: paper.id,
          artifactId: source.id,
          chunkId: chunk.chunkId,
          sourceType: "artifact-chunk",
          title: source.title,
          excerpt: chunk.text,
          locator: "Methods",
          retrievalScore: 1,
          createdAt: runTimestamp
        }
      ],
      createdAt: runTimestamp,
      updatedAt: runTimestamp,
      startedAt: runTimestamp,
      completedAt: runTimestamp
    });
    db.saveExtractionValue({
      id: "extraction_value_original",
      reviewId: review.id,
      paperId: paper.id,
      fieldId: field.id,
      value: "Recovery improved by 20 percent",
      status: "confirmed",
      origin: "ai",
      evidenceIds: ["review_evidence_original"],
      runItemId: "review_item_original",
      createdAt: runTimestamp,
      updatedAt: runTimestamp,
      confirmedAt: runTimestamp
    });
    db.appendReviewAuditEvent({
      reviewId: review.id,
      kind: "run-completed",
      actor: "system",
      entityType: "review-evidence",
      entityId: "review_evidence_original",
      payload: { evidenceId: "review_evidence_original", paperId: paper.id }
    });
    const revisedField = db.saveExtractionField({
      id: field.id,
      reviewId: review.id,
      name: "Primary recovery outcome",
      type: "short-text",
      order: 0
    });
    expect(revisedField.revision).toBe(2);
    const revisionTwo = db.reviseReviewProtocol({
      reviewId: review.id,
      researchQuestion: "Which interventions improve recovery?",
      objectives: ["Measure recovery", "Record study design"],
      criteria: [
        {
          id: "criterion_original_abstract_v2",
          stage: "title-abstract",
          type: "inclusion",
          label: "Reports recovery outcomes",
          order: 0
        },
        {
          id: "criterion_original_fulltext_v2",
          stage: "full-text",
          type: "exclusion",
          label: "Wrong population",
          order: 0
        }
      ],
      changeNote: "Clarified the research question"
    });
    db.markScreeningForRereview({
      reviewId: review.id,
      paperIds: [paper.id],
      stage: "full-text"
    });
    const importBatch = db.saveDiscoveryBatch({
      id: "batch_original_import",
      reviewId: review.id,
      kind: "reference-import",
      label: "Imported RIS records",
      fileName: "portable.ris",
      importFormat: "ris",
      status: "completed",
      counts: { identified: 2, duplicates: 1, newRecords: 1 },
      historicalCountsAvailable: true,
      config: { parser: "ris", sourceFileHash: "portable-hash" },
      createdAt: "2026-08-20T11:00:00.000Z",
      completedAt: "2026-08-20T11:00:01.000Z"
    });
    db.recordReviewCandidateOrigin({
      id: "origin_original_import",
      reviewId: review.id,
      batchId: importBatch.id,
      paperId: paper.id,
      matchedPaperId: paper.id,
      sourceRecordId: "RIS-42",
      resolution: "duplicate",
      paperSnapshot: paper,
      recordSnapshot: { title: paper.title, paperId: paper.id },
      createdAt: "2026-08-20T11:00:00.500Z"
    });

    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    expect(bundle.version).toBe(3);
    expect(bundle.review).toBeDefined();
    expect(bundle.review?.review.currentRevisionId).toBe(revisionTwo.id);
    expect(bundle.review?.revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(bundle.review?.runItems[0]).toMatchObject({
      id: "review_item_original",
      stale: true,
      evidenceIds: ["review_evidence_original"]
    });
    expect(bundle.review?.discoveryBatches.find((batch) => batch.id === importBatch.id)?.config).toEqual({
      parser: "ris",
      sourceFileHash: "portable-hash"
    });

    const untrustedBundle = structuredClone(bundle);
    untrustedBundle.project.title = "Untrusted review evidence import";
    untrustedBundle.artifacts.find((artifact) => artifact.id === source.id)!.type = "brief";
    await expect(importProjectBundle(services, untrustedBundle)).rejects.toThrow(/untrusted or mismatched artifact/i);
    expect(db.listProjects().some((candidate) => candidate.title === untrustedBundle.project.title)).toBe(false);

    const missingChunkBundle = structuredClone(bundle);
    missingChunkBundle.project.title = "Missing review chunk import";
    missingChunkBundle.review!.evidence[0].chunkId = "missing-source-chunk";
    missingChunkBundle.review!.evidence[0].excerpt = "Text that does not occur in the imported artifact.";
    missingChunkBundle.review!.evidence[0].page = 7;
    const filesBeforeMissingChunk = (await readdir(join(dir, "projects"), { recursive: true }))
      .filter((path) => path.endsWith(".md"))
      .sort();
    const writeArtifact = artifacts.writeArtifact.bind(artifacts);
    vi.spyOn(artifacts, "writeArtifact").mockImplementationOnce(async (input) => {
      const imported = await writeArtifact(input);
      const paperId = typeof input.metadata?.paperId === "string" ? input.metadata.paperId : undefined;
      db.addDocumentChunks({
        projectId: input.projectId,
        artifactId: imported.id,
        paperId,
        chunks: [{ text: "Unrelated text on the same claimed page.", metadata: { page: 7 } }]
      });
      return imported;
    });
    await expect(importProjectBundle(services, missingChunkBundle)).rejects.toThrow(/trusted paper chunk/i);
    expect(db.listProjects().some((candidate) => candidate.title === missingChunkBundle.project.title)).toBe(false);
    expect(
      (await readdir(join(dir, "projects"), { recursive: true })).filter((path) => path.endsWith(".md")).sort()
    ).toEqual(filesBeforeMissingChunk);

    const snapshotOnlyBundle = structuredClone(bundle);
    snapshotOnlyBundle.project.title = "Snapshot-only review evidence import";
    snapshotOnlyBundle.artifacts = snapshotOnlyBundle.artifacts.filter((artifact) => artifact.id !== source.id);
    snapshotOnlyBundle.review!.evidence[0].artifactId = undefined;
    snapshotOnlyBundle.review!.evidence[0].chunkId = undefined;
    const snapshotOnlyProject = await importProjectBundle(services, snapshotOnlyBundle);
    const snapshotOnlyReview = db.getReview(snapshotOnlyProject.id)!;
    expect(db.exportReviewPortabilityState(snapshotOnlyReview.id).evidence[0]).toMatchObject({
      artifactId: undefined,
      chunkId: undefined,
      excerpt: chunk.text
    });

    const duplicate = await importProjectBundle(services, {
      ...bundle,
      project: { ...bundle.project, title: "Portable evidence review copy" },
      review: {
        ...bundle.review!,
        candidateOrigins: [
          ...bundle.review!.candidateOrigins,
          {
            ...bundle.review!.candidateOrigins[0],
            id: "origin-with-deleted-match",
            sourceRecordId: "RIS-deleted-match",
            matchedPaperId: "deleted-matched-paper",
            recordSnapshot: { title: "Ambiguous source record" }
          }
        ]
      }
    });
    const duplicateReview = db.getReview(duplicate.id)!;
    const importedState = db.exportReviewPortabilityState(duplicateReview.id);
    const duplicatePaper = db.listPapers(duplicate.id)[0];
    const duplicateSource = db.listArtifacts(duplicate.id).find((artifact) => artifact.title === source.title)!;
    const importedOrigin = importedState.candidateOrigins.find((origin) => origin.sourceRecordId === "RIS-42")!;
    const importedEvidence = importedState.evidence[0];
    const importedField = importedState.extractionFields[0];
    const importedValue = importedState.extractionValues[0];
    const importedRun = importedState.runs[0];
    const importedItem = importedState.runItems[0];

    expect(duplicateReview.id).not.toBe(review.id);
    expect(duplicateReview.projectId).toBe(duplicate.id);
    expect(duplicateReview.currentRevisionId).not.toBe(revisionTwo.id);
    expect(importedState.revisions.map((revision) => revision.version)).toEqual([2, 1]);
    expect(
      importedState.revisions.flatMap((revision) => revision.criteria).map((criterion) => criterion.id)
    ).not.toContain("criterion_original_abstract");
    expect(importedOrigin).toMatchObject({
      paperId: duplicatePaper.id,
      matchedPaperId: duplicatePaper.id,
      paperSnapshot: { id: duplicatePaper.id, projectId: duplicate.id }
    });
    expect(importedOrigin.recordSnapshot).toMatchObject({ paperId: duplicatePaper.id });
    expect(
      importedState.candidateOrigins.find((origin) => origin.sourceRecordId === "RIS-deleted-match")?.recordSnapshot
    ).toMatchObject({ unavailableMatchedPaperId: "deleted-matched-paper" });
    expect(importedState.screeningDecisions).toHaveLength(2);
    expect(importedState.screeningDecisions.every((decision) => decision.paperId === duplicatePaper.id)).toBe(true);
    expect(importedState.rereviewFlags).toHaveLength(1);
    expect(importedState.rereviewFlags[0]).toMatchObject({
      paperId: duplicatePaper.id,
      stage: "full-text"
    });
    expect(importedField).toMatchObject({ name: "Primary recovery outcome", revision: 2 });
    expect(importedField.id).not.toBe(field.id);
    expect(importedState.extractionFieldHistory).not.toHaveLength(0);
    expect(importedState.extractionFieldHistory?.every((entry) => entry.id === importedField.id)).toBe(true);
    expect(importedValue).toMatchObject({
      paperId: duplicatePaper.id,
      fieldId: importedField.id,
      fieldRevision: 2,
      status: "needs-review",
      origin: "ai",
      runItemId: importedItem.id,
      evidenceIds: [importedEvidence.id]
    });
    expect(importedState.extractionValueHistory).not.toHaveLength(0);
    expect(importedState.extractionValueHistory?.every((entry) => entry.id === importedValue.id)).toBe(true);
    expect(importedState.extractionValueHistory?.every((entry) => entry.paperId === duplicatePaper.id)).toBe(true);
    expect(importedRun).toMatchObject({
      status: "completed",
      paperIds: [duplicatePaper.id],
      fieldIds: [importedField.id],
      protocolRevisionId: expect.not.stringMatching(revisionOne.id)
    });
    expect(importedRun.id).not.toBe("review_run_original");
    expect(importedItem).toMatchObject({
      runId: importedRun.id,
      paperId: duplicatePaper.id,
      stale: true,
      evidenceIds: [importedEvidence.id],
      paperSnapshot: { id: duplicatePaper.id, projectId: duplicate.id }
    });
    expect(importedItem.extractionSuggestions[0]?.fieldId).toBe(importedField.id);
    expect(importedItem.criterionAssessments[0]?.criterionId).not.toBe(initialFullTextCriterion.id);
    expect(
      importedState.revisions
        .flatMap((revision) => revision.criteria)
        .some((criterion) =>
          importedItem.criterionAssessments.some((assessment) => assessment.criterionId === criterion.id)
        )
    ).toBe(true);
    expect(importedEvidence).toMatchObject({
      paperId: duplicatePaper.id,
      paperSnapshot: { id: duplicatePaper.id, projectId: duplicate.id },
      artifactId: duplicateSource.id,
      runId: importedRun.id,
      runItemId: importedItem.id
    });
    expect(importedEvidence.id).not.toBe("review_evidence_original");
    expect(importedEvidence.chunkId).toBeTruthy();
    expect(importedEvidence.chunkId).not.toBe(chunk.chunkId);
    expect(importedState.auditEvents.map((event) => event.kind)).toEqual(
      bundle.review?.auditEvents.map((event) => event.kind)
    );
    expect(importedState.auditEvents).toHaveLength(bundle.review!.auditEvents.length);
    expect(
      importedState.auditEvents.find((event) => event.kind === "decision-marked-for-review")?.payload.paperIds
    ).toEqual([duplicatePaper.id]);
    expect(importedState.auditEvents.find((event) => event.entityType === "review-evidence")).toMatchObject({
      entityId: importedEvidence.id,
      payload: { evidenceId: importedEvidence.id, paperId: duplicatePaper.id }
    });
  });

  it("preserves failed, partial, and cancelled review runs as terminal audit records", async () => {
    const project = db.createProject("Terminal run review");
    const paper = db.savePaper(project.id, {
      id: "terminal-run-paper",
      title: "Terminal run paper",
      authors: [],
      source: "reference-import",
      isOpenAccess: false,
      fieldsOfStudy: []
    });
    const review = db.createReview({ projectId: project.id, researchQuestion: "What completed?" });
    const revision = db.getReviewProtocolRevision(review.id)!;
    for (const [index, status] of (["failed", "partial", "cancelled"] as const).entries()) {
      db.saveReviewRun({
        id: `terminal-run-${status}`,
        reviewId: review.id,
        stage: "title-abstract",
        provider: "ollama",
        model: "audit-model",
        protocolRevisionId: revision.id,
        status,
        paperIds: [paper.id],
        fieldIds: [],
        completedCount: status === "partial" ? 1 : 0,
        failedCount: status === "failed" ? 1 : 0,
        cancelledCount: status === "cancelled" ? 1 : 0,
        error: status === "failed" ? "provider unavailable" : undefined,
        createdAt: `2026-08-2${index}T00:00:00.000Z`,
        updatedAt: `2026-08-2${index}T00:01:00.000Z`,
        completedAt: `2026-08-2${index}T00:01:00.000Z`
      });
    }
    const services = { db, artifacts } as IpcServices;
    const bundle = await buildProjectExportBundle(services, project.id);
    expect(bundle.review?.runs.map((run) => run.status).sort()).toEqual(["cancelled", "failed", "partial"]);

    const imported = await importProjectBundle(services, bundle);
    const importedReview = db.getReview(imported.id)!;
    expect(
      db
        .listReviewRuns(importedReview.id)
        .map((run) => run.status)
        .sort()
    ).toEqual(["cancelled", "failed", "partial"]);
  });

  it.each([1, 2] as const)("continues importing legacy version %i bundles", async (version) => {
    const project = db.createProject(`Legacy version ${version}`);
    const services = { db, artifacts } as IpcServices;
    const current = await buildProjectExportBundle(services, project.id);
    const legacy = {
      ...current,
      version,
      review: undefined,
      ...(version === 1 ? { conversations: undefined, runs: undefined, citations: undefined } : {})
    };

    const imported = await importProjectBundle(services, legacy);
    expect(imported.title).toBe(project.title);
    expect(db.getReview(imported.id)).toBeUndefined();
  });
});
