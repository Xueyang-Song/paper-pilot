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
  raw: z.record(z.string(), z.unknown()).optional()
});
export type Paper = z.infer<typeof paperSchema>;

export const artifactTypeSchema = z.enum([
  "metadata-json",
  "paper-pdf",
  "markdown",
  "crawl-log",
  "brief",
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
  createdAt: z.string(),
  updatedAt: z.string(),
  policy: projectPolicySchema
});
export type Project = z.infer<typeof projectSchema>;

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  role: messageRoleSchema,
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
});
export type Message = z.infer<typeof messageSchema>;

export const crawlConfigSchema = z.object({
  topic: z.string().min(1),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  maxPapers: z.number().int().positive().max(500).default(25),
  sourceIds: z.array(sourceIdSchema).default([
    "openalex",
    "crossref",
    "semantic-scholar",
    "arxiv",
    "europe-pmc",
    "pubmed"
  ]),
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

export const appSettingsSchema = z.object({
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
  })
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const chatRequestSchema = z.object({
  projectId: z.string().optional(),
  content: z.string().min(1),
  crawlConfig: crawlConfigSchema.partial().optional()
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

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
