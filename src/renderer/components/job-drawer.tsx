import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Gauge, History, Loader2, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Job } from "../../shared/schemas";

export function JobDrawer({ projectId, initialJobs }: { projectId?: string; initialJobs: Job[] }): JSX.Element {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const jobsQuery = useQuery({
    queryKey: ["jobs", projectId],
    queryFn: () => window.paperPilot.listJobs(projectId),
    enabled: Boolean(projectId),
    initialData: initialJobs
  });
  const approveJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.approveJob(jobId),
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
      }
    }
  });
  const denyJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.denyJob(jobId),
    onSuccess: () => {
      if (projectId) {
        void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] });
        void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
      }
    }
  });
  const cancelJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.cancelJob(jobId),
    onSuccess: () => refreshJobs(projectId, queryClient)
  });
  const retryJob = useMutation({
    mutationFn: (jobId: string) => window.paperPilot.retryJob(jobId),
    onSuccess: () => refreshJobs(projectId, queryClient)
  });
  const clearTerminalJobs = useMutation({
    mutationFn: () => window.paperPilot.clearTerminalJobs(projectId),
    onSuccess: () => refreshJobs(projectId, queryClient)
  });
  const jobs = jobsQuery.data ?? [];
  const active = jobs.filter((job) => job.status === "running" || job.status === "waiting-approval");
  const visibleJobs = showHistory ? jobs.slice(0, 8) : active.slice(0, 3);
  if (!active.length && !jobs.length) return <div className="pointer-events-none absolute bottom-3 right-[360px]" />;
  return (
    <div className="absolute bottom-4 right-[360px] z-20 w-80 space-y-2">
      <div className="flex justify-end gap-2">
        {jobs.length ? (
          <button
            type="button"
            onClick={() => setShowHistory((current) => !current)}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs font-medium text-stone-700 shadow-sm transition hover:border-[#175c62] hover:text-[#175c62]"
          >
            <History size={13} />
            {showHistory ? "Active" : "History"}
          </button>
        ) : null}
        {showHistory ? (
          <button
            type="button"
            onClick={() => clearTerminalJobs.mutate()}
            disabled={clearTerminalJobs.isPending}
            className="inline-flex h-8 items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs font-medium text-stone-700 shadow-sm transition hover:border-[#175c62] hover:text-[#175c62] disabled:opacity-50"
          >
            <Trash2 size={13} />
            Clear done
          </button>
        ) : null}
      </div>
      {visibleJobs.map((job) => (
        <motion.div
          key={job.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-md border border-stone-300 bg-white p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              {job.status === "running" ? <Loader2 size={15} className="animate-spin text-[#175c62]" /> : <Gauge size={15} />}
              <span className="truncate">{job.title}</span>
            </div>
            <span className="text-xs text-stone-500">{job.status}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-stone-200">
            <div className="h-full bg-[#175c62]" style={{ width: `${Math.max(6, job.progress * 100)}%` }} />
          </div>
          {job.detail ? <div className="mt-2 text-xs text-stone-600">{job.detail}</div> : null}
          {job.status === "waiting-approval" ? (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => approveJob.mutate(job.id)}
                disabled={approveJob.isPending || denyJob.isPending}
                className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded-md bg-[#175c62] px-3 text-xs font-medium text-white transition hover:bg-[#11494e] disabled:opacity-50"
              >
                <Play size={13} />
                Approve
              </button>
              <button
                type="button"
                onClick={() => denyJob.mutate(job.id)}
                disabled={approveJob.isPending || denyJob.isPending}
                className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
              >
                Deny
              </button>
            </div>
          ) : null}
          {job.status === "running" || job.status === "queued" ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => cancelJob.mutate(job.id)}
                disabled={cancelJob.isPending}
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-[#e9b4c1] px-3 text-xs font-medium text-[#7b2d43] transition hover:border-[#7b2d43] disabled:opacity-50"
              >
                <XCircle size={13} />
                Cancel
              </button>
            </div>
          ) : null}
          {job.status === "failed" || job.status === "cancelled" ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => retryJob.mutate(job.id)}
                disabled={retryJob.isPending}
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
              >
                <RotateCcw size={13} />
                Retry
              </button>
            </div>
          ) : null}
          {job.error ? <div className="mt-2 line-clamp-3 text-xs text-[#7b2d43]">{job.error}</div> : null}
        </motion.div>
      ))}
    </div>
  );
}

function refreshJobs(projectId: string | undefined, queryClient: ReturnType<typeof useQueryClient>): void {
  if (!projectId) return;
  void queryClient.invalidateQueries({ queryKey: ["jobs", projectId] });
  void queryClient.invalidateQueries({ queryKey: ["bundle", projectId] });
}
