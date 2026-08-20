// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperPilotApi } from "../src/preload/index";
import { ChatWorkspace } from "../src/renderer/components/chat-workspace";
import type { ProjectBundle } from "../src/renderer/types";
import type { ChatRun, ChatRunEvent, Citation, Message } from "../src/shared/schemas";

const timestamp = "2026-08-19T00:00:00.000Z";
const project = {
  id: "project_1",
  title: "Evidence project",
  topic: "evidence",
  createdAt: timestamp,
  updatedAt: timestamp,
  policy: {
    autonomy: "project" as const,
    autoApproveSources: false,
    autoApproveScripts: false,
    autoApproveBrowserInstall: false,
    maxCrawlPapers: 50,
    warnOnPaidModelRuns: true
  }
};
const conversation = {
  id: "conversation_1",
  projectId: project.id,
  title: "Streaming chat",
  mode: "grounded" as const,
  createdAt: timestamp,
  updatedAt: timestamp
};
const source = {
  id: "artifact_1",
  projectId: project.id,
  type: "markdown" as const,
  title: "Inspectable evidence",
  path: "C:/data/source.md",
  mime: "text/markdown",
  hash: "hash",
  metadata: {},
  createdAt: timestamp
};
const bundle: ProjectBundle = {
  project,
  conversations: [conversation],
  messages: [],
  papers: [],
  artifacts: [source],
  jobs: []
};

let runListener: ((event: ChatRunEvent) => void) | undefined;

beforeEach(() => {
  runListener = undefined;
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("research chat workspace", () => {
  it("keeps early stream events, stops runs, and opens completed citations", async () => {
    let messages: Message[] = [];
    let runs: ChatRun[] = [];
    const citation: Citation = {
      id: "citation_1",
      runId: "run_1",
      messageId: "assistant_1",
      evidenceId: "S1",
      sourceType: "artifact",
      artifactId: source.id,
      title: source.title,
      excerpt: "The controlled source reports a measured improvement.",
      page: 2,
      retrievalScore: 1
    };
    const run: ChatRun = {
      id: "run_1",
      projectId: project.id,
      conversationId: conversation.id,
      userMessageId: "user_1",
      assistantMessageId: "assistant_1",
      provider: "ollama",
      model: "test-model",
      mode: "grounded",
      status: "completed",
      sourceRefs: [],
      includedMessageCount: 1,
      omittedMessageCount: 2,
      trace: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const api = {
      listConversations: vi.fn().mockResolvedValue([conversation]),
      listConversationMessages: vi.fn(async () => messages),
      listChatRuns: vi.fn(async () => runs),
      listChatCitations: vi.fn().mockResolvedValue([citation]),
      onChatRunEvent: vi.fn((listener: (event: ChatRunEvent) => void) => {
        runListener = listener;
        return () => undefined;
      }),
      startChatRun: vi.fn(async () => {
        runListener?.({
          type: "status",
          runId: run.id,
          projectId: project.id,
          conversationId: conversation.id,
          assistantMessageId: "assistant_1",
          status: "running"
        });
        runListener?.({
          type: "delta",
          runId: run.id,
          projectId: project.id,
          conversationId: conversation.id,
          assistantMessageId: "assistant_1",
          text: "Early streamed evidence [[S1]]"
        });
        runListener?.({
          type: "trace",
          runId: run.id,
          projectId: project.id,
          conversationId: conversation.id,
          assistantMessageId: "assistant_1",
          step: {
            id: "trace_1",
            kind: "retrieval",
            status: "completed",
            label: "Retrieved evidence",
            startedAt: timestamp,
            completedAt: timestamp
          }
        });
        return { runId: run.id, userMessageId: "user_1", assistantMessageId: "assistant_1" };
      }),
      cancelChatRun: vi.fn().mockResolvedValue({ cancelled: true }),
      updateConversation: vi.fn(),
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      exportChat: vi.fn(),
      importArtifacts: vi.fn()
    } as unknown as PaperPilotApi;
    Object.defineProperty(window, "paperPilot", { configurable: true, value: api });
    const onOpenArtifact = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ChatWorkspace bundle={bundle} activeProjectId={project.id} onOpenArtifact={onOpenArtifact} />
      </QueryClientProvider>
    );

    fireEvent.change(await screen.findByPlaceholderText(/Ask a grounded question/i), {
      target: { value: "What improved?" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));

    expect(await screen.findByText(/Early streamed evidence/)).toBeTruthy();
    expect(screen.getByText("Retrieved evidence")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/i }));
    expect(api.cancelChatRun).toHaveBeenCalledWith(run.id);

    messages = [
      {
        id: "user_1",
        projectId: project.id,
        conversationId: conversation.id,
        runId: run.id,
        role: "user",
        content: "What improved?",
        status: "completed",
        metadata: {},
        createdAt: timestamp
      },
      {
        id: "assistant_1",
        projectId: project.id,
        conversationId: conversation.id,
        runId: run.id,
        role: "assistant",
        content: "The study reports a measured improvement. [[S1]]",
        status: "completed",
        metadata: { mode: "grounded" },
        createdAt: timestamp
      }
    ];
    runs = [run];
    await act(async () => {
      runListener?.({
        type: "complete",
        runId: run.id,
        projectId: project.id,
        conversationId: conversation.id,
        assistantMessageId: "assistant_1",
        run,
        message: messages[1],
        citations: [citation]
      });
    });

    const citationLink = await screen.findByRole("link", { name: "S1" });
    expect(screen.getByText(/2 older messages omitted/)).toBeTruthy();
    fireEvent.click(citationLink);
    expect(await screen.findByText(citation.excerpt)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open source/i }));
    await waitFor(() => expect(onOpenArtifact).toHaveBeenCalledWith(source.id, 2));

    const secondRun: ChatRun = {
      ...run,
      id: "run_2",
      userMessageId: "user_2",
      assistantMessageId: "assistant_2"
    };
    vi.mocked(api.startChatRun).mockImplementationOnce(async () => {
      const userMessage: Message = {
        ...messages[0],
        id: "user_2",
        runId: secondRun.id,
        content: "List sources"
      };
      const assistantMessage: Message = {
        ...messages[1],
        id: "assistant_2",
        runId: secondRun.id,
        content: "The source list is ready."
      };
      messages = [...messages, userMessage, assistantMessage];
      runs = [secondRun, ...runs];
      runListener?.({
        type: "complete",
        runId: secondRun.id,
        projectId: project.id,
        conversationId: conversation.id,
        assistantMessageId: "assistant_2",
        run: secondRun,
        message: assistantMessage,
        citations: []
      });
      return { runId: secondRun.id, userMessageId: "user_2", assistantMessageId: "assistant_2" };
    });
    fireEvent.change(screen.getByPlaceholderText(/Ask a grounded question/i), {
      target: { value: "List sources" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));

    expect(await screen.findByText("The source list is ready.")).toBeTruthy();
    expect(screen.queryByText("Research run in progress")).toBeNull();
  });
});
