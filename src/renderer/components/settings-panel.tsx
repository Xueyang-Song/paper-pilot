import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, CheckCircle2, Database, KeyRound, Loader2, Monitor, Moon, RefreshCw, Search, ShieldCheck, Sun, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AiProviderHealth, AppSettings, Project, SourceDefinition, SourceId } from "../../shared/schemas";
import { PanelSection, PolicyToggle } from "./ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

const providerDefaults: Record<AppSettings["ai"]["provider"], { baseUrl: string; model: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma3:12b-it-qat" },
  vercel: { baseUrl: "https://ai-gateway.vercel.sh/v1", model: "openai/gpt-5.4" },
  "openai-compatible": { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" }
};
type ThemePreference = AppSettings["ui"]["theme"];

export function SettingsPanel({
  open,
  sources,
  activeProject,
  aiHealth,
  themePreference,
  isThemeSaving,
  onThemeChange,
  onClose
}: {
  open: boolean;
  sources: SourceDefinition[];
  activeProject?: Project;
  aiHealth?: AiProviderHealth;
  themePreference: ThemePreference;
  isThemeSaving: boolean;
  onThemeChange(theme: ThemePreference): void;
  onClose(): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => window.paperPilot.getSettings() });
  const flagsQuery = useQuery({ queryKey: ["credentialFlags"], queryFn: () => window.paperPilot.listCredentialFlags() });
  const [selectedSource, setSelectedSource] = useState<SourceId | "ai-gateway">("ai-gateway");
  const [secret, setSecret] = useState("");
  const [provider, setProvider] = useState<AppSettings["ai"]["provider"]>("ollama");
  const [model, setModel] = useState(providerDefaults.ollama.model);
  const [baseUrl, setBaseUrl] = useState(providerDefaults.ollama.baseUrl);

  useEffect(() => {
    if (settingsQuery.data) {
      setProvider(settingsQuery.data.ai.provider);
      setModel(settingsQuery.data.ai.model);
      setBaseUrl(settingsQuery.data.ai.baseUrl);
    }
  }, [settingsQuery.data]);

  const saveCredential = useMutation({
    mutationFn: () => window.paperPilot.saveCredential({ sourceId: selectedSource, label: "default", secret }),
    onSuccess: () => {
      setSecret("");
      void queryClient.invalidateQueries({ queryKey: ["credentialFlags"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const removeCredential = useMutation({
    mutationFn: () => window.paperPilot.removeCredential({ sourceId: selectedSource, label: "default" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["credentialFlags"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    }
  });

  const testCredential = useMutation({
    mutationFn: () => window.paperPilot.testCredential({ sourceId: selectedSource, label: "default" })
  });

  const saveSettings = useMutation({
    mutationFn: () =>
      window.paperPilot.updateSettings({
        ai: {
          ...(settingsQuery.data?.ai as AppSettings["ai"]),
          provider,
          baseUrl,
          model
        }
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["ai-health"] });
    }
  });

  const checkProvider = useMutation({
    mutationFn: () => window.paperPilot.checkAiProvider({ provider, baseUrl, model }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["ai-health"] })
  });

  const updatePolicy = useMutation({
    mutationFn: (patch: Partial<Project["policy"]>) =>
      window.paperPilot.updateProjectPolicy({ projectId: activeProject?.id ?? "", patch }),
    onSuccess: () => {
      if (activeProject) void queryClient.invalidateQueries({ queryKey: ["bundle", activeProject.id] });
    }
  });

  const reindexSearch = useMutation({
    mutationFn: (projectId?: string) => window.paperPilot.reindexSearch(projectId ? { projectId } : {}),
    onSuccess: () => {
      if (activeProject) void queryClient.invalidateQueries({ queryKey: ["bundle", activeProject.id] });
    }
  });

  const updateSources = useMutation({
    mutationFn: (disabledSourceIds: SourceId[]) =>
      window.paperPilot.updateSettings({
        sources: { disabledSourceIds }
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["settings"] })
  });

  const flags = flagsQuery.data ?? [];
  const credentialed = useMemo(() => new Set(flags.map((flag) => flag.sourceId)), [flags]);
  const candidateHealth = checkProvider.data ?? aiHealth;
  const displayedHealth =
    candidateHealth?.provider === provider && candidateHealth.baseUrl === baseUrl && candidateHealth.model === model ? candidateHealth : undefined;
  const disabledSourceIds = new Set(settingsQuery.data?.sources.disabledSourceIds ?? []);

  function changeProvider(nextProvider: AppSettings["ai"]["provider"]): void {
    setProvider(nextProvider);
    const defaults = providerDefaults[nextProvider];
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
  }

  function toggleSource(sourceId: SourceId, enabled: boolean): void {
    const next = new Set(disabledSourceIds);
    if (enabled) next.delete(sourceId);
    else next.add(sourceId);
    updateSources.mutate([...next]);
  }

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent side="right" className="gap-0 border-border bg-popover p-0 sm:max-w-[440px]" showCloseButton>
        <SheetHeader className="border-b border-border px-5 py-4 pr-14">
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Sources, AI, policy, and appearance.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-5">
            <PanelSection icon={<Moon size={17} />} title="Appearance">
              <ToggleGroup
                type="single"
                value={themePreference}
                onValueChange={(value) => value && onThemeChange(value as ThemePreference)}
                variant="outline"
                className="grid w-full grid-cols-3"
              >
                {(["system", "light", "dark"] as const).map((theme) => {
                  const Icon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
                  return (
                    <ToggleGroupItem key={theme} value={theme} disabled={isThemeSaving} className="w-full capitalize">
                      <Icon size={14} />
                      {theme}
                    </ToggleGroupItem>
                  );
                })}
              </ToggleGroup>
            </PanelSection>

            <PanelSection icon={<Brain size={17} />} title="AI Provider">
              <FieldLabel>Provider</FieldLabel>
              <Select value={provider} onValueChange={(value) => changeProvider(value as AppSettings["ai"]["provider"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama</SelectItem>
                  <SelectItem value="vercel">Vercel AI Gateway</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                </SelectContent>
              </Select>
              <FieldLabel>Base URL</FieldLabel>
              <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              <FieldLabel>Model</FieldLabel>
              <Input value={model} onChange={(event) => setModel(event.target.value)} />
              {displayedHealth?.models.length ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {displayedHealth.models.map((modelName) => (
                      <SelectItem key={modelName} value={modelName}>
                        {modelName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
                  {saveSettings.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                  Save AI settings
                </Button>
                <Button type="button" variant="outline" onClick={() => checkProvider.mutate()} disabled={checkProvider.isPending}>
                  {checkProvider.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Check
                </Button>
              </div>
              {displayedHealth ? (
                <Alert
                  className={cn(
                    displayedHealth.status === "ok" && "border-primary/40 bg-accent/45",
                    displayedHealth.status === "warning" && "border-chart-4/45 bg-chart-4/10"
                  )}
                  variant={displayedHealth.status === "error" ? "destructive" : "default"}
                >
                  <AlertTitle>{displayedHealth.reachable ? "Reachable" : "Not reachable"}</AlertTitle>
                  <AlertDescription>
                    {displayedHealth.hasApiKey ? "Key stored" : "No key stored"}
                    {displayedHealth.detail ? ` / ${displayedHealth.detail}` : ""}
                  </AlertDescription>
                </Alert>
              ) : null}
            </PanelSection>

            <PanelSection icon={<Search size={17} />} title="Search Index">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => reindexSearch.mutate(activeProject?.id)}
                  disabled={!activeProject || reindexSearch.isPending}
                >
                  {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Project
                </Button>
                <Button type="button" variant="outline" onClick={() => reindexSearch.mutate(undefined)} disabled={reindexSearch.isPending}>
                  {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                  All
                </Button>
              </div>
              {reindexSearch.data ? (
                <Alert>
                  <AlertDescription>
                    Indexed {reindexSearch.data.chunkCount} chunks from {reindexSearch.data.artifactCount} files and{" "}
                    {reindexSearch.data.paperCount} papers.
                    {reindexSearch.data.warnings.length ? (
                      <div className="mt-1 text-chart-4">{reindexSearch.data.warnings.slice(0, 2).join(" ")}</div>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              {reindexSearch.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>Reindex failed. {reindexSearch.error.message}</AlertDescription>
                </Alert>
              ) : null}
            </PanelSection>

            <PanelSection icon={<Database size={17} />} title="Data">
              <Button type="button" variant="outline" onClick={() => void window.paperPilot.openDataFolder()} className="w-full">
                Open data folder
              </Button>
            </PanelSection>

            <PanelSection icon={<KeyRound size={17} />} title="Credentials">
              <Select value={selectedSource} onValueChange={(value) => setSelectedSource(value as SourceId | "ai-gateway")}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai-gateway">Vercel AI Gateway</SelectItem>
                  {sources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldLabel>API key, email, or token</FieldLabel>
              <Input
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                type="password"
                placeholder={credentialed.has(selectedSource) ? "Stored" : "Not configured"}
              />
              <Button type="button" onClick={() => saveCredential.mutate()} disabled={!secret.trim() || saveCredential.isPending} className="w-full">
                {saveCredential.isPending ? <Loader2 size={14} className="animate-spin" /> : null}
                Save credential
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" onClick={() => testCredential.mutate()} disabled={testCredential.isPending}>
                  {testCredential.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Test
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => {
                    if (window.confirm(`Remove the stored credential for ${selectedSource}?`)) removeCredential.mutate();
                  }}
                  disabled={!credentialed.has(selectedSource) || removeCredential.isPending}
                >
                  <Trash2 size={14} />
                  Remove
                </Button>
              </div>
              {testCredential.data ? (
                <Alert variant={testCredential.data.ok ? "default" : "destructive"}>
                  <AlertDescription>{testCredential.data.detail}</AlertDescription>
                </Alert>
              ) : null}
            </PanelSection>

            <PanelSection icon={<Search size={17} />} title="Sources">
              <div className="space-y-2">
                {sources.map((source) => (
                  <div key={source.id} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{source.displayName}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{source.kind}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant={source.stable ? "secondary" : "destructive"}>{source.stable ? "stable" : "experimental"}</Badge>
                        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                          <Checkbox
                            checked={!disabledSourceIds.has(source.id)}
                            onCheckedChange={(checked) => toggleSource(source.id, checked === true)}
                          />
                          On
                        </label>
                      </div>
                    </div>
                    <div className="mt-2 text-xs leading-5 text-muted-foreground">{source.description}</div>
                  </div>
                ))}
              </div>
            </PanelSection>

            {activeProject ? (
              <PanelSection icon={<ShieldCheck size={17} />} title="Project Policy">
                <ToggleGroup
                  type="single"
                  value={activeProject.policy.autonomy}
                  onValueChange={(value) => value && updatePolicy.mutate({ autonomy: value as Project["policy"]["autonomy"] })}
                  variant="outline"
                  className="grid w-full grid-cols-3"
                >
                  {(["confirm", "project", "yolo"] as const).map((mode) => (
                    <ToggleGroupItem key={mode} value={mode} className="w-full">
                      {mode}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <PolicyToggle
                  label="Auto-approve API source crawls"
                  checked={activeProject.policy.autoApproveSources}
                  onChange={(checked) => updatePolicy.mutate({ autoApproveSources: checked })}
                />
                <PolicyToggle
                  label="Auto-approve Python scripts"
                  checked={activeProject.policy.autoApproveScripts}
                  onChange={(checked) => updatePolicy.mutate({ autoApproveScripts: checked })}
                />
                <PolicyToggle
                  label="Auto-approve browser installs"
                  checked={activeProject.policy.autoApproveBrowserInstall}
                  onChange={(checked) => updatePolicy.mutate({ autoApproveBrowserInstall: checked })}
                />
              </PanelSection>
            ) : null}
          </div>
        </ScrollArea>
        <Separator />
      </SheetContent>
    </Sheet>
  );
}

function FieldLabel({ children }: { children: string }): JSX.Element {
  return <label className="block text-xs font-medium text-muted-foreground">{children}</label>;
}
