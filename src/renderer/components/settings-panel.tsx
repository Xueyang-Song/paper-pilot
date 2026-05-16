import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Brain, CheckCircle2, Database, KeyRound, Loader2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { AiProviderHealth, AppSettings, Project, SourceDefinition, SourceId } from "../../shared/schemas";
import { IconButton, PanelSection, PolicyToggle } from "./ui";

const providerDefaults: Record<AppSettings["ai"]["provider"], { baseUrl: string; model: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434", model: "gemma3:12b-it-qat" },
  vercel: { baseUrl: "https://ai-gateway.vercel.sh/v1", model: "openai/gpt-5.4" },
  "openai-compatible": { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" }
};

export function SettingsPanel({
  sources,
  activeProject,
  aiHealth,
  onClose
}: {
  sources: SourceDefinition[];
  activeProject?: Project;
  aiHealth?: AiProviderHealth;
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

  const flags = flagsQuery.data ?? [];
  const credentialed = useMemo(() => new Set(flags.map((flag) => flag.sourceId)), [flags]);
  const candidateHealth = checkProvider.data ?? aiHealth;
  const displayedHealth =
    candidateHealth?.provider === provider && candidateHealth.baseUrl === baseUrl && candidateHealth.model === model ? candidateHealth : undefined;

  function changeProvider(nextProvider: AppSettings["ai"]["provider"]): void {
    setProvider(nextProvider);
    const defaults = providerDefaults[nextProvider];
    setBaseUrl(defaults.baseUrl);
    setModel(defaults.model);
  }

  return (
    <div className="fixed inset-0 z-40 bg-stone-950/20">
      <motion.aside
        initial={{ x: 420 }}
        animate={{ x: 0 }}
        className="absolute right-0 top-0 flex h-full w-[420px] flex-col border-l border-stone-300 bg-[#fbfaf6] shadow-2xl"
      >
        <div className="flex h-16 items-center justify-between border-b border-stone-200 px-5">
          <div>
            <div className="text-sm font-semibold">Settings</div>
            <div className="text-xs text-stone-600">Sources, AI, policy</div>
          </div>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <PanelSection icon={<Brain size={17} />} title="AI Provider">
            <label className="field-label">Provider</label>
            <select
              value={provider}
              onChange={(event) => changeProvider(event.target.value as AppSettings["ai"]["provider"])}
              className="field-input"
            >
              <option value="ollama">Ollama</option>
              <option value="vercel">Vercel AI Gateway</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
            <label className="field-label">Base URL</label>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="field-input" />
            <label className="field-label">Model</label>
            <input value={model} onChange={(event) => setModel(event.target.value)} className="field-input" />
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => saveSettings.mutate()} className="primary-button">
                Save AI settings
              </button>
              <button
                type="button"
                onClick={() => checkProvider.mutate()}
                disabled={checkProvider.isPending}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:opacity-50"
              >
                {checkProvider.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Check
              </button>
            </div>
            {displayedHealth ? (
              <div
                className={`rounded-md border px-3 py-2 text-xs leading-5 ${
                  displayedHealth.status === "ok"
                    ? "border-[#8aa66a] bg-[#edf4dc] text-[#476629]"
                    : displayedHealth.status === "warning"
                      ? "border-[#d2b05f] bg-[#fbf0c9] text-[#77581b]"
                      : "border-[#e9b4c1] bg-white text-[#7b2d43]"
                }`}
              >
                <div className="font-medium">
                  {displayedHealth.reachable ? "Reachable" : "Not reachable"} | {displayedHealth.hasApiKey ? "Key stored" : "No key stored"}
                </div>
                {displayedHealth.detail ? <div>{displayedHealth.detail}</div> : null}
              </div>
            ) : null}
          </PanelSection>

          <PanelSection icon={<Search size={17} />} title="Search Index">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => reindexSearch.mutate(activeProject?.id)}
                disabled={!activeProject || reindexSearch.isPending}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Project
              </button>
              <button
                type="button"
                onClick={() => reindexSearch.mutate(undefined)}
                disabled={reindexSearch.isPending}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-sm font-medium text-stone-700 transition hover:border-[#175c62] hover:text-[#175c62] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reindexSearch.isPending ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
                All
              </button>
            </div>
            {reindexSearch.data ? (
              <div className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs leading-5 text-stone-600">
                Indexed {reindexSearch.data.chunkCount} chunks from {reindexSearch.data.artifactCount} files and{" "}
                {reindexSearch.data.paperCount} papers.
                {reindexSearch.data.warnings.length ? (
                  <div className="mt-1 text-[#77581b]">{reindexSearch.data.warnings.slice(0, 2).join(" ")}</div>
                ) : null}
              </div>
            ) : null}
            {reindexSearch.isError ? (
              <div className="rounded-md border border-[#e9b4c1] bg-white px-3 py-2 text-xs text-[#7b2d43]">
                Reindex failed. {reindexSearch.error.message}
              </div>
            ) : null}
          </PanelSection>

          <PanelSection icon={<KeyRound size={17} />} title="Credentials">
            <select
              value={selectedSource}
              onChange={(event) => setSelectedSource(event.target.value as SourceId | "ai-gateway")}
              className="field-input"
            >
              <option value="ai-gateway">Vercel AI Gateway</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.displayName}
                </option>
              ))}
            </select>
            <label className="field-label">API key, email, or token</label>
            <input
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              type="password"
              className="field-input"
              placeholder={credentialed.has(selectedSource) ? "Stored" : "Not configured"}
            />
            <button type="button" onClick={() => saveCredential.mutate()} disabled={!secret.trim()} className="primary-button">
              Save credential
            </button>
          </PanelSection>

          <PanelSection icon={<Search size={17} />} title="Sources">
            <div className="space-y-2">
              {sources.map((source) => (
                <div key={source.id} className="rounded-md border border-stone-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{source.displayName}</div>
                      <div className="mt-1 text-xs text-stone-600">{source.kind}</div>
                    </div>
                    <span
                      className={`rounded px-2 py-1 text-[11px] ${
                        source.stable ? "bg-[#d8eadf] text-[#175c62]" : "bg-[#f3d4dc] text-[#7b2d43]"
                      }`}
                    >
                      {source.stable ? "stable" : "experimental"}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-stone-600">{source.description}</div>
                </div>
              ))}
            </div>
          </PanelSection>

          {activeProject ? (
            <PanelSection icon={<ShieldCheck size={17} />} title="Project Policy">
              <div className="grid grid-cols-3 gap-2">
                {(["confirm", "project", "yolo"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updatePolicy.mutate({ autonomy: mode })}
                    className={`rounded-md border px-3 py-2 text-sm ${
                      activeProject.policy.autonomy === mode ? "border-stone-950 bg-stone-950 text-white" : "border-stone-300 bg-white"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
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
      </motion.aside>
    </div>
  );
}
