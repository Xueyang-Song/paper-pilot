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

// Paper provenance includes file-based imports, while crawl configuration and
// source definitions intentionally remain limited to actual crawler sources.
export const paperSourceIdSchema = sourceIdSchema.or(z.literal("reference-import"));
export type PaperSourceId = z.infer<typeof paperSourceIdSchema>;

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
  source: paperSourceIdSchema,
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

export const aiModelInfoSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  modifiedAt: z.string().optional(),
  sizeBytes: z.number().nonnegative().optional(),
  family: z.string().optional(),
  parameterSize: z.string().optional(),
  quantizationLevel: z.string().optional()
});
export type AiModelInfo = z.infer<typeof aiModelInfoSchema>;

export const aiModelListRequestSchema = z.object({
  provider: aiProviderSchema,
  baseUrl: z.string().url()
});
export type AiModelListRequest = z.infer<typeof aiModelListRequestSchema>;

export const aiModelListSchema = z.object({
  provider: aiProviderSchema,
  baseUrl: z.string().url(),
  fetchedAt: z.string(),
  models: z.array(aiModelInfoSchema)
});
export type AiModelList = z.infer<typeof aiModelListSchema>;

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
  z.object({
    type: z.literal("status"),
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    assistantMessageId: z.string(),
    status: chatRunStatusSchema
  }),
  z.object({
    type: z.literal("delta"),
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    assistantMessageId: z.string(),
    text: z.string()
  }),
  z.object({
    type: z.literal("trace"),
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    assistantMessageId: z.string(),
    step: chatTraceStepSchema
  }),
  z.object({
    type: z.literal("complete"),
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    assistantMessageId: z.string(),
    run: chatRunSchema,
    message: messageSchema,
    artifact: artifactSchema.optional(),
    citations: z.array(citationSchema)
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    projectId: z.string(),
    conversationId: z.string(),
    assistantMessageId: z.string(),
    error: z.string(),
    status: z.enum(["stopped", "failed"])
  })
]);
export type ChatRunEvent = z.infer<typeof chatRunEventSchema>;

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

export const MAX_REFERENCE_IMPORT_BYTES = 50 * 1024 * 1024;
export const MAX_REFERENCE_IMPORT_RECORDS = 50_000;
export const MAX_EXTRACTION_FIELDS = 30;
export const MAX_REVIEW_BATCH_PAPERS = 25;

export const reviewTemplateSchema = z.enum(["blank", "general-empirical", "pico"]);
export type ReviewTemplate = z.infer<typeof reviewTemplateSchema>;

export const screeningStageSchema = z.enum(["title-abstract", "full-text"]);
export type ScreeningStage = z.infer<typeof screeningStageSchema>;

export const reviewStageSchema = z.enum(["title-abstract", "full-text", "extraction"]);
export type ReviewStage = z.infer<typeof reviewStageSchema>;

export const reviewCriterionTypeSchema = z.enum(["inclusion", "exclusion"]);
export type ReviewCriterionType = z.infer<typeof reviewCriterionTypeSchema>;

export const reviewCriterionSchema = z.object({
  id: z.string(),
  stage: screeningStageSchema,
  type: reviewCriterionTypeSchema,
  label: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2_000).optional(),
  order: z.number().int().nonnegative()
});
export type ReviewCriterion = z.infer<typeof reviewCriterionSchema>;

export const reviewProtocolRevisionSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  version: z.number().int().positive(),
  researchQuestion: z.string().trim().max(2_000),
  objectives: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  criteria: z.array(reviewCriterionSchema).max(100).default([]),
  changeNote: z.string().trim().max(2_000).optional(),
  createdAt: z.string()
});
export type ReviewProtocolRevision = z.infer<typeof reviewProtocolRevisionSchema>;

export const reviewProtocolSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  template: reviewTemplateSchema,
  currentRevisionId: z.string(),
  currentRevisionNumber: z.number().int().positive(),
  historicalCountsAvailable: z.boolean(),
  activatedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type ReviewProtocol = z.infer<typeof reviewProtocolSchema>;

export const discoveryBatchKindSchema = z.enum(["pre-existing", "reference-import", "crawl"]);
export type DiscoveryBatchKind = z.infer<typeof discoveryBatchKindSchema>;

export const discoveryBatchStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled"]);
export type DiscoveryBatchStatus = z.infer<typeof discoveryBatchStatusSchema>;

export const referenceImportFormatSchema = z.enum(["ris", "bibtex", "csv"]);
export type ReferenceImportFormat = z.infer<typeof referenceImportFormatSchema>;

export const discoveryBatchCountsSchema = z.object({
  identified: z.number().int().nonnegative().default(0),
  filtered: z.number().int().nonnegative().default(0),
  invalid: z.number().int().nonnegative().default(0),
  duplicates: z.number().int().nonnegative().default(0),
  merged: z.number().int().nonnegative().default(0),
  newRecords: z.number().int().nonnegative().default(0)
});
export type DiscoveryBatchCounts = z.infer<typeof discoveryBatchCountsSchema>;

export const discoveryBatchSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  kind: discoveryBatchKindSchema,
  label: z.string().trim().min(1).max(240),
  sourceId: sourceIdSchema.optional(),
  fileName: z.string().optional(),
  importFormat: referenceImportFormatSchema.optional(),
  status: discoveryBatchStatusSchema,
  counts: discoveryBatchCountsSchema,
  historicalCountsAvailable: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional()
});
export type DiscoveryBatch = z.infer<typeof discoveryBatchSchema>;

export const discoveryCandidateActionSchema = z.enum([
  "created",
  "duplicate",
  "merged",
  "kept-separate",
  "skipped",
  "invalid",
  "filtered"
]);
export type DiscoveryCandidateAction = z.infer<typeof discoveryCandidateActionSchema>;

export const discoveryCandidateSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  batchId: z.string(),
  paperId: z.string().optional(),
  sourceRecordId: z.string().optional(),
  title: z.string().optional(),
  doi: z.string().optional(),
  action: discoveryCandidateActionSchema,
  createdAt: z.string()
});
export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const screeningDecisionValueSchema = z.enum(["include", "exclude", "uncertain"]);
export type ScreeningDecisionValue = z.infer<typeof screeningDecisionValueSchema>;

const screeningDecisionShape = {
  reviewId: z.string(),
  paperId: z.string(),
  stage: screeningStageSchema,
  decision: screeningDecisionValueSchema,
  protocolRevisionId: z.string(),
  reasonCriterionId: z.string().optional(),
  customReason: z.string().trim().max(2_000).optional(),
  runItemId: z.string().optional()
};

function validateScreeningDecision(
  decision: {
    stage: ScreeningStage;
    decision: ScreeningDecisionValue;
    reasonCriterionId?: string;
    customReason?: string;
  },
  context: z.RefinementCtx
): void {
  if (
    decision.stage === "full-text" &&
    decision.decision === "exclude" &&
    !decision.reasonCriterionId &&
    !decision.customReason?.trim()
  ) {
    context.addIssue({
      code: "custom",
      path: ["customReason"],
      message: "Full-text exclusions require a criterion or custom reason"
    });
  }
}

export const screeningDecisionSchema = z
  .object({
    id: z.string(),
    ...screeningDecisionShape,
    previousDecisionId: z.string().optional(),
    createdAt: z.string()
  })
  .superRefine(validateScreeningDecision);
export type ScreeningDecision = z.infer<typeof screeningDecisionSchema>;

export const extractionFieldTypeSchema = z.enum([
  "short-text",
  "long-text",
  "number",
  "boolean",
  "single-select",
  "multi-select"
]);
export type ExtractionFieldType = z.infer<typeof extractionFieldTypeSchema>;

export const extractionFieldSchema = z
  .object({
    id: z.string(),
    reviewId: z.string(),
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().max(2_000).optional(),
    type: extractionFieldTypeSchema,
    options: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
    order: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    active: z.boolean().default(true),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .superRefine((field, context) => {
    const isSelect = field.type === "single-select" || field.type === "multi-select";
    if (isSelect && field.options.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select fields require at least one option"
      });
    }
    if (!isSelect && field.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only select fields may define options"
      });
    }
    if (new Set(field.options).size !== field.options.length) {
      context.addIssue({ code: "custom", path: ["options"], message: "Field options must be unique" });
    }
  });
export type ExtractionField = z.infer<typeof extractionFieldSchema>;

export const extractionPrimitiveValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null()
]);
export type ExtractionPrimitiveValue = z.infer<typeof extractionPrimitiveValueSchema>;

export function isBlankExtractionValue(value: ExtractionPrimitiveValue): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && !value.length)
  );
}

export const extractionValueStatusSchema = z.enum(["suggested", "confirmed", "rejected", "not-found", "needs-review"]);
export type ExtractionValueStatus = z.infer<typeof extractionValueStatusSchema>;

export const extractionValueOriginSchema = z.enum(["manual", "ai"]);
export type ExtractionValueOrigin = z.infer<typeof extractionValueOriginSchema>;

export const extractionValueSchema = z
  .object({
    id: z.string(),
    reviewId: z.string(),
    paperId: z.string(),
    fieldId: z.string(),
    fieldRevision: z.number().int().positive(),
    value: extractionPrimitiveValueSchema,
    status: extractionValueStatusSchema,
    origin: extractionValueOriginSchema,
    evidenceIds: z.array(z.string()).default([]),
    runItemId: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    confirmedAt: z.string().optional()
  })
  .superRefine((value, context) => {
    if (value.status === "not-found" && value.value !== null) {
      context.addIssue({ code: "custom", path: ["value"], message: "Not-found values must be null" });
    }
    if (value.status === "confirmed" && isBlankExtractionValue(value.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Confirmed extraction values cannot be blank; use Not found instead"
      });
    }
    if (value.origin === "ai" && value.status === "confirmed" && value.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Confirmed AI values require evidence"
      });
    }
  });
export type ExtractionValue = z.infer<typeof extractionValueSchema>;

export const reviewEvidenceSourceTypeSchema = z.enum(["paper-metadata", "paper-abstract", "artifact-chunk"]);
export type ReviewEvidenceSourceType = z.infer<typeof reviewEvidenceSourceTypeSchema>;

export const reviewEvidenceSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  evidenceId: z.string().trim().min(1),
  runId: z.string().optional(),
  runItemId: z.string().optional(),
  paperId: z.string().optional(),
  artifactId: z.string().optional(),
  chunkId: z.string().optional(),
  sourceType: reviewEvidenceSourceTypeSchema,
  title: z.string().trim().min(1),
  excerpt: z.string().trim().min(1),
  locator: z.string().optional(),
  page: z.number().int().positive().optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  retrievalScore: z.number().optional(),
  createdAt: z.string()
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const reviewDecisionStateSchema = screeningDecisionValueSchema.or(z.literal("pending"));
export type ReviewDecisionState = z.infer<typeof reviewDecisionStateSchema>;

export const reviewPaperExtractionProgressSchema = z.object({
  total: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative()
});
export type ReviewPaperExtractionProgress = z.infer<typeof reviewPaperExtractionProgressSchema>;

export const reviewPaperSummarySchema = z.object({
  reviewId: z.string(),
  paperId: z.string(),
  title: z.string(),
  authors: z.array(z.string()).default([]),
  abstract: z.string().optional(),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  source: paperSourceIdSchema,
  discoveryBatchIds: z.array(z.string()).default([]),
  hasFullText: z.boolean(),
  titleAbstractDecision: screeningDecisionSchema.optional(),
  fullTextDecision: screeningDecisionSchema.optional(),
  extractionProgress: reviewPaperExtractionProgressSchema,
  needsReReview: z.boolean().default(false),
  aiSuggestionStale: z.boolean().default(false)
});
export type ReviewPaperSummary = z.infer<typeof reviewPaperSummarySchema>;

export const reviewPaperSchema = reviewPaperSummarySchema.extend({
  paper: paperSchema
});
export type ReviewPaper = z.infer<typeof reviewPaperSchema>;

export const reviewFullTextFilterSchema = z.enum(["any", "available", "missing"]);
export type ReviewFullTextFilter = z.infer<typeof reviewFullTextFilterSchema>;

export const reviewPaperQuerySchema = z
  .object({
    reviewId: z.string(),
    stage: reviewStageSchema.default("title-abstract"),
    search: z.string().trim().max(500).optional(),
    sources: z.array(paperSourceIdSchema).default([]),
    yearFrom: z.number().int().min(1500).max(3000).optional(),
    yearTo: z.number().int().min(1500).max(3000).optional(),
    decisions: z.array(reviewDecisionStateSchema).default([]),
    fullText: reviewFullTextFilterSchema.default("any"),
    needsReReview: z.boolean().optional(),
    sort: z.enum(["title", "year", "created"]).default("created"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    page: z.number().int().positive().default(1),
    pageSize: z.number().int().positive().max(100).default(25)
  })
  .refine((query) => query.yearFrom === undefined || query.yearTo === undefined || query.yearFrom <= query.yearTo, {
    path: ["yearTo"],
    message: "yearTo must be greater than or equal to yearFrom"
  });
export type ReviewPaperQuery = z.infer<typeof reviewPaperQuerySchema>;

export const reviewPaperPageSchema = z.object({
  items: z.array(reviewPaperSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  totalPages: z.number().int().nonnegative(),
  counts: z.object({
    pending: z.number().int().nonnegative(),
    include: z.number().int().nonnegative(),
    exclude: z.number().int().nonnegative(),
    uncertain: z.number().int().nonnegative()
  })
});
export type ReviewPaperPage = z.infer<typeof reviewPaperPageSchema>;

export const reviewRunStageSchema = reviewStageSchema;
export type ReviewRunStage = z.infer<typeof reviewRunStageSchema>;

export const reviewRunStatusSchema = z.enum(["queued", "running", "completed", "partial", "cancelled", "failed"]);
export type ReviewRunStatus = z.infer<typeof reviewRunStatusSchema>;

export const reviewRunItemStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);
export type ReviewRunItemStatus = z.infer<typeof reviewRunItemStatusSchema>;

export const reviewExtractionSuggestionSchema = z
  .object({
    fieldId: z.string(),
    value: extractionPrimitiveValueSchema,
    status: z.enum(["suggested", "not-found", "needs-review"]),
    evidenceIds: z.array(z.string()).default([]),
    rationale: z.string().optional()
  })
  .superRefine((suggestion, context) => {
    if (suggestion.status === "suggested" && isBlankExtractionValue(suggestion.value)) {
      context.addIssue({ code: "custom", path: ["value"], message: "Suggested values cannot be blank" });
    }
    if (suggestion.status === "suggested" && !suggestion.evidenceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Suggested AI values require evidence"
      });
    }
    if (suggestion.status !== "suggested" && suggestion.value !== null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Not-found and unclear suggestions cannot contain a value"
      });
    }
  });
export type ReviewExtractionSuggestion = z.infer<typeof reviewExtractionSuggestionSchema>;

export const reviewCriterionAssessmentSchema = z.object({
  criterionId: z.string(),
  assessment: z.enum(["met", "not-met", "unclear"]),
  explanation: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.string()).max(12).default([])
});
export type ReviewCriterionAssessment = z.infer<typeof reviewCriterionAssessmentSchema>;

export const reviewRunItemSchema = z.object({
  id: z.string(),
  runId: z.string(),
  paperId: z.string(),
  status: reviewRunItemStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  suggestedDecision: screeningDecisionValueSchema.optional(),
  suggestedReasonCriterionId: z.string().optional(),
  suggestedCustomReason: z.string().optional(),
  rationale: z.string().optional(),
  criterionAssessments: z.array(reviewCriterionAssessmentSchema).default([]),
  extractionSuggestions: z.array(reviewExtractionSuggestionSchema).default([]),
  evidence: z.array(reviewEvidenceSchema).default([]),
  stale: z.boolean().default(false),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});
export type ReviewRunItem = z.infer<typeof reviewRunItemSchema>;

export const reviewRunSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  stage: reviewRunStageSchema,
  provider: aiProviderSchema,
  model: z.string().trim().min(1),
  protocolRevisionId: z.string(),
  status: reviewRunStatusSchema,
  paperIds: z.array(z.string()).min(1).max(MAX_REVIEW_BATCH_PAPERS),
  fieldIds: z.array(z.string()).max(MAX_EXTRACTION_FIELDS).default([]),
  completedCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  cancelledCount: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

export const reviewRunEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    runId: z.string(),
    reviewId: z.string(),
    status: reviewRunStatusSchema
  }),
  z.object({
    type: z.literal("progress"),
    runId: z.string(),
    reviewId: z.string(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    currentPaperId: z.string().optional()
  }),
  z.object({
    type: z.literal("item"),
    runId: z.string(),
    reviewId: z.string(),
    item: reviewRunItemSchema
  }),
  z.object({
    type: z.literal("complete"),
    runId: z.string(),
    reviewId: z.string(),
    run: reviewRunSchema
  }),
  z.object({
    type: z.literal("error"),
    runId: z.string(),
    reviewId: z.string(),
    error: z.string(),
    status: z.enum(["cancelled", "failed"])
  })
]);
export type ReviewRunEvent = z.infer<typeof reviewRunEventSchema>;

export const reviewAuditEventKindSchema = z.enum([
  "review-activated",
  "protocol-revised",
  "decision-recorded",
  "decision-marked-for-review",
  "extraction-field-created",
  "extraction-field-revised",
  "extraction-value-confirmed",
  "extraction-value-rejected",
  "extraction-value-not-found",
  "import-committed",
  "run-started",
  "run-cancelled",
  "run-completed",
  "paper-pdf-attached"
]);
export type ReviewAuditEventKind = z.infer<typeof reviewAuditEventKindSchema>;

export const reviewAuditEventSchema = z.object({
  id: z.string(),
  reviewId: z.string(),
  kind: reviewAuditEventKindSchema,
  actor: z.enum(["user", "system", "ai"]),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type ReviewAuditEvent = z.infer<typeof reviewAuditEventSchema>;

export const reviewExtractionCompletionSchema = z.object({
  totalCells: z.number().int().nonnegative(),
  confirmedCells: z.number().int().nonnegative(),
  notFoundCells: z.number().int().nonnegative(),
  needsReviewCells: z.number().int().nonnegative(),
  completionPercent: z.number().min(0).max(100)
});
export type ReviewExtractionCompletion = z.infer<typeof reviewExtractionCompletionSchema>;

export const reviewFlowSummarySchema = z.object({
  reviewId: z.string(),
  identifiedRecords: z.number().int().nonnegative(),
  filteredRecords: z.number().int().nonnegative(),
  invalidRecords: z.number().int().nonnegative(),
  duplicateRecords: z.number().int().nonnegative(),
  mergedRecords: z.number().int().nonnegative(),
  newRecords: z.number().int().nonnegative(),
  uniqueRecordsScreened: z.number().int().nonnegative(),
  titleAbstractExclusions: z.number().int().nonnegative(),
  fullTextsSought: z.number().int().nonnegative(),
  fullTextsUnavailable: z.number().int().nonnegative(),
  fullTextExclusionsByReason: z.record(z.string(), z.number().int().nonnegative()),
  includedPapers: z.number().int().nonnegative(),
  extraction: reviewExtractionCompletionSchema,
  historicalCountsAvailable: z.boolean(),
  warnings: z.array(z.string()).default([]),
  generatedAt: z.string()
});
export type ReviewFlowSummary = z.infer<typeof reviewFlowSummarySchema>;

export const referenceRecordSchema = z.object({
  title: z.string().trim().min(1).max(2_000),
  authors: z.array(z.string().trim().min(1)).default([]),
  abstract: z.string().optional(),
  year: z.number().int().min(1500).max(3000).optional(),
  doi: z.string().optional(),
  url: z.string().url().optional(),
  pdfUrl: z.string().url().optional(),
  venue: z.string().optional(),
  sourceId: z.string().optional(),
  sourceAuthority: z.string().optional(),
  citationCount: z.number().int().nonnegative().optional()
});
export type ReferenceRecord = z.infer<typeof referenceRecordSchema>;

export const referenceImportFieldSchema = z.enum([
  "title",
  "authors",
  "abstract",
  "year",
  "doi",
  "url",
  "pdfUrl",
  "venue",
  "sourceId",
  "sourceAuthority",
  "citationCount"
]);
export type ReferenceImportField = z.infer<typeof referenceImportFieldSchema>;

export const referenceImportMappingSchema = z.object({
  title: z.string().min(1),
  authors: z.string().optional(),
  abstract: z.string().optional(),
  year: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  pdfUrl: z.string().optional(),
  venue: z.string().optional(),
  sourceId: z.string().optional(),
  sourceAuthority: z.string().optional(),
  citationCount: z.string().optional()
});
export type ReferenceImportMapping = z.infer<typeof referenceImportMappingSchema>;

export const referenceImportMatchSchema = z.object({
  kind: z.enum(["none", "exact", "ambiguous"]),
  matchedBy: z.enum(["doi", "source-id", "fingerprint"]).optional(),
  paperId: z.string().optional(),
  candidatePaperIds: z.array(z.string()).default([])
});
export type ReferenceImportMatch = z.infer<typeof referenceImportMatchSchema>;

export const referenceImportPreviewItemSchema = z.object({
  recordIndex: z.number().int().nonnegative(),
  record: referenceRecordSchema.optional(),
  rawTitle: z.string().optional(),
  valid: z.boolean(),
  errors: z.array(z.string()).default([]),
  match: referenceImportMatchSchema
});
export type ReferenceImportPreviewItem = z.infer<typeof referenceImportPreviewItemSchema>;

export const referenceImportPreviewRequestSchema = z.object({
  projectId: z.string(),
  reviewId: z.string(),
  format: referenceImportFormatSchema.optional()
});
export type ReferenceImportPreviewRequest = z.infer<typeof referenceImportPreviewRequestSchema>;

export const referenceImportPreviewSchema = z.object({
  previewId: z.string(),
  projectId: z.string(),
  reviewId: z.string(),
  fileName: z.string(),
  format: referenceImportFormatSchema,
  sizeBytes: z.number().int().nonnegative().max(MAX_REFERENCE_IMPORT_BYTES),
  totalRecords: z.number().int().nonnegative().max(MAX_REFERENCE_IMPORT_RECORDS),
  validRecords: z.number().int().nonnegative(),
  invalidRecords: z.number().int().nonnegative(),
  columns: z.array(z.string()).default([]),
  suggestedMapping: referenceImportMappingSchema.partial().optional(),
  items: z.array(referenceImportPreviewItemSchema),
  warnings: z.array(z.string()).default([])
});
export type ReferenceImportPreview = z.infer<typeof referenceImportPreviewSchema>;

export const referenceImportResolutionSchema = z
  .object({
    recordIndex: z.number().int().nonnegative(),
    action: z.enum(["keep-separate", "merge", "skip"]),
    paperId: z.string().optional()
  })
  .refine((resolution) => resolution.action !== "merge" || Boolean(resolution.paperId), {
    path: ["paperId"],
    message: "Merge resolutions require a paper ID"
  });
export type ReferenceImportResolution = z.infer<typeof referenceImportResolutionSchema>;

export const referenceImportCommitRequestSchema = z.object({
  projectId: z.string(),
  reviewId: z.string(),
  previewId: z.string(),
  mapping: referenceImportMappingSchema.optional(),
  resolutions: z.array(referenceImportResolutionSchema).max(MAX_REFERENCE_IMPORT_RECORDS).default([])
});
export type ReferenceImportCommitRequest = z.infer<typeof referenceImportCommitRequestSchema>;

export const referenceImportCommitResponseSchema = z.object({
  batch: discoveryBatchSchema,
  counts: discoveryBatchCountsSchema
});
export type ReferenceImportCommitResponse = z.infer<typeof referenceImportCommitResponseSchema>;

export const activateReviewRequestSchema = z.object({
  projectId: z.string(),
  template: reviewTemplateSchema.default("blank"),
  researchQuestion: z.string().trim().max(2_000).default(""),
  objectives: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  criteria: z.array(reviewCriterionSchema).max(100).default([])
});
export type ActivateReviewRequest = z.infer<typeof activateReviewRequestSchema>;

export const reviseReviewProtocolRequestSchema = z.object({
  reviewId: z.string(),
  expectedVersion: z.number().int().positive(),
  researchQuestion: z.string().trim().max(2_000),
  objectives: z.array(z.string().trim().min(1).max(1_000)).max(50).default([]),
  criteria: z.array(reviewCriterionSchema).max(100).default([]),
  changeNote: z.string().trim().max(2_000).optional()
});
export type ReviseReviewProtocolRequest = z.infer<typeof reviseReviewProtocolRequestSchema>;

export const saveScreeningDecisionRequestSchema = z
  .object(screeningDecisionShape)
  .superRefine(validateScreeningDecision);
export type SaveScreeningDecisionRequest = z.infer<typeof saveScreeningDecisionRequestSchema>;

export const markReviewPapersForReviewRequestSchema = z.object({
  reviewId: z.string(),
  paperIds: z.array(z.string()).min(1).max(500),
  stage: screeningStageSchema.optional()
});
export type MarkReviewPapersForReviewRequest = z.infer<typeof markReviewPapersForReviewRequestSchema>;

export const upsertExtractionFieldRequestSchema = z
  .object({
    reviewId: z.string(),
    fieldId: z.string().optional(),
    expectedRevision: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(240),
    description: z.string().trim().max(2_000).optional(),
    type: extractionFieldTypeSchema,
    options: z.array(z.string().trim().min(1).max(240)).max(100).default([]),
    order: z.number().int().nonnegative()
  })
  .superRefine((field, context) => {
    const isSelect = field.type === "single-select" || field.type === "multi-select";
    if (isSelect && field.options.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select fields require at least one option"
      });
    }
    if (!isSelect && field.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only select fields may define options"
      });
    }
  });
export type UpsertExtractionFieldRequest = z.infer<typeof upsertExtractionFieldRequestSchema>;

export const reorderExtractionFieldsRequestSchema = z.object({
  reviewId: z.string(),
  fieldIds: z.array(z.string()).max(MAX_EXTRACTION_FIELDS)
});
export type ReorderExtractionFieldsRequest = z.infer<typeof reorderExtractionFieldsRequestSchema>;

export const saveExtractionValueRequestSchema = z
  .object({
    reviewId: z.string(),
    paperId: z.string(),
    fieldId: z.string(),
    expectedFieldRevision: z.number().int().positive(),
    value: extractionPrimitiveValueSchema,
    status: z.enum(["confirmed", "rejected", "not-found", "needs-review"]),
    evidenceIds: z.array(z.string()).default([])
  })
  .superRefine((value, context) => {
    if (value.status === "not-found" && value.value !== null) {
      context.addIssue({ code: "custom", path: ["value"], message: "Not-found values must be null" });
    }
    if (value.status === "confirmed" && isBlankExtractionValue(value.value)) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Confirmed extraction values cannot be blank; use Not found instead"
      });
    }
  });
export type SaveExtractionValueRequest = z.infer<typeof saveExtractionValueRequestSchema>;

export const startReviewRunRequestSchema = z.object({
  reviewId: z.string(),
  stage: reviewRunStageSchema,
  paperIds: z.array(z.string()).min(1).max(MAX_REVIEW_BATCH_PAPERS),
  fieldIds: z.array(z.string()).max(MAX_EXTRACTION_FIELDS).optional()
});
export type StartReviewRunRequest = z.infer<typeof startReviewRunRequestSchema>;

export const cancelReviewRunRequestSchema = z.object({ runId: z.string() });
export type CancelReviewRunRequest = z.infer<typeof cancelReviewRunRequestSchema>;

export const retryReviewRunRequestSchema = z.object({ runId: z.string() });
export type RetryReviewRunRequest = z.infer<typeof retryReviewRunRequestSchema>;

export const fetchReviewPaperFullTextRequestSchema = z.object({
  projectId: z.string(),
  reviewId: z.string(),
  paperId: z.string()
});
export type FetchReviewPaperFullTextRequest = z.infer<typeof fetchReviewPaperFullTextRequestSchema>;

export const attachReviewPaperPdfRequestSchema = fetchReviewPaperFullTextRequestSchema;
export type AttachReviewPaperPdfRequest = z.infer<typeof attachReviewPaperPdfRequestSchema>;

export const getReviewSummaryRequestSchema = z.object({ reviewId: z.string() });
export type GetReviewSummaryRequest = z.infer<typeof getReviewSummaryRequestSchema>;

export const exportReviewRequestSchema = z.object({ reviewId: z.string() });
export type ExportReviewRequest = z.infer<typeof exportReviewRequestSchema>;

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
