import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bot, FileText, Loader2, Search, Send, TerminalSquare } from "lucide-react";
import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { Message } from "../../shared/schemas";
import type { ProjectBundle } from "../types";
import { MarkdownMessage } from "./ui";

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

  function submit(event: FormEvent): void {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sendChat.isPending) return;
    sendChat.mutate(content);
  }

  const messages = props.bundle?.messages ?? [];

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      transcriptEndRef.current?.scrollIntoView({ block: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, sendChat.isPending]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                <div className="grid size-12 place-items-center rounded-md bg-stone-950 text-[#f4efe6]">
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
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => setDraft(prompt)}
                    className="min-h-20 rounded-md border border-stone-300 bg-white px-3 py-2 text-left text-sm text-stone-700 shadow-sm transition hover:border-stone-500"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
      <form onSubmit={submit} className="shrink-0 border-t border-stone-200 bg-[#fbfaf6] p-5">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-md border border-stone-300 bg-white shadow-sm">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              placeholder="Ask Paper Pilot to crawl papers, analyze findings, or generate a brief..."
              className="block max-h-40 min-h-24 w-full resize-none rounded-t-md border-0 bg-transparent px-4 py-3 text-sm outline-none placeholder:text-stone-400"
            />
            <div className="flex items-center justify-between border-t border-stone-200 px-3 py-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => runBrief.mutate()}
                  disabled={!props.activeProjectId || runBrief.isPending}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 text-sm text-stone-700 transition hover:bg-stone-100 disabled:opacity-50"
                >
                  <FileText size={16} />
                  Brief
                </button>
                <button
                  type="button"
                  onClick={() => setDraft("Crawl open-access papers about ")}
                  className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 text-sm text-stone-700 transition hover:bg-stone-100"
                >
                  <Search size={16} />
                  Crawl
                </button>
              </div>
              <button
                type="submit"
                disabled={!draft.trim() || sendChat.isPending}
                className="inline-flex h-9 items-center gap-2 rounded-md bg-[#175c62] px-4 text-sm font-medium text-white transition hover:bg-[#11494e] disabled:opacity-50"
              >
                {sendChat.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Send
              </button>
            </div>
          </div>
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
        className={`max-w-[78%] rounded-md px-4 py-3 text-sm leading-6 shadow-sm ${
          isUser ? "bg-[#175c62] text-white" : "border border-stone-200 bg-white text-stone-800"
        }`}
      >
        <MarkdownMessage content={message.content} isUser={isUser} />
      </div>
    </div>
  );
}

function ThinkingBubble(): JSX.Element {
  return (
    <div className="flex justify-start">
      <div className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600 shadow-sm">
        <Loader2 size={16} className="animate-spin" />
        Working through the project tools
      </div>
    </div>
  );
}
