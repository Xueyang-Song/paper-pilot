import type { ProjectPolicy } from "../../shared/schemas.js";

export type PolicyAction = "source-crawl" | "browser-install" | "browser-crawl" | "python-script" | "paid-model-run" | "long-job";

export function requiresApproval(policy: ProjectPolicy, action: PolicyAction): boolean {
  if (policy.autonomy === "yolo") return false;
  if (action === "source-crawl") return !policy.autoApproveSources;
  if (action === "python-script") return !policy.autoApproveScripts;
  if (action === "browser-install" || action === "browser-crawl") return !policy.autoApproveBrowserInstall;
  if (action === "paid-model-run") return policy.warnOnPaidModelRuns;
  if (action === "long-job") return policy.autonomy !== "project";
  return true;
}

export function yoloWarning(): string {
  return [
    "YOLO mode lets the agent run external crawls and local scripts without asking each time.",
    "Only enable it for sources and scripts you trust, and expect network, disk, dependency, and API-cost side effects."
  ].join(" ");
}
