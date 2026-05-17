import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Gauge, History, Loader2, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import type { JSX } from "react";
import { useState } from "react";
import type { Job } from "../../shared/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowHistory((current) => !current)}
          >
            <History size={13} />
            {showHistory ? "Active" : "History"}
          </Button>
        ) : null}
        {showHistory ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => clearTerminalJobs.mutate()}
            disabled={clearTerminalJobs.isPending}
          >
            <Trash2 size={13} />
            Clear done
          </Button>
        ) : null}
      </div>
      {visibleJobs.map((job) => (
        <motion.div
          key={job.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "tween", duration: 0.16 }}
        >
          <Card className="rounded-lg border-border bg-card p-3 py-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                {job.status === "running" ? <Loader2 size={15} className="animate-spin text-primary" /> : <Gauge size={15} />}
                <span className="truncate">{job.title}</span>
              </div>
              <Badge variant="outline" className="shrink-0">
                {job.status}
              </Badge>
            </div>
            <Progress value={Math.max(6, job.progress * 100)} />
            {job.detail ? <div className="mt-2 text-xs text-muted-foreground">{job.detail}</div> : null}
            {job.status === "waiting-approval" ? (
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  onClick={() => approveJob.mutate(job.id)}
                  disabled={approveJob.isPending || denyJob.isPending}
                  className="flex-1"
                  size="sm"
                >
                  <Play size={13} />
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => denyJob.mutate(job.id)}
                  disabled={approveJob.isPending || denyJob.isPending}
                  className="flex-1"
                  size="sm"
                >
                  Deny
                </Button>
              </div>
            ) : null}
            {job.status === "running" || job.status === "queued" ? (
              <div className="mt-3">
                <Button type="button" variant="destructive" onClick={() => cancelJob.mutate(job.id)} disabled={cancelJob.isPending} className="w-full" size="sm">
                  <XCircle size={13} />
                  Cancel
                </Button>
              </div>
            ) : null}
            {job.status === "failed" || job.status === "cancelled" ? (
              <div className="mt-3">
                <Button type="button" variant="outline" onClick={() => retryJob.mutate(job.id)} disabled={retryJob.isPending} className="w-full" size="sm">
                  <RotateCcw size={13} />
                  Retry
                </Button>
              </div>
            ) : null}
            {job.error ? <div className="mt-2 line-clamp-3 text-xs text-destructive">{job.error}</div> : null}
          </Card>
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
