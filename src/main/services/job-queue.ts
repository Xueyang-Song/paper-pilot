import { EventEmitter } from "node:events";
import type { Job } from "../../shared/schemas.js";
import { jobSchema } from "../../shared/schemas.js";
import type { PaperPilotDb } from "../db.js";
import { id, nowIso } from "../utils.js";

export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();

  constructor(private readonly db?: PaperPilotDb) {
    super();
    if (!db) return;
    db.markInterruptedJobs();
    for (const job of db.listJobs()) {
      this.jobs.set(job.id, job);
    }
  }

  create(input: Pick<Job, "projectId" | "kind" | "title"> & Partial<Pick<Job, "detail" | "status" | "result">>): Job {
    const timestamp = nowIso();
    const job = jobSchema.parse({
      id: id("job"),
      projectId: input.projectId,
      kind: input.kind,
      title: input.title,
      status: input.status ?? "queued",
      progress: 0,
      detail: input.detail,
      result: input.result,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.jobs.set(job.id, job);
    this.db?.saveJob(job);
    this.emit("changed", job);
    return job;
  }

  createWithResult(
    input: Pick<Job, "projectId" | "kind" | "title"> & Partial<Pick<Job, "detail" | "status" | "result">>
  ): Job {
    const job = this.create(input);
    if (input.result) {
      return this.update(job.id, { result: input.result });
    }
    return job;
  }

  update(jobId: string, patch: Partial<Omit<Job, "id" | "createdAt">>): Job {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);
    const next = jobSchema.parse({ ...current, ...patch, updatedAt: nowIso() });
    this.jobs.set(jobId, next);
    this.db?.saveJob(next);
    this.emit("changed", next);
    return next;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  list(projectId?: string): Job[] {
    return Array.from(this.jobs.values())
      .filter((job) => !projectId || job.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  cancel(jobId: string): Job {
    const current = this.get(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    return this.update(jobId, {
      status: "cancelled",
      progress: 1,
      detail: current.status === "running" ? "Cancellation requested by user." : "Cancelled by user.",
      error:
        current.status === "running"
          ? "The running operation may finish in the background if the underlying tool cannot be interrupted."
          : undefined
    });
  }

  retry(jobId: string): Job {
    const current = this.get(jobId);
    if (!current) throw new Error(`Job not found: ${jobId}`);
    const approval = current.result?.approval as { action?: string } | undefined;
    if (approval?.action) {
      return this.update(jobId, {
        status: "waiting-approval",
        progress: 0,
        detail: "Retry is waiting for approval.",
        error: undefined
      });
    }
    throw new Error("This job does not contain enough saved run details to retry automatically.");
  }

  clearTerminal(projectId?: string): number {
    const removed = this.list(projectId).filter((job) => ["completed", "failed", "cancelled"].includes(job.status));
    for (const job of removed) {
      this.jobs.delete(job.id);
      this.db?.deleteJob(job.id);
    }
    return removed.length;
  }

  onChanged(listener: (job: Job) => void): () => void {
    this.on("changed", listener);
    return () => this.off("changed", listener);
  }
}
