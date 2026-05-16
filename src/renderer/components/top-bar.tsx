import type { JSX } from "react";
import { Brain, Database, Search, Settings } from "lucide-react";
import type { AiProviderHealth, Project } from "../../shared/schemas";
import { IconButton, StatusPill } from "./ui";

export function TopBar(props: {
  project?: Project;
  paperCount: number;
  artifactCount: number;
  aiHealth?: AiProviderHealth;
  onOpenSearch(): void;
  onOpenSettings(): void;
}): JSX.Element {
  const aiLabel = props.aiHealth
    ? `${providerLabel(props.aiHealth.provider)} ${props.aiHealth.reachable ? "ready" : props.aiHealth.status}`
    : "AI provider";
  return (
    <header className="flex h-16 items-center justify-between border-b border-stone-200 bg-[#fbfaf6]/95 px-5">
      <div className="min-w-0">
        <div className="truncate text-base font-semibold">{props.project?.title ?? "New research workspace"}</div>
        <div className="mt-0.5 flex gap-4 text-xs text-stone-600">
          <span>{props.paperCount} papers</span>
          <span>{props.artifactCount} artifacts</span>
          <span>{props.project?.policy.autonomy ?? "project"} autonomy</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusPill icon={<Database size={14} />} label="SQLite" />
        <StatusPill icon={<Brain size={14} />} label={aiLabel} />
        <IconButton label="Search" onClick={props.onOpenSearch}>
          <Search size={18} />
        </IconButton>
        <IconButton label="Settings" onClick={props.onOpenSettings}>
          <Settings size={18} />
        </IconButton>
      </div>
    </header>
  );
}

function providerLabel(provider: AiProviderHealth["provider"]): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "vercel") return "Vercel";
  return "OpenAI-compatible";
}
