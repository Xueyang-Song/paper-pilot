import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, FileText, Loader2, Paperclip, RotateCcw, Search, Send, Trash2 } from "lucide-react";
import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { Message } from "../../shared/schemas";
import type { ProjectBundle } from "../types";
import { MarkdownMessage } from "./ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ChatWorkspace(props: {
  bundle?: ProjectBundle;
  activeProjectId?: string;
  onProjectCreated(projectId: string): void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const sendChat = useMutation({
    mutationFn: (content: string) => window.paperPilot.sendChat({ projectId: props.activeProjectId, content }),
    onSuccess: (response) => {
      props.onProjectCreated(response.project.id);
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: ["bundle", response.project.id] });
    }
  });

  const runBrief = useMutation({
    mutationFn: () =>
      window.paperPilot.sendChat({
        projectId: props.activeProjectId,
        content: "Generate a citation-backed research brief with comparison table, gaps, controversies, and next reads."
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["bundle", response.project.id] });
    }
  });
  const clearChat = useMutation({
    mutationFn: () => {
      if (!props.activeProjectId) throw new Error("Select a project before clearing chat.");
      return window.paperPilot.clearChat({ projectId: props.activeProjectId });
    },
    onSuccess: () => {
      if (props.activeProjectId) void queryClient.invalidateQueries({ queryKey: ["bundle", props.activeProjectId] });
    }
  });
  const exportChat = useMutation({
    mutationFn: () => {
      if (!props.activeProjectId) throw new Error("Select a project before exporting chat.");
      return window.paperPilot.exportChat({ projectId: props.activeProjectId });
    }
  });
  const importArtifacts = useMutation({
    mutationFn: () => {
      if (!props.activeProjectId) throw new Error("Select a project before attaching files.");
      return window.paperPilot.importArtifacts({ projectId: props.activeProjectId });
    },
    onSuccess: () => {
      if (props.activeProjectId) void queryClient.invalidateQueries({ queryKey: ["bundle", props.activeProjectId] });
    }
  });

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendChat.isPending) return;
    sendChat.mutate(content);
  }

  const messages = props.bundle?.messages ?? [];
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      transcriptEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, sendChat.isPending]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div ref={scrollRegionRef} className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {messages.length ? (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {sendChat.isPending ? <ThinkingBubble /> : null}
            <div ref={transcriptEndRef} aria-hidden="true" />
          </div>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="w-full max-w-3xl">
              <div className="mb-5 flex items-center justify-center">
                <div className="grid size-12 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
                  <Bot size={24} />
                </div>
              </div>
              <h1 className="mb-3 text-center text-2xl font-semibold tracking-normal">Start a research project</h1>
              <div className="grid grid-cols-3 gap-2">
                {[
                  "Crawl recent papers on CRISPR delivery vectors",
                  "Find open-access work about perovskite solar stability",
                  "Search literature on climate attribution models since 2022"
                ].map((prompt) => (
                  <Button
                    key={prompt}
                    type="button"
                    variant="outline"
                    onClick={() => setDraft(prompt)}
                    className="h-auto min-h-20 justify-start whitespace-normal rounded-lg px-3 py-2 text-left text-sm text-muted-foreground"
                  >
                    {prompt}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-border bg-card p-5">
        <div className="mx-auto max-w-4xl">
          <Card className="rounded-lg border-border bg-card py-0 shadow-sm">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              placeholder="Ask Paper Pilot to crawl papers, analyze findings, or generate a brief..."
              className="max-h-40 min-h-24 resize-none rounded-b-none border-0 bg-transparent px-4 py-3 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-between border-t border-border bg-transparent px-3 py-2">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => runBrief.mutate()}
                  disabled={!props.activeProjectId || runBrief.isPending}
                >
                  <FileText size={16} />
                  Brief
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft("Crawl open-access papers about ")}
                >
                  <Search size={16} />
                  Crawl
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => importArtifacts.mutate()}
                  disabled={!props.activeProjectId || importArtifacts.isPending}
                >
                  {importArtifacts.isPending ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />}
                  Attach
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => lastUserMessage && setDraft(lastUserMessage.content)}
                  disabled={!lastUserMessage}
                  title="Retry last request"
                  aria-label="Retry last request"
                >
                  <RotateCcw size={16} />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => exportChat.mutate()}
                  disabled={!props.activeProjectId || !messages.length || exportChat.isPending}
                  title="Export conversation"
                  aria-label="Export conversation"
                >
                  <Download size={16} />
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  onClick={() => {
                    if (window.confirm("Clear this conversation? Project files and papers will remain.")) clearChat.mutate();
                  }}
                  disabled={!props.activeProjectId || !messages.length || clearChat.isPending}
                  title="Clear conversation"
                  aria-label="Clear conversation"
                >
                  <Trash2 size={16} />
                </Button>
              </div>
              <Button
                type="submit"
                disabled={!draft.trim() || sendChat.isPending}
              >
                {sendChat.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Send
              </Button>
            </div>
          </Card>
        </div>
      </form>
    </section>
  );
}

function MessageBubble({ message }: { message: Message }): JSX.Element {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={cn(
          "max-w-[78%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm",
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card text-card-foreground"
        )}
      >
        <MarkdownMessage content={message.content} isUser={isUser} />
      </div>
    </div>
  );
}

function ThinkingBubble(): JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
        <Loader2 size={16} className="animate-spin" />
        Working through the project tools
      </div>
    </div>
  );
}
