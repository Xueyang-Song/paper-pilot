import type { z } from "zod";
import type { CrawlConfig, Paper, SourceDefinition } from "../../shared/schemas.js";

export interface SourceContext {
  signal?: AbortSignal;
  credentials: Record<string, string | undefined>;
  userAgent: string;
}

export interface CrawlResult {
  papers: Paper[];
  warnings: string[];
  provenance: Record<string, unknown>;
}

export interface SourceConnector {
  definition: SourceDefinition;
  credentialSchema: z.ZodTypeAny;
  crawlConfigSchema: z.ZodTypeAny;
  run(config: CrawlConfig, context: SourceContext): Promise<CrawlResult>;
}

export function emptyResult(provenance: Record<string, unknown> = {}, warnings: string[] = []): CrawlResult {
  return { papers: [], warnings, provenance };
}
