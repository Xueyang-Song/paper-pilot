import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaperPilotDb } from "../src/main/db";
import { JobQueue } from "../src/main/services/job-queue";
import type { Job } from "../src/shared/schemas";

let dir: string;
let dbPath: string;
let db: PaperPilotDb;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-pilot-jobs-"));
  dbPath = join(dir, "jobs.db");
  db = new PaperPilotDb(dbPath);
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("JobQueue persistence", () => {
  it("creates, updates, and reloads persisted jobs", () => {
    const project = db.createProject("Persistent jobs");
    const jobs = new JobQueue(db);
    const created = jobs.create({ projectId: project.id, kind: "brief", status: "running", title: "Generate brief" });
    const completed = jobs.update(created.id, {
      status: "completed",
      progress: 1,
      detail: "Brief completed.",
      result: { artifactId: "art_brief" }
    });

    db.close();
    db = new PaperPilotDb(dbPath);
    const reloadedJobs = new JobQueue(db);

    expect(reloadedJobs.get(created.id)).toEqual(completed);
    expect(reloadedJobs.list(project.id)).toEqual([completed]);
  });

  it("keeps waiting approvals intact across restarts", () => {
    const project = db.createProject("Approval jobs");
    const jobs = new JobQueue(db);
    const crawl = jobs.create({
      projectId: project.id,
      kind: "crawl",
      status: "waiting-approval",
      title: "Approve crawl",
      result: { approval: { action: "crawl", config: { topic: "protein folding" } } }
    });
    const python = jobs.create({
      projectId: project.id,
      kind: "python",
      status: "waiting-approval",
      title: "Approve script",
      result: { approval: { action: "python-script", name: "extract", code: "print('ok')", args: [] } }
    });
    const browser = jobs.create({
      projectId: project.id,
      kind: "python",
      status: "waiting-approval",
      title: "Approve Chromium install",
      result: { approval: { action: "browser-install" } }
    });

    db.close();
    db = new PaperPilotDb(dbPath);
    const reloadedJobs = new JobQueue(db);

    expect(reloadedJobs.get(crawl.id)?.result?.approval).toEqual(crawl.result?.approval);
    expect(reloadedJobs.get(python.id)?.result?.approval).toEqual(python.result?.approval);
    expect(reloadedJobs.get(browser.id)?.result?.approval).toEqual(browser.result?.approval);
    expect(reloadedJobs.list(project.id).map((job) => job.status)).toEqual([
      "waiting-approval",
      "waiting-approval",
      "waiting-approval"
    ]);
  });

  it("marks queued and running jobs interrupted after restart", () => {
    const project = db.createProject("Interrupted jobs");
    const jobs = new JobQueue(db);
    const queued = jobs.create({ projectId: project.id, kind: "agent", status: "queued", title: "Queued agent task" });
    const running = jobs.create({ projectId: project.id, kind: "crawl", status: "running", title: "Running crawl", detail: "Running Crossref" });
    const waiting = jobs.create({
      projectId: project.id,
      kind: "crawl",
      status: "waiting-approval",
      title: "Waiting crawl",
      result: { approval: { action: "crawl", config: { topic: "materials" } } }
    });

    db.close();
    db = new PaperPilotDb(dbPath);
    const reloadedJobs = new JobQueue(db);

    expect(reloadedJobs.get(queued.id)).toMatchObject({
      status: "failed",
      progress: 1,
      error: "Interrupted by app restart."
    });
    expect(reloadedJobs.get(running.id)).toMatchObject({
      status: "failed",
      progress: 1,
      error: "Interrupted by app restart."
    });
    expect(reloadedJobs.get(running.id)?.detail).toContain("Interrupted because Paper Pilot restarted");
    expect(reloadedJobs.get(waiting.id)?.status).toBe("waiting-approval");
  });

  it("lists project jobs newest first", async () => {
    const firstProject = db.createProject("Newest first");
    const secondProject = db.createProject("Other project");
    const jobs = new JobQueue(db);
    const older = jobs.create({ projectId: firstProject.id, kind: "brief", title: "Older" });
    jobs.create({ projectId: secondProject.id, kind: "brief", title: "Other project" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = jobs.create({ projectId: firstProject.id, kind: "crawl", title: "Newer" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newest = jobs.update(older.id, { detail: "Touched later" });

    expect(jobs.list(firstProject.id).map((job) => job.id)).toEqual([newest.id, newer.id]);
  });

  it("persists denial-style updates and emits the updated job shape", () => {
    const project = db.createProject("Deny persisted approval");
    const jobs = new JobQueue(db);
    const pending = jobs.create({
      projectId: project.id,
      kind: "crawl",
      status: "waiting-approval",
      title: "Approve crawl",
      result: { approval: { action: "crawl", config: { topic: "biology" } } }
    });
    let emitted: Job | undefined;
    jobs.onChanged((job) => {
      emitted = job;
    });

    const denied = jobs.update(pending.id, {
      status: "cancelled",
      progress: 1,
      detail: "Denied by user.",
      result: { ...(pending.result ?? {}), approval: undefined }
    });

    expect(emitted).toEqual(denied);

    db.close();
    db = new PaperPilotDb(dbPath);
    const reloadedJobs = new JobQueue(db);

    expect(reloadedJobs.get(pending.id)).toMatchObject({
      status: "cancelled",
      progress: 1,
      detail: "Denied by user."
    });
    expect(reloadedJobs.get(pending.id)?.result).toEqual({});
  });
});
