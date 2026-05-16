import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Gauge, Loader2, Play } from "lucide-react";
import type { JSX } from "react";
import type { Job } from "../../shared/schemas";

export function JobDrawer({ projectId, initialJobs }: { projectId?: string; initialJobs: Job[] }): JSX.Element {
  const queryClient = useQueryClient();
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
  const jobs = jobsQuery.data ?? [];
  const active = jobs.filter((job) => job.status === "running" || job.status === "waiting-approval");
  if (!active.length) return <div className="pointer-events-none absolute bottom-3 right-[360px]" />;
  return (
    <div className="absolute bottom-4 right-[360px] z-20 w-80 space-y-2">
      {active.slice(0, 3).map((job) => (
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
        </motion.div>
      ))}
    </div>
  );
}
