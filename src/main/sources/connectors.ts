import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { type CrawlConfig, type Paper, type SourceDefinition, sourceDefinitionSchema } from "../../shared/schemas.js";
import { id } from "../utils.js";
import { cleanDoi, firstString, getJson, getText, yearFromDate } from "./http.js";
import type { CrawlResult, SourceConnector } from "./types.js";
import { emptyResult } from "./types.js";

const emptyCredentialSchema = z.object({}).passthrough();
const apiKeyCredentialSchema = z.object({ apiKey: z.string().min(1).optional() }).passthrough();

function definition(input: SourceDefinition): SourceDefinition {
  return sourceDefinitionSchema.parse(input);
}

function limit(config: CrawlConfig): number {
  return Math.max(1, Math.min(config.maxPapers, 100));
}

function dateRangeFilter(config: CrawlConfig, fromKey: string, toKey: string): string | undefined {
  const filters = [
    config.dateFrom ? `${fromKey}:${config.dateFrom}` : undefined,
    config.dateTo ? `${toKey}:${config.dateTo}` : undefined
  ].filter(Boolean);
  return filters.length ? filters.join(",") : undefined;
}

export const openAlexConnector: SourceConnector = {
  definition: definition({
    id: "openalex",
    displayName: "OpenAlex",
    kind: "api",
    description: "Open scholarly graph covering works, authors, institutions, venues, topics, and OA metadata.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "open-access", "citations", "topics"],
    rateLimit: { requestsPerMinute: 60, notes: "Free API keys raise limits; polite mailto recommended." }
  }),
  credentialSchema: apiKeyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", config.topic);
    url.searchParams.set("per-page", String(limit(config)));
    url.searchParams.set(
      "select",
      [
        "id",
        "doi",
        "display_name",
        "publication_year",
        "publication_date",
        "authorships",
        "primary_location",
        "open_access",
        "cited_by_count",
        "abstract_inverted_index",
        "topics",
        "primary_topic"
      ].join(",")
    );
    if (config.sort === "newest") url.searchParams.set("sort", "publication_date:desc");
    if (config.sort === "cited") url.searchParams.set("sort", "cited_by_count:desc");
    const filters = [
      config.openAccessOnly ? "is_oa:true" : undefined,
      config.dateFrom ? `from_publication_date:${config.dateFrom}` : undefined,
      config.dateTo ? `to_publication_date:${config.dateTo}` : undefined
    ].filter(Boolean);
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    if (context.credentials["openalex"]) url.searchParams.set("api_key", context.credentials["openalex"] ?? "");
    const data = await getJson<{ results?: unknown[] }>(url, { signal: context.signal });
    return {
      papers: (data.results ?? []).map((item) => normalizeOpenAlex(item)).filter(Boolean) as Paper[],
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeOpenAlex(item: unknown): Paper | undefined {
  const row = item as Record<string, unknown>;
  const title = firstString(row.display_name);
  if (!title) return undefined;
  const primaryLocation = row.primary_location as Record<string, unknown> | undefined;
  const openAccess = row.open_access as Record<string, unknown> | undefined;
  const authorships = Array.isArray(row.authorships) ? row.authorships : [];
  const authors = authorships
    .map((authorship) => firstString((authorship as Record<string, { display_name?: unknown }>).author?.display_name))
    .filter(Boolean) as string[];
  const inverted = row.abstract_inverted_index as Record<string, number[]> | undefined;
  return {
    id: id("paper"),
    title,
    authors,
    abstract: inverted ? invertAbstract(inverted) : undefined,
    year: typeof row.publication_year === "number" ? row.publication_year : undefined,
    publishedAt: firstString(row.publication_date),
    doi: cleanDoi(row.doi),
    url: firstString(row.id),
    pdfUrl: firstString((primaryLocation?.pdf_url as string | undefined) ?? openAccess?.oa_url),
    source: "openalex",
    sourcePaperId: firstString(row.id),
    venue: firstString((primaryLocation?.source as Record<string, unknown> | undefined)?.display_name),
    citationCount: typeof row.cited_by_count === "number" ? row.cited_by_count : undefined,
    isOpenAccess: Boolean(openAccess?.is_oa),
    license: firstString(primaryLocation?.license),
    fieldsOfStudy: collectOpenAlexTopics(row),
    raw: row
  };
}

function invertAbstract(index: Record<string, number[]>): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return words.filter(Boolean).join(" ");
}

function collectOpenAlexTopics(row: Record<string, unknown>): string[] {
  const primary = firstString((row.primary_topic as Record<string, unknown> | undefined)?.display_name);
  const topics = Array.isArray(row.topics)
    ? row.topics.map((topic) => firstString((topic as Record<string, unknown>).display_name)).filter(Boolean)
    : [];
  return Array.from(new Set([primary, ...topics].filter(Boolean) as string[]));
}

export const crossrefConnector: SourceConnector = {
  definition: definition({
    id: "crossref",
    displayName: "Crossref",
    kind: "api",
    description: "Publisher-deposited DOI metadata with funder, license, update, and bibliographic fields.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "doi", "licenses"],
    rateLimit: { requestsPerMinute: 50, notes: "Use polite pool by configuring a contact email when possible." }
  }),
  credentialSchema: z.object({ mailto: z.string().email().optional() }).passthrough(),
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const url = new URL("https://api.crossref.org/works");
    url.searchParams.set("query", config.topic);
    url.searchParams.set("rows", String(limit(config)));
    if (config.sort === "newest") {
      url.searchParams.set("sort", "published");
      url.searchParams.set("order", "desc");
    }
    if (config.sort === "cited") {
      url.searchParams.set("sort", "is-referenced-by-count");
      url.searchParams.set("order", "desc");
    }
    const filters = [
      dateRangeFilter(config, "from-pub-date", "until-pub-date"),
      config.openAccessOnly ? "has-license:true" : undefined
    ].filter(Boolean);
    if (filters.length) url.searchParams.set("filter", filters.join(","));
    if (context.credentials["crossref"]) url.searchParams.set("mailto", context.credentials["crossref"] ?? "");
    const data = await getJson<{ message?: { items?: unknown[] } }>(url, { signal: context.signal });
    return {
      papers: (data.message?.items ?? []).map((item) => normalizeCrossref(item)).filter(Boolean) as Paper[],
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeCrossref(item: unknown): Paper | undefined {
  const row = item as Record<string, unknown>;
  const title = firstString(row.title);
  if (!title) return undefined;
  const authors = Array.isArray(row.author)
    ? row.author
        .map((author) => {
          const authorRow = author as Record<string, unknown>;
          return [firstString(authorRow.given), firstString(authorRow.family)].filter(Boolean).join(" ");
        })
        .filter(Boolean)
    : [];
  const license = Array.isArray(row.license) ? (row.license[0] as Record<string, unknown> | undefined) : undefined;
  const published = row.published as { "date-parts"?: number[][] } | undefined;
  const year = published?.["date-parts"]?.[0]?.[0];
  return {
    id: id("paper"),
    title,
    abstract: firstString(row.abstract)?.replace(/<\/?jats:[^>]+>/g, ""),
    authors,
    year,
    publishedAt: Array.isArray(published?.["date-parts"]?.[0]) ? published?.["date-parts"]?.[0]?.join("-") : undefined,
    doi: cleanDoi(row.DOI),
    url: firstString(row.URL),
    source: "crossref",
    sourcePaperId: cleanDoi(row.DOI),
    venue: firstString(row["container-title"]),
    citationCount: typeof row["is-referenced-by-count"] === "number" ? row["is-referenced-by-count"] : undefined,
    isOpenAccess: Boolean(license),
    license: firstString(license?.URL),
    fieldsOfStudy: [],
    raw: row
  };
}

export const semanticScholarConnector: SourceConnector = {
  definition: definition({
    id: "semantic-scholar",
    displayName: "Semantic Scholar",
    kind: "api",
    description: "AI2 scholarly graph with abstracts, citations, fields of study, recommendations, and PDF URLs.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "open-access", "citations", "fields"],
    rateLimit: { requestsPerMinute: 30, notes: "Unauthenticated access is shared and may throttle during heavy use." }
  }),
  credentialSchema: apiKeyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", config.topic);
    url.searchParams.set("limit", String(limit(config)));
    url.searchParams.set(
      "fields",
      "paperId,title,abstract,authors,year,publicationDate,venue,url,openAccessPdf,citationCount,fieldsOfStudy,externalIds,isOpenAccess"
    );
    const headers: Record<string, string> = {};
    if (context.credentials["semantic-scholar"]) headers["x-api-key"] = context.credentials["semantic-scholar"] ?? "";
    const data = await getJson<{ data?: unknown[] }>(url, { signal: context.signal, headers });
    const papers = (data.data ?? []).map((item) => normalizeSemanticScholar(item)).filter(Boolean) as Paper[];
    return {
      papers: config.openAccessOnly ? papers.filter((paper) => paper.isOpenAccess || paper.pdfUrl) : papers,
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeSemanticScholar(item: unknown): Paper | undefined {
  const row = item as Record<string, unknown>;
  const title = firstString(row.title);
  if (!title) return undefined;
  const externalIds = row.externalIds as Record<string, unknown> | undefined;
  return {
    id: id("paper"),
    title,
    abstract: firstString(row.abstract),
    authors: Array.isArray(row.authors)
      ? (row.authors.map((author) => firstString((author as Record<string, unknown>).name)).filter(Boolean) as string[])
      : [],
    year: typeof row.year === "number" ? row.year : undefined,
    publishedAt: firstString(row.publicationDate),
    doi: cleanDoi(externalIds?.DOI),
    url: firstString(row.url),
    pdfUrl: firstString((row.openAccessPdf as Record<string, unknown> | undefined)?.url),
    source: "semantic-scholar",
    sourcePaperId: firstString(row.paperId),
    venue: firstString(row.venue),
    citationCount: typeof row.citationCount === "number" ? row.citationCount : undefined,
    isOpenAccess: Boolean(row.isOpenAccess) || Boolean((row.openAccessPdf as Record<string, unknown> | undefined)?.url),
    fieldsOfStudy: Array.isArray(row.fieldsOfStudy) ? (row.fieldsOfStudy.filter(Boolean) as string[]) : [],
    raw: row
  };
}

export const pubmedConnector: SourceConnector = {
  definition: definition({
    id: "pubmed",
    displayName: "PubMed / PMC",
    kind: "api",
    description: "NCBI biomedical and life-sciences literature through E-utilities.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "biomedical", "pmc"],
    rateLimit: { requestsPerMinute: 180, notes: "API keys increase NCBI rate limits." }
  }),
  credentialSchema: apiKeyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const search = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
    search.searchParams.set("db", "pubmed");
    search.searchParams.set("term", config.topic);
    search.searchParams.set("retmode", "json");
    search.searchParams.set("retmax", String(limit(config)));
    if (config.sort === "newest") search.searchParams.set("sort", "pub date");
    if (context.credentials.pubmed) search.searchParams.set("api_key", context.credentials.pubmed);
    if (config.dateFrom || config.dateTo) {
      search.searchParams.set("datetype", "pdat");
      if (config.dateFrom) search.searchParams.set("mindate", config.dateFrom);
      if (config.dateTo) search.searchParams.set("maxdate", config.dateTo);
    }
    const searchData = await getJson<{ esearchresult?: { idlist?: string[] } }>(search, { signal: context.signal });
    const ids = searchData.esearchresult?.idlist ?? [];
    if (!ids.length) return emptyResult({ url: search.toString() });
    const summary = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi");
    summary.searchParams.set("db", "pubmed");
    summary.searchParams.set("retmode", "json");
    summary.searchParams.set("id", ids.join(","));
    if (context.credentials.pubmed) summary.searchParams.set("api_key", context.credentials.pubmed);
    const summaryData = await getJson<{ result?: Record<string, unknown> & { uids?: string[] } }>(summary, {
      signal: context.signal
    });
    const papers = (summaryData.result?.uids ?? [])
      .map((uid) => normalizePubMed(uid, summaryData.result?.[uid]))
      .filter(Boolean) as Paper[];
    return {
      papers: config.openAccessOnly ? papers.filter((paper) => paper.isOpenAccess) : papers,
      warnings: config.openAccessOnly
        ? ["PubMed metadata does not always expose OA status; PMC-linked papers are retained."]
        : [],
      provenance: { searchUrl: search.toString(), summaryUrl: summary.toString() }
    };
  }
};

function normalizePubMed(uid: string, item: unknown): Paper | undefined {
  const row = item as Record<string, unknown> | undefined;
  const title = firstString(row?.title);
  if (!row || !title) return undefined;
  const articleIds = Array.isArray(row.articleids) ? row.articleids : [];
  const doi = articleIds.find((entry) => (entry as Record<string, unknown>).idtype === "doi") as
    Record<string, unknown> | undefined;
  const pmc = articleIds.find((entry) => (entry as Record<string, unknown>).idtype === "pmc") as
    Record<string, unknown> | undefined;
  return {
    id: id("paper"),
    title,
    authors: Array.isArray(row.authors)
      ? (row.authors.map((author) => firstString((author as Record<string, unknown>).name)).filter(Boolean) as string[])
      : [],
    year: yearFromDate(row.pubdate),
    publishedAt: firstString(row.pubdate),
    doi: cleanDoi(doi?.value),
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    pdfUrl: pmc?.value ? `https://pmc.ncbi.nlm.nih.gov/articles/${firstString(pmc.value)}/pdf/` : undefined,
    source: "pubmed",
    sourcePaperId: uid,
    venue: firstString(row.fulljournalname) ?? firstString(row.source),
    isOpenAccess: Boolean(pmc?.value),
    fieldsOfStudy: ["Biomedical"],
    raw: row
  };
}

export const arxivConnector: SourceConnector = {
  definition: definition({
    id: "arxiv",
    displayName: "arXiv",
    kind: "api",
    description: "Preprint metadata and PDFs from arXiv's Atom API.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "preprints", "pdf"],
    rateLimit: { requestsPerMinute: 20, notes: "arXiv asks API clients to include delays between repeated requests." }
  }),
  credentialSchema: emptyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${config.topic}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.min(limit(config), 50)));
    url.searchParams.set("sortBy", config.sort === "newest" ? "submittedDate" : "relevance");
    url.searchParams.set("sortOrder", "descending");
    const xml = await getText(url, { signal: context.signal });
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const feed = parser.parse(xml) as { feed?: { entry?: unknown[] | unknown } };
    const entries = Array.isArray(feed.feed?.entry) ? feed.feed.entry : feed.feed?.entry ? [feed.feed.entry] : [];
    return {
      papers: entries.map((entry) => normalizeArxiv(entry)).filter(Boolean) as Paper[],
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeArxiv(entry: unknown): Paper | undefined {
  const row = entry as Record<string, unknown>;
  const title = firstString(row.title)?.replace(/\s+/g, " ");
  if (!title) return undefined;
  const links = Array.isArray(row.link)
    ? (row.link as Record<string, unknown>[])
    : row.link
      ? [row.link as Record<string, unknown>]
      : [];
  const abstractUrl = firstString(row.id);
  const pdf = links.find((link) => link.title === "pdf" || String(link.type).includes("pdf"));
  return {
    id: id("paper"),
    title,
    abstract: firstString(row.summary)?.replace(/\s+/g, " "),
    authors: Array.isArray(row.author)
      ? (row.author.map((author) => firstString((author as Record<string, unknown>).name)).filter(Boolean) as string[])
      : ([firstString((row.author as Record<string, unknown> | undefined)?.name)].filter(Boolean) as string[]),
    year: yearFromDate(row.published),
    publishedAt: firstString(row.published),
    doi: cleanDoi((row["arxiv:doi"] as Record<string, unknown> | undefined)?.["#text"] ?? row["arxiv:doi"]),
    url: abstractUrl,
    pdfUrl: firstString(pdf?.href),
    source: "arxiv",
    sourcePaperId: abstractUrl?.split("/").pop(),
    isOpenAccess: true,
    license: firstString((row["arxiv:license"] as Record<string, unknown> | undefined)?.href),
    fieldsOfStudy: Array.isArray(row.category)
      ? (row.category
          .map((category) => firstString((category as Record<string, unknown>).term))
          .filter(Boolean) as string[])
      : ([firstString((row.category as Record<string, unknown> | undefined)?.term)].filter(Boolean) as string[]),
    raw: row
  };
}

export const europePmcConnector: SourceConnector = {
  definition: definition({
    id: "europe-pmc",
    displayName: "Europe PMC",
    kind: "api",
    description: "Life-sciences publications, preprints, metadata, and open full-text links.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["metadata", "open-access", "full-text-links"],
    rateLimit: { requestsPerMinute: 60 }
  }),
  credentialSchema: emptyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
    const dateClause =
      config.dateFrom || config.dateTo
        ? ` AND FIRST_PDATE:[${config.dateFrom ?? "1900-01-01"} TO ${config.dateTo ?? "3000-01-01"}]`
        : "";
    const oaClause = config.openAccessOnly ? " AND OPEN_ACCESS:y" : "";
    url.searchParams.set("query", `${config.topic}${dateClause}${oaClause}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("pageSize", String(limit(config)));
    url.searchParams.set("sort", config.sort === "newest" ? "FIRST_PDATE desc" : "RELEVANCE");
    const data = await getJson<{ resultList?: { result?: unknown[] } }>(url, { signal: context.signal });
    return {
      papers: (data.resultList?.result ?? []).map((item) => normalizeEuropePmc(item)).filter(Boolean) as Paper[],
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeEuropePmc(item: unknown): Paper | undefined {
  const row = item as Record<string, unknown>;
  const title = firstString(row.title);
  if (!title) return undefined;
  const pmcid = firstString(row.pmcid);
  return {
    id: id("paper"),
    title,
    abstract: firstString(row.abstractText),
    authors: firstString(row.authorString)?.split(/\s*,\s*/) ?? [],
    year: typeof row.pubYear === "string" ? Number(row.pubYear) : undefined,
    publishedAt: firstString(row.firstPublicationDate) ?? firstString(row.pubYear),
    doi: cleanDoi(row.doi),
    url: firstString(row.fullTextUrlList)
      ? undefined
      : firstString(row.id)
        ? `https://europepmc.org/article/${firstString(row.source)}/${firstString(row.id)}`
        : undefined,
    pdfUrl: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/pdf/` : undefined,
    source: "europe-pmc",
    sourcePaperId: firstString(row.id),
    venue: firstString(row.journalTitle),
    citationCount: typeof row.citedByCount === "number" ? row.citedByCount : Number(row.citedByCount) || undefined,
    isOpenAccess: row.isOpenAccess === "Y" || Boolean(pmcid),
    license: firstString(row.license),
    fieldsOfStudy: ["Life Sciences"],
    raw: row
  };
}

export const coreConnector: SourceConnector = {
  definition: definition({
    id: "core",
    displayName: "CORE",
    kind: "api",
    description: "Open-access metadata and full text harvested from repositories and journals.",
    requiresApiKey: true,
    stable: true,
    capabilities: ["metadata", "open-access", "full-text"],
    rateLimit: { requestsPerMinute: 30, notes: "Requires a CORE API key." }
  }),
  credentialSchema: apiKeyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), maxPapers: z.number() }).passthrough(),
  async run(config, context): Promise<CrawlResult> {
    const apiKey = context.credentials.core;
    if (!apiKey) throw new Error("CORE requires an API key in source settings.");
    const url = new URL("https://api.core.ac.uk/v3/search/works");
    url.searchParams.set("q", config.topic);
    url.searchParams.set("limit", String(limit(config)));
    const data = await getJson<{ results?: unknown[] }>(url, {
      signal: context.signal,
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    return {
      papers: (data.results ?? []).map((item) => normalizeCore(item)).filter(Boolean) as Paper[],
      warnings: [],
      provenance: { url: url.toString() }
    };
  }
};

function normalizeCore(item: unknown): Paper | undefined {
  const row = item as Record<string, unknown>;
  const title = firstString(row.title);
  if (!title) return undefined;
  const links = Array.isArray(row.links) ? (row.links as Array<Record<string, unknown>>) : [];
  return {
    id: id("paper"),
    title,
    abstract: firstString(row.abstract),
    authors: Array.isArray(row.authors)
      ? (row.authors
          .map((author) => firstString((author as Record<string, unknown>).name) ?? firstString(author))
          .filter(Boolean) as string[])
      : [],
    year: typeof row.yearPublished === "number" ? row.yearPublished : yearFromDate(row.publishedDate),
    publishedAt: firstString(row.publishedDate),
    doi: cleanDoi(row.doi),
    url: firstString(row.downloadUrl) ?? firstString(row.url),
    pdfUrl:
      firstString(row.downloadUrl) ?? firstString(links.find((link) => firstString(link.type)?.includes("pdf"))?.url),
    source: "core",
    sourcePaperId: firstString(row.id),
    venue: firstString(row.publisher),
    citationCount: typeof row.citationCount === "number" ? row.citationCount : undefined,
    isOpenAccess: true,
    fieldsOfStudy: [],
    raw: row
  };
}

export const unpaywallConnector: SourceConnector = {
  definition: definition({
    id: "unpaywall",
    displayName: "Unpaywall",
    kind: "enrichment",
    description: "DOI-based open-access enrichment and legal full-text locations.",
    requiresApiKey: false,
    stable: true,
    capabilities: ["open-access-enrichment", "doi"],
    rateLimit: { requestsPerMinute: 60, notes: "Requires an email parameter for production use." }
  }),
  credentialSchema: z.object({ email: z.string().email().optional() }).passthrough(),
  crawlConfigSchema: z.object({ topic: z.string() }).passthrough(),
  async run(): Promise<CrawlResult> {
    return emptyResult({ mode: "doi-enrichment" }, [
      "Unpaywall is a DOI enrichment source, so it runs after papers with DOI metadata are discovered."
    ]);
  }
};

export const googleScholarConnector: SourceConnector = {
  definition: definition({
    id: "google-scholar",
    displayName: "Google Scholar",
    kind: "browser",
    description: "Experimental browser automation fallback for user-approved Scholar searches.",
    requiresApiKey: false,
    stable: false,
    capabilities: ["browser-fallback", "metadata"],
    rateLimit: { requestsPerMinute: 6, notes: "Requires explicit user permission and system browser install." }
  }),
  credentialSchema: emptyCredentialSchema,
  crawlConfigSchema: z.object({ topic: z.string(), allowBrowserFallback: z.boolean() }).passthrough(),
  async run(config): Promise<CrawlResult> {
    if (!config.allowBrowserFallback) {
      throw new Error("Google Scholar is experimental and requires browser fallback approval.");
    }
    return emptyResult({ mode: "playwright-script-required" }, [
      "Google Scholar browser crawling is prepared as an approved Playwright script run, not an API connector."
    ]);
  }
};

export const builtInConnectors: SourceConnector[] = [
  openAlexConnector,
  crossrefConnector,
  semanticScholarConnector,
  pubmedConnector,
  arxivConnector,
  europePmcConnector,
  coreConnector,
  unpaywallConnector,
  googleScholarConnector
];
