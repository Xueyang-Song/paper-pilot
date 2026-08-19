import { z } from "zod";

export const sourceKindSchema = z.enum(["api", "browser", "enrichment"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceIdSchema = z.enum([
  "openalex",
  "crossref",
  "semantic-scholar",
  "pubmed",
  "arxiv",
  "europe-pmc",
  "core",
  "unpaywall",
  "google-scholar"
]);
export type SourceId = z.infer<typeof sourceIdSchema>;

export const paperScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  label: z.enum(["excellent", "strong", "solid", "emerging", "limited"]),
  components: z.object({
    citations: z.number().min(0).max(100),
    venue: z.number().min(0).max(100),
    institution: z.number().min(0).max(100),
    recency: z.number().min(0).max(100),
    access: z.number().min(0).max(100),
    source: z.number().min(0).max(100),
    metadata: z.number().min(0).max(100)
  }),
  reasons: z.array(z.string()).default([]),
  scoredAt: z.string(),
  version: z.string()
});
export type PaperScore = z.infer<typeof paperScoreSchema>;

export const paperUserStatusSchema = z.enum(["unread", "to-read", "reading", "read", "rejected"]);
export type PaperUserStatus = z.infer<typeof paperUserStatusSchema>;

export const paperSchema = z.object({
  id: z.string(),
  projectId: z.string().optional(),
  title: z.string().min(1),
  abstract: z.string().optional(),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  publishedAt: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  pdfUrl: z.string().url().optional(),
  source: sourceIdSchema,
  sourcePaperId: z.string().optional(),
  venue: z.string().optional(),
  citationCount: z.number().int().nonnegative().optional(),
  isOpenAccess: z.boolean().default(false),
  license: z.string().optional(),
  fieldsOfStudy: z.array(z.string()).default([]),
  score: paperScoreSchema.optional(),
  favorite: z.boolean().optional(),
  userStatus: paperUserStatusSchema.optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  raw: z.record(z.string(), z.unknown()).optional()
});
export type Paper = z.infer<typeof paperSchema>;

export const artifactTypeSchema = z.enum([
  "metadata-json",
  "paper-pdf",
  "markdown",
  "crawl-log",
  "brief",
  "chat-answer",
  "script",
  "table"
]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const artifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: artifactTypeSchema,
  title: z.string(),
  path: z.string(),
  mime: z.string(),
  hash: z.string(),
  source: z.string().optional(),
  parentArtifactId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type Artifact = z.infer<typeof artifactSchema>;

export const searchScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("global") }),
  z.object({ type: z.literal("project"), projectId: z.string() }),
  z.object({ type: z.literal("file"), projectId: z.string(), artifactId: z.string() })
]);
export type SearchScope = z.infer<typeof searchScopeSchema>;

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  scope: searchScopeSchema,
  limit: z.number().int().positive().max(100).default(30)
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const searchResultSchema = z.object({
  id: z.string(),
  kind: z.enum(["paper", "chunk"]),
  projectId: z.string(),
  projectTitle: z.string().optional(),
  artifactId: z.string().optional(),
  artifactTitle: z.string().optional(),
  artifactType: artifactTypeSchema.optional(),
  paperId: z.string().optional(),
  paperTitle: z.string().optional(),
  page: z.number().int().positive().optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  snippet: z.string(),
  score: z.number(),
  createdAt: z.string().optional()
});
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  scope: searchScopeSchema,
  results: z.array(searchResultSchema)
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const reindexRequestSchema = z.object({
  projectId: z.string().optional()
});
export type ReindexRequest = z.infer<typeof reindexRequestSchema>;

export const reindexResponseSchema = z.object({
  artifactCount: z.number().int().nonnegative(),
  paperCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([])
});
export type ReindexResponse = z.infer<typeof reindexResponseSchema>;

export const sourceDiagnosticSchema = z.object({
  sourceId: sourceIdSchema,
  displayName: z.string(),
  status: z.enum(["ok", "warning", "failed"]),
  durationMs: z.number().int().nonnegative(),
  paperCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
  attemptedUrl: z.string().optional(),
  graceful: z.boolean().default(true)
});
export type SourceDiagnostic = z.infer<typeof sourceDiagnosticSchema>;

export const projectPolicySchema = z
  .object({
    autonomy: z.enum(["confirm", "project", "yolo"]).default("project"),
    autoApproveSources: z.boolean().default(false),
    autoApproveScripts: z.boolean().default(false),
    autoApproveBrowserInstall: z.boolean().default(false),
    maxCrawlPapers: z.number().int().positive().default(50),
    warnOnPaidModelRuns: z.boolean().default(true)
  })
  .default({
    autonomy: "project",
    autoApproveSources: false,
    autoApproveScripts: false,
    autoApproveBrowserInstall: false,
    maxCrawlPapers: 50,
    warnOnPaidModelRuns: true
  });
export type ProjectPolicy = z.infer<typeof projectPolicySchema>;

export const projectSchema = z.object({
  id: z.string(),
  title: z.string(),
  topic: z.string().optional(),
  description: z.string().optional(),
  archivedAt: z.string().optional(),
  pinnedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  policy: projectPolicySchema
});
export type Project = z.infer<typeof projectSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const chatModeSchema = z.enum(["grounded", "exploratory"]);
export type ChatMode = z.infer<typeof chatModeSchema>;

export const conversationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1).max(120),
  mode: chatModeSchema.default("grounded"),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Conversation = z.infer<typeof conversationSchema>;

export const sourceRefSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paper"), id: z.string() }),
  z.object({ type: z.literal("artifact"), id: z.string() })
]);
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const chatRunStatusSchema = z.enum(["queued", "running", "completed", "stopped", "failed"]);
export type ChatRunStatus = z.infer<typeof chatRunStatusSchema>;

export const chatTraceStepSchema = z.object({
  id: z.string(),
  kind: z.enum(["context", "retrieval", "provider", "tool", "citation", "artifact"]),
  status: z.enum(["running", "waiting", "completed", "failed", "stopped"]),
  label: z.string(),
  detail: z.string().optional(),
  toolName: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional()
});
export type ChatTraceStep = z.infer<typeof chatTraceStepSchema>;

export const citationSchema = z.object({
  id: z.string(),
  runId: z.string(),
  messageId: z.string().optional(),
  evidenceId: z.string(),
  sourceType: z.enum(["paper", "artifact"]),
  paperId: z.string().optional(),
  artifactId: z.string().optional(),
  chunkId: z.string().optional(),
  title: z.string(),
  excerpt: z.string(),
  page: z.number().int().positive().optional(),
  locator: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  retrievalScore: z.number().optional()
});
export type Citation = z.infer<typeof citationSchema>;

export const chatRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string().optional(),
  outputArtifactId: z.string().optional(),
  provider: z.enum(["ollama", "vercel", "openai-compatible"]),
  model: z.string(),
  mode: chatModeSchema,
  status: chatRunStatusSchema,
  sourceRefs: z.array(sourceRefSchema).default([]),
  includedMessageCount: z.number().int().nonnegative().default(0),
  omittedMessageCount: z.number().int().nonnegative().default(0),
  trace: z.array(chatTraceStepSchema).default([]),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ChatRun = z.infer<typeof chatRunSchema>;

export const messageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  role: messageRoleSchema,
  content: z.string(),
  status: z.enum(["streaming", "completed", "stopped", "failed"]).default("completed"),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type Message = z.infer<typeof messageSchema>;

export const crawlConfigSchema = z.object({
  topic: z.string().min(1),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  maxPapers: z.number().int().positive().max(500).default(25),
  sourceIds: z
    .array(sourceIdSchema)
    .default(["openalex", "crossref", "semantic-scholar", "arxiv", "europe-pmc", "pubmed"]),
  sort: z.enum(["relevance", "newest", "cited"]).default("relevance"),
  openAccessOnly: z.boolean().default(true),
  allowBrowserFallback: z.boolean().default(false),
  credentialRefs: z.record(z.string(), z.string()).default({})
});
export type CrawlConfig = z.infer<typeof crawlConfigSchema>;

export const sourceDefinitionSchema = z.object({
  id: sourceIdSchema,
  displayName: z.string(),
  kind: sourceKindSchema,
  description: z.string(),
  requiresApiKey: z.boolean().default(false),
  stable: z.boolean().default(true),
  capabilities: z.array(z.string()).default([]),
  rateLimit: z.object({
    requestsPerMinute: z.number().int().positive(),
    notes: z.string().optional()
  })
});
export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;

export const jobStatusSchema = z.enum(["queued", "running", "waiting-approval", "completed", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(["crawl", "python", "convert", "brief", "agent"]),
  status: jobStatusSchema,
  title: z.string(),
  progress: z.number().min(0).max(1).default(0),
  detail: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional()
});
export type Job = z.infer<typeof jobSchema>;

export const updateStateSchema = z.enum([
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "downloaded",
  "not-available",
  "failed"
]);
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updateStatusSchema = z.object({
  state: updateStateSchema,
  currentVersion: z.string(),
  availableVersion: z.string().optional(),
  downloadPercent: z.number().min(0).max(100).optional(),
  transferredBytes: z.number().nonnegative().optional(),
  totalBytes: z.number().nonnegative().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  lastCheckedAt: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  nextRetryAt: z.string().optional(),
  error: z.string().optional()
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const appSettingsSchema = z.object({
  ui: z
    .object({
      theme: z.enum(["system", "light", "dark"]).default("system")
    })
    .default({ theme: "system" }),
  ai: z.object({
    provider: z.enum(["ollama", "vercel", "openai-compatible"]).default("ollama"),
    baseUrl: z.string().url().default("http://127.0.0.1:11434"),
    model: z.string().default("gemma3:12b-it-qat"),
    hasApiKey: z.boolean().default(false),
    reasoningEnabled: z.boolean().default(true)
  }),
  python: z.object({
    runtimeMode: z.enum(["managed", "system", "bundled"]).default("managed"),
    executablePath: z.string().optional(),
    markitdownEnabled: z.boolean().default(true)
  }),
  sources: z
    .object({
      disabledSourceIds: z.array(sourceIdSchema).default([])
    })
    .default({ disabledSourceIds: [] })
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const aiProviderSchema = appSettingsSchema.shape.ai.shape.provider;
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const aiProviderCheckRequestSchema = z
  .object({
    provider: aiProviderSchema.optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional()
  })
  .optional();
export type AiProviderCheckRequest = z.infer<typeof aiProviderCheckRequestSchema>;

export const aiProviderHealthSchema = z.object({
  provider: aiProviderSchema,
  baseUrl: z.string(),
  model: z.string(),
  hasApiKey: z.boolean(),
  reachable: z.boolean(),
  status: z.enum(["ok", "warning", "error"]),
  checkedAt: z.string(),
  detail: z.string().optional(),
  models: z.array(z.string()).default([])
});
export type AiProviderHealth = z.infer<typeof aiProviderHealthSchema>;

export const chatRequestSchema = z.object({
  projectId: z.string().optional(),
  content: z.string().min(1),
  crawlConfig: crawlConfigSchema.partial().optional()
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const startChatRunRequestSchema = z.object({
  projectId: z.string(),
  conversationId: z.string(),
  content: z.string().trim().min(1),
  mode: chatModeSchema.optional(),
  sourceRefs: z.array(sourceRefSchema).max(50).default([])
});
export type StartChatRunRequest = z.infer<typeof startChatRunRequestSchema>;

export const startChatRunResponseSchema = z.object({
  runId: z.string(),
  userMessageId: z.string(),
  assistantMessageId: z.string()
});
export type StartChatRunResponse = z.infer<typeof startChatRunResponseSchema>;

export const chatRunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), runId: z.string(), status: chatRunStatusSchema }),
  z.object({ type: z.literal("delta"), runId: z.string(), text: z.string() }),
  z.object({ type: z.literal("trace"), runId: z.string(), step: chatTraceStepSchema }),
  z.object({
    type: z.literal("complete"),
    runId: z.string(),
    run: chatRunSchema,
    message: messageSchema,
    artifact: artifactSchema.optional(),
    citations: z.array(citationSchema)
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    error: z.string(),
    status: z.enum(["stopped", "failed"])
  })
]);
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;

export const chatResponseSchema = z.object({
  project: projectSchema,
  messages: z.array(messageSchema),
  jobs: z.array(jobSchema).default([]),
  artifacts: z.array(artifactSchema).default([])
});
export type ChatResponse = z.infer<typeof chatResponseSchema>;

export const credentialUpsertSchema = z.object({
  sourceId: sourceIdSchema.or(z.literal("ai-gateway")),
  label: z.string().default("default"),
  secret: z.string().min(1)
});
export type CredentialUpsert = z.infer<typeof credentialUpsertSchema>;

export const projectUpdateSchema = z.object({
  projectId: z.string(),
  title: z.string().trim().min(1).max(120).optional(),
  topic: z.string().trim().max(240).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal(""))
});
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;

export const artifactUpdateSchema = z.object({
  projectId: z.string(),
  artifactId: z.string(),
  title: z.string().trim().min(1).max(180).optional()
});
export type ArtifactUpdate = z.infer<typeof artifactUpdateSchema>;

export const paperUpdateSchema = z.object({
  projectId: z.string(),
  paperId: z.string(),
  patch: z.object({
    title: z.string().trim().min(1).max(500).optional(),
    abstract: z.string().optional(),
    authors: z.array(z.string()).optional(),
    year: z.number().int().min(1500).max(3000).optional(),
    publishedAt: z.string().optional(),
    doi: z.string().optional(),
    url: z.string().url().optional(),
    pdfUrl: z.string().url().optional(),
    venue: z.string().optional(),
    citationCount: z.number().int().nonnegative().optional(),
    isOpenAccess: z.boolean().optional(),
    license: z.string().optional(),
    fieldsOfStudy: z.array(z.string()).optional(),
    favorite: z.boolean().optional(),
    userStatus: paperUserStatusSchema.optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional()
  })
});
export type PaperUpdate = z.infer<typeof paperUpdateSchema>;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function paperDedupeKey(paper: Pick<Paper, "doi" | "title">): string {
  if (paper.doi) {
    return `doi:${paper.doi.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}`;
  }
  return `title:${normalizeTitle(paper.title)}`;
}
