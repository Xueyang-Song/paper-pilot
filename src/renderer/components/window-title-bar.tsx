import type { JSX, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { Brain, FlaskConical, Search, Settings } from "lucide-react";
import type { AiProviderHealth, Project } from "../../shared/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Platform = "darwin" | "win32" | "linux" | string;

export function WindowTitleBar({
  project,
  paperCount,
  artifactCount,
  aiHealth,
  onOpenSearch,
  onOpenSettings
}: {
  project?: Project;
  paperCount: number;
  artifactCount: number;
  aiHealth?: AiProviderHealth;
  onOpenSearch(): void;
  onOpenSettings(): void;
}): JSX.Element {
  const [platform, setPlatform] = useState<Platform>("win32");
  const hasNativeCaptionOverlay = platform !== "darwin";
  const aiLabel = aiHealth ? aiStatusLabel(aiHealth) : "AI provider";
  const aiTitle = aiHealth
    ? [
        `Provider: ${providerLabel(aiHealth.provider)}`,
        `Model: ${aiHealth.model}`,
        `Key: ${aiHealth.hasApiKey ? "stored" : "not stored"}`,
        `Reachability: ${aiHealth.reachable ? "reachable" : "not reachable"}`,
        aiHealth.detail ? `Last status: ${aiHealth.detail}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    : "AI provider status has not been checked yet.";

  useEffect(() => {
    void window.paperPilot
      .platform()
      .then(setPlatform)
      .catch(() => setPlatform("win32"));
  }, []);

  function toggleMaximizeFromDrag(event: MouseEvent<HTMLElement>): void {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(".window-no-drag, button, input, textarea, select, a, [role='button']")
    )
      return;
    void window.paperPilot.toggleMaximizeWindow();
  }

  return (
    <header
      onDoubleClick={toggleMaximizeFromDrag}
      className={cn(
        "window-drag relative z-20 flex h-[var(--app-titlebar-height)] shrink-0 select-none items-center gap-3 bg-[var(--app-titlebar)] px-2 text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:bottom-[-1px] after:z-10 after:h-px after:bg-border/80",
        platform === "darwin" && "pl-[76px]",
        hasNativeCaptionOverlay && "pr-[144px]"
      )}
    >
      <div className="flex min-w-0 shrink-0 items-center gap-2 px-1">
        <div className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
          <FlaskConical size={15} />
        </div>
        <div className="hidden truncate text-sm font-semibold sm:block">Paper Pilot</div>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
        <div className="truncate text-center text-sm font-medium">{project?.title ?? "New research workspace"}</div>
        <div className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground lg:flex">
          <span>{paperCount} papers</span>
          <span className="text-border">/</span>
          <span>{artifactCount} artifacts</span>
          <span className="text-border">/</span>
          <span>{project?.policy.autonomy ?? "project"} autonomy</span>
        </div>
      </div>

      <div className="window-no-drag flex shrink-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant={aiHealth?.status === "ok" ? "secondary" : "outline"}
              className="hidden h-7 max-w-56 gap-1.5 rounded-lg px-2 text-muted-foreground lg:inline-flex"
              title={aiTitle}
            >
              <Brain size={12} />
              <span className="truncate">{aiLabel}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80 whitespace-pre-line">{aiTitle}</TooltipContent>
        </Tooltip>
        <TitleButton label="Search" onClick={onOpenSearch}>
          <Search />
        </TitleButton>
        <TitleButton label="Settings" onClick={onOpenSettings} openOnPointerDown>
          <Settings />
        </TitleButton>
      </div>
    </header>
  );
}

function TitleButton({
  label,
  onClick,
  openOnPointerDown,
  children
}: {
  label: string;
  onClick(): void;
  openOnPointerDown?: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onPointerDown={openOnPointerDown ? onClick : undefined}
          onClick={onClick}
          className="window-no-drag"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function aiStatusLabel(health: AiProviderHealth): string {
  const status = health.status === "ok" ? "ready" : health.status;
  const keyLabel = health.provider === "ollama" ? "local" : health.hasApiKey ? "key" : "no key";
  return `${providerLabel(health.provider)} ${status} / ${health.model} / ${keyLabel}`;
}

function providerLabel(provider: AiProviderHealth["provider"]): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "vercel") return "Vercel";
  return "OpenAI-compatible";
}
