import { EventEmitter } from "node:events";
import type { Job } from "../../shared/schemas.js";
import { id, nowIso } from "../utils.js";

export class JobQueue extends EventEmitter {
  private jobs = new Map<string, Job>();

  create(input: Pick<Job, "projectId" | "kind" | "title"> & Partial<Pick<Job, "detail" | "status" | "result">>): Job {
    const timestamp = nowIso();
    const job: Job = {
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
    };
    this.jobs.set(job.id, job);
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
    const next: Job = { ...current, ...patch, updatedAt: nowIso() };
    this.jobs.set(jobId, next);
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

  onChanged(listener: (job: Job) => void): () => void {
    this.on("changed", listener);
    return () => this.off("changed", listener);
  }
}
