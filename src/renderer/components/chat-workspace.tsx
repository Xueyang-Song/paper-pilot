import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  BookOpen,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X
} from "lucide-react";
import type { FormEvent, JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMode,
  ChatRun,
  ChatRunEvent,
  ChatTraceStep,
  Citation,
  Message,
  SourceRef
} from "../../shared/schemas";
import type { ProjectBundle } from "../types";
import { MarkdownMessage } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface LiveRun {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
  content: string;
  status: "queued" | "running" | "stopped" | "failed";
  trace: ChatTraceStep[];
}

export function ChatWorkspace(props: {
  bundle?: ProjectBundle;
  activeProjectId?: string;
  currentArtifactId?: string;
  onOpenArtifact?(artifactId: string, page?: number): void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [sourceRefs, setSourceRefs] = useState<SourceRef[]>([]);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [liveRuns, setLiveRuns] = useState<Record<string, LiveRun>>({});
  const [citationsByRun, setCitationsByRun] = useState<Record<string, Citation[]>>({});
  const [selectedCitation, setSelectedCitation] = useState<Citation>();
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const terminalRunIdsRef = useRef(new Set<string>());
  const queryClient = useQueryClient();

  useEffect(() => {
    setActiveConversationId(undefined);
    setSourceRefs([]);
    setSelectedCitation(undefined);
  }, [props.activeProjectId]);

  const conversationsQuery = useQuery({
    queryKey: ["conversations", props.activeProjectId],
    queryFn: () => window.paperPilot.listConversations(props.activeProjectId!),
    enabled: Boolean(props.activeProjectId),
    initialData: props.bundle?.project.id === props.activeProjectId ? props.bundle?.conversations : undefined
  });
  const conversations = useMemo(() => conversationsQuery.data ?? [], [conversationsQuery.data]);

  useEffect(() => {
    if (!activeConversationId || !conversations.some((conversation) => conversation.id === activeConversationId)) {
      setActiveConversationId(conversations[0]?.id);
    }
  }, [activeConversationId, conversations]);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const messagesQuery = useQuery({
    queryKey: ["conversation-messages", props.activeProjectId, activeConversationId],
    queryFn: () =>
      window.paperPilot.listConversationMessages({
        projectId: props.activeProjectId!,
        conversationId: activeConversationId!
      }),
    enabled: Boolean(props.activeProjectId && activeConversationId)
  });
  const runsQuery = useQuery({
    queryKey: ["chat-runs", activeConversationId],
    queryFn: () => window.paperPilot.listChatRuns(activeConversationId!),
    enabled: Boolean(activeConversationId)
  });

  useEffect(() => {
    const runs = runsQuery.data ?? [];
    if (!runs.length) return;
    let cancelled = false;
    void Promise.all(
      runs.map(async (run) => [run.id, await window.paperPilot.listChatCitations(run.id)] as const)
    ).then((entries) => {
      if (!cancelled) setCitationsByRun((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [runsQuery.data]);

  useEffect(() => {
    return window.paperPilot.onChatRunEvent((event) => {
      const knownConversationId = event.conversationId;
      if (event.type === "delta") {
        setLiveRuns((current) => {
          const live = liveRunForEvent(current[knownConversationId], event);
          return {
            ...current,
            [knownConversationId]: { ...live, content: live.content + event.text, status: "running" }
          };
        });
      } else if (event.type === "status") {
        setLiveRuns((current) => {
          const live = liveRunForEvent(current[knownConversationId], event);
          return {
            ...current,
            [knownConversationId]: { ...live, status: event.status === "completed" ? "running" : event.status }
          };
        });
      } else if (event.type === "trace") {
        setLiveRuns((current) => {
          const live = liveRunForEvent(current[knownConversationId], event);
          return { ...current, [knownConversationId]: { ...live, trace: [...live.trace, event.step] } };
        });
      } else if (event.type === "complete") {
        terminalRunIdsRef.current.add(event.runId);
        setCitationsByRun((current) => ({ ...current, [event.runId]: event.citations }));
        void refreshConversation(queryClient, event.run.projectId, event.run.conversationId).then(() => {
          setLiveRuns((current) => removeLiveRun(current, event.run.conversationId, event.runId));
        });
      } else if (event.type === "error") {
        terminalRunIdsRef.current.add(event.runId);
        void refreshConversation(queryClient, event.projectId, knownConversationId).then(() => {
          setLiveRuns((current) => removeLiveRun(current, knownConversationId, event.runId));
        });
      }
    });
  }, [props.activeProjectId, queryClient]);

  const startRun = useMutation({
    mutationFn: async (content: string) => {
      if (!props.activeProjectId || !activeConversation) throw new Error("Select a project conversation first.");
      return window.paperPilot.startChatRun({
        projectId: props.activeProjectId,
        conversationId: activeConversation.id,
        content,
        mode: activeConversation.mode,
        sourceRefs
      });
    },
    onSuccess: (response) => {
      if (!activeConversationId || !props.activeProjectId) return;
      const alreadyTerminal = terminalRunIdsRef.current.delete(response.runId);
      if (!alreadyTerminal) {
        setLiveRuns((current) => ({
          ...current,
          [activeConversationId]:
            current[activeConversationId]?.runId === response.runId
              ? current[activeConversationId]
              : {
                  runId: response.runId,
                  conversationId: activeConversationId,
                  assistantMessageId: response.assistantMessageId,
                  content: "",
                  status: "queued",
                  trace: []
                }
        }));
      }
      setDraft("");
      setSourceRefs([]);
      setSourcePickerOpen(false);
      void refreshConversation(queryClient, props.activeProjectId, activeConversationId);
    }
  });

  const createConversation = useMutation({
    mutationFn: () => window.paperPilot.createConversation({ projectId: props.activeProjectId! }),
    onSuccess: (conversation) => {
      setActiveConversationId(conversation.id);
      void queryClient.invalidateQueries({ queryKey: ["conversations", props.activeProjectId] });
    }
  });
  const updateConversation = useMutation({
    mutationFn: (input: { conversationId: string; title?: string; mode?: ChatMode }) =>
      window.paperPilot.updateConversation(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["conversations", props.activeProjectId] })
  });
  const deleteConversation = useMutation({
    mutationFn: (conversationId: string) => window.paperPilot.deleteConversation(conversationId),
    onSuccess: async () => {
      setActiveConversationId(undefined);
      await queryClient.invalidateQueries({ queryKey: ["conversations", props.activeProjectId] });
      const remaining = queryClient.getQueryData<unknown[]>(["conversations", props.activeProjectId]) ?? [];
      if (!remaining.length) createConversation.mutate();
    }
  });
  const exportChat = useMutation({
    mutationFn: () =>
      window.paperPilot.exportChat({ projectId: props.activeProjectId!, conversationId: activeConversationId })
  });
  const importArtifacts = useMutation({
    mutationFn: () => window.paperPilot.importArtifacts({ projectId: props.activeProjectId! }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["bundle", props.activeProjectId] })
  });

  const activeLiveRun = activeConversationId ? liveRuns[activeConversationId] : undefined;

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || startRun.isPending || activeLiveRun) return;
    startRun.mutate(content);
  }

  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);
  const displayMessages = useMemo(() => {
    if (!activeLiveRun) return messages;
    const found = messages.some((message) => message.id === activeLiveRun.assistantMessageId);
    const replaced = messages.map((message) =>
      message.id === activeLiveRun.assistantMessageId
        ? { ...message, content: activeLiveRun.content, status: "streaming" as const }
        : message
    );
    if (!found) {
      replaced.push({
        id: activeLiveRun.assistantMessageId,
        projectId: props.activeProjectId!,
        conversationId: activeConversationId,
        runId: activeLiveRun.runId,
        role: "assistant",
        content: activeLiveRun.content,
        status: "streaming",
        metadata: {},
        createdAt: new Date().toISOString()
      });
    }
    return replaced;
  }, [activeConversationId, activeLiveRun, messages, props.activeProjectId]);
  const runsById = new Map((runsQuery.data ?? []).map((run) => [run.id, run]));
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const currentArtifact = props.bundle?.artifacts.find((artifact) => artifact.id === props.currentArtifactId);
  const canPinCurrentArtifact =
    currentArtifact &&
    ["paper-pdf", "metadata-json", "markdown", "table"].includes(currentArtifact.type) &&
    currentArtifact.source !== "research-chat" &&
    currentArtifact.source !== "ai-service";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => transcriptEndRef.current?.scrollIntoView({ block: "end" }));
    return () => window.cancelAnimationFrame(frame);
  }, [displayMessages.length, activeLiveRun?.content]);

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label="Research conversation"
            value={activeConversationId ?? ""}
            onChange={(event) => setActiveConversationId(event.target.value)}
            className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-sm font-medium"
          >
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
          <Button
            size="icon"
            variant="ghost"
            aria-label="New chat"
            title="New chat"
            onClick={() => createConversation.mutate()}
          >
            <Plus size={16} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Rename chat"
            title="Rename chat"
            disabled={!activeConversation}
            onClick={() => {
              if (!activeConversation) return;
              const title = window.prompt("Conversation title", activeConversation.title)?.trim();
              if (title) updateConversation.mutate({ conversationId: activeConversation.id, title });
            }}
          >
            <Pencil size={15} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Export chat"
            title="Export chat"
            disabled={!activeConversation || exportChat.isPending}
            onClick={() => exportChat.mutate()}
          >
            <Download size={15} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Delete chat"
            title="Delete chat"
            disabled={!activeConversation || Boolean(activeLiveRun)}
            onClick={() => {
              if (
                activeConversation &&
                window.confirm(`Delete “${activeConversation.title}”? Generated answers will remain.`)
              )
                deleteConversation.mutate(activeConversation.id);
            }}
          >
            <Trash2 size={15} />
          </Button>
        </div>
        <div className="flex rounded-md border border-input bg-muted/30 p-0.5" aria-label="Research mode">
          {(["grounded", "exploratory"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={activeConversation?.mode === mode ? "default" : "ghost"}
              className="h-7 px-2.5 text-xs capitalize"
              disabled={!activeConversation || Boolean(activeLiveRun)}
              onClick={() => updateConversation.mutate({ conversationId: activeConversation!.id, mode })}
            >
              {mode === "grounded" ? <ShieldCheck size={14} /> : <Sparkles size={14} />}
              {mode}
            </Button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {displayMessages.length ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {displayMessages.map((message) => {
              const live = message.runId && activeLiveRun?.runId === message.runId ? activeLiveRun : undefined;
              const runPrompt = message.runId
                ? messages.find((candidate) => candidate.runId === message.runId && candidate.role === "user")?.content
                : undefined;
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  run={message.runId ? runsById.get(message.runId) : undefined}
                  trace={live?.trace}
                  citations={message.runId ? (citationsByRun[message.runId] ?? []) : []}
                  onCitation={setSelectedCitation}
                  onRetry={runPrompt ? () => setDraft(runPrompt) : undefined}
                />
              );
            })}
            <div ref={transcriptEndRef} aria-hidden="true" />
          </div>
        ) : (
          <EmptyConversation onPrompt={setDraft} />
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-border bg-card p-5">
        <div className="mx-auto max-w-4xl">
          {activeConversation?.mode === "exploratory" ? (
            <div className="mb-2 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
              <Sparkles size={14} /> May use model knowledge beyond project sources.
            </div>
          ) : null}
          {activeLiveRun ? (
            <div className="mb-2 flex items-center justify-between rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" /> Research run in progress
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void window.paperPilot.cancelChatRun(activeLiveRun.runId)}
              >
                <Square size={13} /> Stop
              </Button>
            </div>
          ) : null}
          {sourceRefs.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {sourceRefs.map((ref) => (
                <Badge key={`${ref.type}:${ref.id}`} variant="secondary" className="gap-1">
                  {sourceLabel(ref, props.bundle)}
                  <button
                    type="button"
                    aria-label="Remove source"
                    onClick={() => setSourceRefs((refs) => refs.filter((item) => item !== ref))}
                  >
                    <X size={12} />
                  </button>
                </Badge>
              ))}
              <span className="self-center text-xs text-muted-foreground">
                Pins constrain this request and clear after sending.
              </span>
            </div>
          ) : null}
          {sourcePickerOpen ? (
            <SourcePicker
              bundle={props.bundle}
              filter={sourceFilter}
              selected={sourceRefs}
              onFilter={setSourceFilter}
              onToggle={(ref) => setSourceRefs((refs) => toggleSourceRef(refs, ref))}
              onClose={() => setSourcePickerOpen(false)}
            />
          ) : null}
          <Card className="rounded-lg border-border bg-card py-0 shadow-sm">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              disabled={!activeConversation || Boolean(activeLiveRun)}
              placeholder="Ask a grounded question about this project..."
              className="max-h-40 min-h-24 resize-none rounded-b-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft("Generate a citation-backed research brief.")}
                >
                  <FileText size={16} /> Brief
                </Button>
                <Button type="button" variant="outline" onClick={() => setDraft("Crawl open-access papers about ")}>
                  <Search size={16} /> Crawl
                </Button>
                <Button type="button" variant="outline" onClick={() => setSourcePickerOpen((open) => !open)}>
                  <BookOpen size={16} /> Add sources
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => importArtifacts.mutate()}
                  disabled={!props.activeProjectId || importArtifacts.isPending}
                >
                  {importArtifacts.isPending ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}{" "}
                  Attach
                </Button>
                {canPinCurrentArtifact ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      setSourceRefs((refs) => toggleSourceRef(refs, { type: "artifact", id: props.currentArtifactId! }))
                    }
                  >
                    Pin open file
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => lastUserMessage && setDraft(lastUserMessage.content)}
                  disabled={!lastUserMessage}
                  aria-label="Retry last request"
                  title="Retry last request"
                >
                  <RotateCcw size={16} />
                </Button>
              </div>
              <Button type="submit" disabled={!draft.trim() || startRun.isPending || Boolean(activeLiveRun)}>
                {startRun.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Send
              </Button>
            </div>
          </Card>
          {startRun.error ? <p className="mt-2 text-xs text-destructive">{startRun.error.message}</p> : null}
        </div>
      </form>

      {selectedCitation ? (
        <EvidencePanel
          citation={selectedCitation}
          onClose={() => setSelectedCitation(undefined)}
          onOpenArtifact={props.onOpenArtifact}
        />
      ) : null}
    </section>
  );
}

function MessageBubble(props: {
  message: Message;
  run?: ChatRun;
  trace?: ChatTraceStep[];
  citations: Citation[];
  onCitation(citation: Citation): void;
  onRetry?(): void;
}): JSX.Element {
  const isUser = props.message.role === "user";
  const citations = new Map(props.citations.map((citation) => [citation.evidenceId, citation]));
  const trace = props.trace ?? props.run?.trace ?? [];
  const contextStep = trace.find((step) => step.kind === "context");
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={cn(
          "max-w-[82%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm",
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card text-card-foreground"
        )}
      >
        {!isUser && (props.run?.mode === "exploratory" || props.message.metadata.mode === "exploratory") ? (
          <Badge variant="outline" className="mb-2 gap-1 text-[10px] text-amber-600">
            <Sparkles size={11} /> May use model knowledge
          </Badge>
        ) : null}
        {!isUser && props.run ? (
          <p className="mb-2 text-xs text-muted-foreground">
            Active context: {props.run.includedMessageCount} messages
            {props.run.omittedMessageCount > 0 ? ` · ${props.run.omittedMessageCount} older messages omitted` : ""}
          </p>
        ) : !isUser && contextStep ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {contextStep.label}
            {contextStep.detail ? ` · ${contextStep.detail}` : ""}
          </p>
        ) : null}
        {props.message.content ? (
          <MarkdownMessage
            content={props.message.content}
            isUser={isUser}
            onCitation={(evidenceId) => {
              const citation = citations.get(evidenceId);
              if (citation) props.onCitation(citation);
            }}
          />
        ) : (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 size={15} className="animate-spin" /> Retrieving evidence
          </span>
        )}
        {!isUser && props.message.status !== "completed" ? (
          <div className="mt-2 flex items-center justify-between gap-3 text-xs capitalize text-muted-foreground">
            <span>{props.message.status === "stopped" ? "Partial · stopped" : props.message.status}</span>
            {props.onRetry && (props.message.status === "failed" || props.message.status === "stopped") ? (
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={props.onRetry}>
                <RotateCcw size={12} /> Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        {!isUser && trace.length ? <RunTrace trace={trace} run={props.run} /> : null}
      </div>
    </div>
  );
}

function RunTrace({ trace, run }: { trace: ChatTraceStep[]; run?: ChatRun }): JSX.Element {
  return (
    <details className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium">
        <span className="inline-flex items-center gap-1">
          <Activity size={12} /> Run trace
        </span>
      </summary>
      <div className="mt-2 space-y-1.5">
        {run ? <p>Elapsed: {formatDuration(run.createdAt, run.updatedAt)}</p> : null}
        {run && run.omittedMessageCount > 0 ? (
          <p>{run.omittedMessageCount} older messages were outside the active context.</p>
        ) : null}
        {trace.map((step) => (
          <div key={step.id} className="flex items-start justify-between gap-3">
            <span>{step.label}</span>
            <span className="capitalize">{step.status}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function SourcePicker(props: {
  bundle?: ProjectBundle;
  filter: string;
  selected: SourceRef[];
  onFilter(value: string): void;
  onToggle(ref: SourceRef): void;
  onClose(): void;
}): JSX.Element {
  const query = props.filter.toLowerCase();
  const papers = (props.bundle?.papers ?? []).filter((paper) => paper.title.toLowerCase().includes(query)).slice(0, 20);
  const artifacts = (props.bundle?.artifacts ?? [])
    .filter(
      (artifact) =>
        ["paper-pdf", "metadata-json", "markdown", "table"].includes(artifact.type) &&
        artifact.source !== "research-chat" &&
        artifact.source !== "ai-service" &&
        artifact.title.toLowerCase().includes(query)
    )
    .slice(0, 20);
  const items = [
    ...papers.map((paper) => ({ ref: { type: "paper" as const, id: paper.id }, label: paper.title, kind: "Paper" })),
    ...artifacts.map((artifact) => ({
      ref: { type: "artifact" as const, id: artifact.id },
      label: artifact.title,
      kind: "Artifact"
    }))
  ];
  return (
    <Card className="mb-2 max-h-64 overflow-hidden rounded-lg p-3">
      <div className="mb-2 flex items-center gap-2">
        <Input
          value={props.filter}
          onChange={(event) => props.onFilter(event.target.value)}
          placeholder="Filter project sources"
        />
        <Button type="button" size="icon" variant="ghost" onClick={props.onClose}>
          <X size={15} />
        </Button>
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {items.map((item) => {
          const selected = props.selected.some((ref) => ref.type === item.ref.type && ref.id === item.ref.id);
          return (
            <button
              key={`${item.ref.type}:${item.ref.id}`}
              type="button"
              onClick={() => props.onToggle(item.ref)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                selected && "bg-primary/10 text-primary"
              )}
            >
              <span className="truncate">{item.label}</span>
              <span className="ml-2 text-muted-foreground">{item.kind}</span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function EvidencePanel(props: {
  citation: Citation;
  onClose(): void;
  onOpenArtifact?(artifactId: string, page?: number): void;
}): JSX.Element {
  return (
    <aside className="absolute inset-y-0 right-0 z-30 w-[360px] border-l border-border bg-card p-5 shadow-xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <Badge variant="secondary">{props.citation.evidenceId}</Badge>
          <h2 className="mt-2 font-semibold leading-5">{props.citation.title}</h2>
        </div>
        <Button size="icon" variant="ghost" onClick={props.onClose} aria-label="Close evidence">
          <X size={16} />
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {props.citation.locator ?? (props.citation.sourceType === "paper" ? "Paper record" : "Project artifact")}
      </p>
      <blockquote className="max-h-[55vh] overflow-y-auto border-l-2 border-primary/40 pl-3 text-sm leading-6">
        {props.citation.excerpt}
      </blockquote>
      <div className="mt-4 flex flex-wrap gap-2">
        {props.citation.artifactId ? (
          <Button size="sm" onClick={() => props.onOpenArtifact?.(props.citation.artifactId!, props.citation.page)}>
            <BookOpen size={14} /> Open source
          </Button>
        ) : null}
        {props.citation.url ? (
          <Button size="sm" variant="outline" asChild>
            <a href={props.citation.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Source URL
            </a>
          </Button>
        ) : null}
        {props.citation.doi ? (
          <Button size="sm" variant="outline" asChild>
            <a href={`https://doi.org/${props.citation.doi}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> DOI
            </a>
          </Button>
        ) : null}
      </div>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Citation validation confirms that this reference was retrieved for the run; it does not prove that the source
        entails every claim.
      </p>
    </aside>
  );
}

function EmptyConversation({ onPrompt }: { onPrompt(prompt: string): void }): JSX.Element {
  const prompts = [
    "Compare the strongest findings in this project",
    "What evidence contradicts the leading explanation?",
    "Identify research gaps supported by these sources"
  ];
  return (
    <div className="grid h-full place-items-center">
      <div className="w-full max-w-3xl">
        <div className="mb-5 flex justify-center">
          <div className="grid size-12 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bot size={24} />
          </div>
        </div>
        <h1 className="mb-2 text-center text-2xl font-semibold">Ask the project, inspect the evidence</h1>
        <p className="mb-5 text-center text-sm text-muted-foreground">
          Grounded mode answers from trusted project sources and makes every citation inspectable.
        </p>
        <div className="grid grid-cols-3 gap-2">
          {prompts.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              variant="outline"
              onClick={() => onPrompt(prompt)}
              className="h-auto min-h-20 whitespace-normal text-left text-sm text-muted-foreground"
            >
              {prompt}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function toggleSourceRef(refs: SourceRef[], target: SourceRef): SourceRef[] {
  const exists = refs.some((ref) => ref.type === target.type && ref.id === target.id);
  return exists ? refs.filter((ref) => ref.type !== target.type || ref.id !== target.id) : [...refs, target];
}

function sourceLabel(ref: SourceRef, bundle?: ProjectBundle): string {
  return ref.type === "paper"
    ? (bundle?.papers.find((paper) => paper.id === ref.id)?.title ?? "Paper")
    : (bundle?.artifacts.find((artifact) => artifact.id === ref.id)?.title ?? "Artifact");
}

function formatDuration(start: string, end: string): string {
  const durationMs = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function removeLiveRun(
  current: Record<string, LiveRun>,
  conversationId: string,
  runId: string
): Record<string, LiveRun> {
  if (current[conversationId]?.runId !== runId) return current;
  const next = { ...current };
  delete next[conversationId];
  return next;
}

function liveRunForEvent(
  current: LiveRun | undefined,
  event: Pick<ChatRunEvent, "runId" | "conversationId" | "assistantMessageId">
): LiveRun {
  if (current?.runId === event.runId) return current;
  return {
    runId: event.runId,
    conversationId: event.conversationId,
    assistantMessageId: event.assistantMessageId,
    content: "",
    status: "queued",
    trace: []
  };
}

async function refreshConversation(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId?: string,
  conversationId?: string
): Promise<void> {
  await Promise.all([
    projectId ? queryClient.invalidateQueries({ queryKey: ["bundle", projectId] }) : Promise.resolve(),
    projectId ? queryClient.invalidateQueries({ queryKey: ["conversations", projectId] }) : Promise.resolve(),
    projectId && conversationId
      ? queryClient.invalidateQueries({ queryKey: ["conversation-messages", projectId, conversationId] })
      : Promise.resolve(),
    conversationId ? queryClient.invalidateQueries({ queryKey: ["chat-runs", conversationId] }) : Promise.resolve()
  ]);
}
