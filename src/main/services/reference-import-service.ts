import type { Paper } from "../../shared/schemas.js";
import { normalizeDoi, normalizeSourceAuthority } from "./paper-identity.js";

export const REFERENCE_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const REFERENCE_IMPORT_MAX_RECORDS = 50_000;

export type ReferenceImportFormat = "ris" | "bibtex" | "csv";

export const referenceImportFields = [
  "title",
  "authors",
  "abstract",
  "year",
  "doi",
  "url",
  "pdfUrl",
  "venue",
  "sourcePaperId",
  "sourceAuthority",
  "citationCount"
] as const;
export type ReferenceImportField = (typeof referenceImportFields)[number];

export type CsvColumnMapping = Partial<Record<ReferenceImportField, string | null>>;
export type AppliedCsvColumnMapping = Partial<Record<ReferenceImportField, string>>;

export interface ReferenceImportLimits {
  maxBytes: number;
  maxRecords: number;
}

export interface ReferenceImportPaper extends Pick<
  Paper,
  | "title"
  | "abstract"
  | "authors"
  | "year"
  | "doi"
  | "url"
  | "pdfUrl"
  | "sourcePaperId"
  | "venue"
  | "citationCount"
  | "isOpenAccess"
  | "fieldsOfStudy"
  | "raw"
> {
  source: "reference-import";
  /** Namespace for an authoritative source identifier, for example arxiv or pubmed. */
  sourceAuthority?: string;
}

export interface ReferenceImportProvenance {
  source: "reference-import";
  format: ReferenceImportFormat;
  recordNumber: number;
  sourceIdentifier?: string;
  sourceAuthority?: string;
}

export interface ReferenceImportRecord {
  recordNumber: number;
  paper: ReferenceImportPaper;
  provenance: ReferenceImportProvenance;
}

export interface InvalidReferenceImportRecord {
  recordNumber: number;
  errors: string[];
  raw?: Record<string, unknown> | string;
}

export interface CsvImportPreview {
  headers: string[];
  suggestedMapping: AppliedCsvColumnMapping;
  appliedMapping: AppliedCsvColumnMapping;
}

export interface ReferenceImportPreview {
  format: ReferenceImportFormat | "unknown";
  sizeBytes: number;
  totalRecords: number;
  records: ReferenceImportRecord[];
  invalidRecords: InvalidReferenceImportRecord[];
  fileErrors: string[];
  warnings: string[];
  csv?: CsvImportPreview;
  canCommit: boolean;
}

export interface ReferenceImportPreviewInput {
  content: string | Uint8Array;
  format?: ReferenceImportFormat;
  /** Used only to infer a format; paths are never returned from this service. */
  fileName?: string;
  csvMapping?: CsvColumnMapping;
}

interface RawReferenceCandidate {
  recordNumber: number;
  title?: string;
  abstract?: string;
  authors?: string[];
  year?: string;
  doi?: string;
  url?: string;
  pdfUrl?: string;
  venue?: string;
  sourcePaperId?: string;
  sourceAuthority?: string;
  citationCount?: string;
  raw: Record<string, unknown>;
}

interface ParsedImport {
  candidates: RawReferenceCandidate[];
  invalidRecords: InvalidReferenceImportRecord[];
  totalRecords: number;
  fileErrors: string[];
  warnings: string[];
  csv?: CsvImportPreview;
}

interface CsvRow {
  line: number;
  cells: string[];
}

const DEFAULT_LIMITS: ReferenceImportLimits = {
  maxBytes: REFERENCE_IMPORT_MAX_BYTES,
  maxRecords: REFERENCE_IMPORT_MAX_RECORDS
};

export class ReferenceImportService {
  private readonly limits: ReferenceImportLimits;

  constructor(limits: Partial<ReferenceImportLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (!Number.isSafeInteger(this.limits.maxBytes) || this.limits.maxBytes <= 0) {
      throw new Error("Reference import maxBytes must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.limits.maxRecords) || this.limits.maxRecords <= 0) {
      throw new Error("Reference import maxRecords must be a positive integer.");
    }
  }

  preview(input: ReferenceImportPreviewInput): ReferenceImportPreview {
    const sizeBytes =
      typeof input.content === "string" ? Buffer.byteLength(input.content, "utf8") : input.content.byteLength;
    const format = input.format ?? detectReferenceImportFormat(input.fileName, input.content) ?? "unknown";
    if (sizeBytes > this.limits.maxBytes) {
      return blockedPreview(format, sizeBytes, `Reference files may not exceed ${formatBytes(this.limits.maxBytes)}.`);
    }
    if (format === "unknown") {
      return blockedPreview(format, sizeBytes, "Could not detect a RIS, BibTeX, or CSV reference format.");
    }

    const content = decodeContent(input.content);
    let parsed: ParsedImport;
    try {
      if (format === "ris") parsed = parseRis(content, this.limits.maxRecords);
      else if (format === "bibtex") parsed = parseBibtex(content, this.limits.maxRecords);
      else parsed = parseCsv(content, input.csvMapping, this.limits.maxRecords);
    } catch (error) {
      if (error instanceof ImportRecordLimitError) {
        return {
          ...blockedPreview(
            format,
            sizeBytes,
            `Reference files may contain at most ${this.limits.maxRecords.toLocaleString("en-US")} records.`
          ),
          totalRecords: this.limits.maxRecords + 1
        };
      }
      throw error;
    }

    const records: ReferenceImportRecord[] = [];
    const invalidRecords = [...parsed.invalidRecords];
    for (const candidate of parsed.candidates) {
      const validated = validateCandidate(candidate, format);
      if ("errors" in validated) invalidRecords.push(validated);
      else records.push(validated);
    }

    const fileErrors = [...parsed.fileErrors];
    if (parsed.totalRecords === 0) fileErrors.push("No reference records were found.");
    return {
      format,
      sizeBytes,
      totalRecords: parsed.totalRecords,
      records,
      invalidRecords: invalidRecords.sort((left, right) => left.recordNumber - right.recordNumber),
      fileErrors,
      warnings: parsed.warnings,
      csv: parsed.csv,
      canCommit: fileErrors.length === 0 && records.length > 0
    };
  }
}

export function previewReferenceImport(
  input: ReferenceImportPreviewInput,
  limits: Partial<ReferenceImportLimits> = {}
): ReferenceImportPreview {
  return new ReferenceImportService(limits).preview(input);
}

export function detectReferenceImportFormat(
  fileName: string | undefined,
  content?: string | Uint8Array
): ReferenceImportFormat | undefined {
  const safeName = fileName?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (safeName?.endsWith(".ris")) return "ris";
  if (safeName?.endsWith(".bib") || safeName?.endsWith(".bibtex")) return "bibtex";
  if (safeName?.endsWith(".csv")) return "csv";

  if (content === undefined) return undefined;
  const sample = decodeContent(content)
    .slice(0, 8192)
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^TY\s{1,2}-/m.test(sample)) return "ris";
  if (/^@(article|book|inproceedings|incollection|misc|phdthesis|mastersthesis|techreport)\s*[{(]/im.test(sample)) {
    return "bibtex";
  }
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.includes(",") || firstLine.includes("\t")) return "csv";
  return undefined;
}

export function inferCsvColumnMapping(headers: readonly string[]): AppliedCsvColumnMapping {
  const aliases: Record<ReferenceImportField, readonly string[]> = {
    title: ["title", "paper title", "article title", "document title", "name"],
    authors: ["authors", "author", "creators", "creator"],
    abstract: ["abstract", "summary", "description"],
    year: ["year", "publication year", "published year", "date", "publication date"],
    doi: ["doi", "digital object identifier"],
    url: ["url", "link", "record url", "landing page"],
    pdfUrl: ["pdf url", "pdf", "full text url", "fulltext url", "document url"],
    venue: ["venue", "journal", "publication", "container title", "booktitle"],
    sourcePaperId: ["source id", "source identifier", "paper id", "accession number", "eprint", "id"],
    sourceAuthority: ["source authority", "authority", "database", "source"],
    citationCount: ["citation count", "citations", "times cited", "cited by"]
  };
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const mapping: AppliedCsvColumnMapping = {};
  const used = new Set<number>();
  for (const field of referenceImportFields) {
    const index = normalizedHeaders.findIndex(
      (header, candidateIndex) => !used.has(candidateIndex) && aliases[field].includes(header)
    );
    if (index >= 0) {
      mapping[field] = headers[index];
      used.add(index);
    }
  }
  return mapping;
}

function parseRis(content: string, maxRecords: number): ParsedImport {
  const records: Array<{ fields: Map<string, string[]>; malformed: string[]; number: number }> = [];
  let current: { fields: Map<string, string[]>; malformed: string[]; number: number } | undefined;
  let lastTag: string | undefined;

  const finish = (): void => {
    if (!current) return;
    if (records.length >= maxRecords) throw new ImportRecordLimitError();
    records.push(current);
    current = undefined;
    lastTag = undefined;
  };

  for (const line of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const tagged = /^([A-Z0-9]{2})\s{1,2}-\s?(.*)$/.exec(line);
    if (tagged) {
      const [, tag, value] = tagged;
      if (tag === "TY") {
        finish();
        current = { fields: new Map(), malformed: [], number: records.length + 1 };
      } else if (!current) {
        current = { fields: new Map(), malformed: [], number: records.length + 1 };
      }
      const values = current!.fields.get(tag) ?? [];
      values.push(value.trim());
      current!.fields.set(tag, values);
      lastTag = tag;
      if (tag === "ER") finish();
      continue;
    }

    const continuation = /^\s{2,}(.+)$/.exec(line);
    if (continuation && current && lastTag) {
      const values = current.fields.get(lastTag);
      if (values?.length) values[values.length - 1] = `${values.at(-1)} ${continuation[1].trim()}`;
    } else if (line.trim() && current) {
      current.malformed.push(line.trim());
    }
  }
  finish();

  const candidates: RawReferenceCandidate[] = [];
  const invalidRecords: InvalidReferenceImportRecord[] = [];
  for (const record of records) {
    if (record.malformed.length) {
      invalidRecords.push({
        recordNumber: record.number,
        errors: [`Malformed RIS line${record.malformed.length === 1 ? "" : "s"}: ${record.malformed.join(" | ")}`],
        raw: risRawObject(record.fields)
      });
      continue;
    }
    const values = (tags: readonly string[]): string[] => tags.flatMap((tag) => record.fields.get(tag) ?? []);
    const first = (tags: readonly string[]): string | undefined => values(tags).find((value) => value.trim());
    const urls = values(["UR"]);
    const explicitPdf = first(["L1", "L2"]);
    const pdfUrl = explicitPdf ?? urls.find(isLikelyPdfUrl);
    const sourceAuthority = first(["DP", "DB"]);
    const sourcePaperId = first(["AN", "ID"]);
    candidates.push({
      recordNumber: record.number,
      title: first(["TI", "T1", "CT"]),
      abstract: first(["AB", "N2"]),
      authors: values(["AU", "A1"]).flatMap(splitAuthors),
      year: first(["PY", "Y1", "DA"]),
      doi: first(["DO"]) ?? urls.map(extractDoiFromUrl).find(Boolean),
      url: urls.find((url) => url !== pdfUrl) ?? urls[0],
      pdfUrl,
      venue: first(["JO", "JF", "T2", "JA"]),
      sourcePaperId,
      sourceAuthority,
      citationCount: first(["TC"]),
      raw: risRawObject(record.fields)
    });
  }

  return {
    candidates,
    invalidRecords,
    totalRecords: records.length,
    fileErrors: [],
    warnings: []
  };
}

function parseBibtex(content: string, maxRecords: number): ParsedImport {
  const entries = extractBibtexEntries(content.replace(/^\uFEFF/, ""), maxRecords);
  const candidates: RawReferenceCandidate[] = [];
  const invalidRecords = [...entries.invalidRecords];
  for (const entry of entries.entries) {
    try {
      const parsed = parseBibtexEntry(entry.body);
      const fields = parsed.fields;
      const value = (...names: string[]): string | undefined => {
        for (const name of names) {
          const candidate = fields.get(name);
          if (candidate?.trim()) return cleanBibtexValue(candidate);
        }
        return undefined;
      };
      const authorValue = value("author");
      const url = value("url", "link");
      const explicitPdf = value("pdf", "fulltext", "full-text", "file");
      const archivePrefix = value("archiveprefix", "database", "source");
      const eprint = value("eprint", "sourceid", "source-id", "accessionnumber");
      candidates.push({
        recordNumber: entry.number,
        title: value("title"),
        abstract: value("abstract", "summary"),
        authors: authorValue ? splitBibtexAuthors(authorValue) : [],
        year: value("year", "date"),
        doi: value("doi") ?? extractDoiFromUrl(url),
        url,
        pdfUrl: explicitPdf && isHttpUrl(explicitPdf) ? explicitPdf : isLikelyPdfUrl(url) ? url : undefined,
        venue: value("journal", "booktitle", "journaltitle", "container-title", "publisher"),
        sourcePaperId: eprint ?? value("id") ?? parsed.key,
        sourceAuthority: archivePrefix,
        citationCount: value("citationcount", "citation-count", "citations", "times-cited"),
        raw: Object.fromEntries(fields)
      });
    } catch (error) {
      invalidRecords.push({
        recordNumber: entry.number,
        errors: [error instanceof Error ? error.message : String(error)],
        raw: truncate(entry.raw)
      });
    }
  }
  return {
    candidates,
    invalidRecords,
    totalRecords: entries.totalRecords,
    fileErrors: [],
    warnings: []
  };
}

function parseCsv(content: string, requestedMapping: CsvColumnMapping | undefined, maxRecords: number): ParsedImport {
  let rows: CsvRow[];
  try {
    rows = parseCsvRows(content.replace(/^\uFEFF/, ""), maxRecords + 1);
  } catch (error) {
    if (error instanceof ImportRecordLimitError) throw error;
    return {
      candidates: [],
      invalidRecords: [],
      totalRecords: 0,
      fileErrors: [error instanceof Error ? error.message : String(error)],
      warnings: []
    };
  }
  if (!rows.length) {
    return { candidates: [], invalidRecords: [], totalRecords: 0, fileErrors: [], warnings: [] };
  }

  const headers = rows[0].cells.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim());
  const dataRows = rows.slice(1).filter((row) => row.cells.some((cell) => cell.trim()));
  if (dataRows.length > maxRecords) throw new ImportRecordLimitError();
  const fileErrors: string[] = [];
  if (headers.every((header) => !header)) fileErrors.push("CSV must have a header row.");
  const duplicateHeaders = findDuplicateHeaders(headers);
  if (duplicateHeaders.length) fileErrors.push(`CSV headers must be unique: ${duplicateHeaders.join(", ")}.`);

  const suggestedMapping = inferCsvColumnMapping(headers);
  const appliedMapping = requestedMapping === undefined ? suggestedMapping : cleanRequestedMapping(requestedMapping);
  for (const [field, header] of Object.entries(appliedMapping)) {
    if (!headers.includes(header)) fileErrors.push(`CSV mapping for ${field} refers to an unknown column: ${header}.`);
  }
  if (!appliedMapping.title) fileErrors.push("CSV mapping must select a title column.");

  const candidates: RawReferenceCandidate[] = [];
  const invalidRecords: InvalidReferenceImportRecord[] = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index];
    const recordNumber = index + 1;
    const raw = Object.fromEntries(
      headers.map((header, column) => [header || `column-${column + 1}`, row.cells[column] ?? ""])
    );
    if (row.cells.length > headers.length) {
      invalidRecords.push({
        recordNumber,
        errors: [`CSV line ${row.line} has ${row.cells.length} columns; expected ${headers.length}.`],
        raw
      });
      continue;
    }
    const read = (field: ReferenceImportField): string | undefined => {
      const header = appliedMapping[field];
      if (!header) return undefined;
      const column = headers.indexOf(header);
      return column >= 0 ? row.cells[column]?.trim() : undefined;
    };
    candidates.push({
      recordNumber,
      title: read("title"),
      authors: splitAuthors(read("authors") ?? ""),
      abstract: read("abstract"),
      year: read("year"),
      doi: read("doi"),
      url: read("url"),
      pdfUrl: read("pdfUrl"),
      venue: read("venue"),
      sourcePaperId: read("sourcePaperId"),
      sourceAuthority: read("sourceAuthority"),
      citationCount: read("citationCount"),
      raw
    });
  }

  return {
    candidates,
    invalidRecords,
    totalRecords: dataRows.length,
    fileErrors,
    warnings: [],
    csv: { headers, suggestedMapping, appliedMapping }
  };
}

function validateCandidate(
  candidate: RawReferenceCandidate,
  format: ReferenceImportFormat
): ReferenceImportRecord | InvalidReferenceImportRecord {
  const errors: string[] = [];
  const title = cleanText(candidate.title);
  if (!title) errors.push("Title is required.");
  const year = parseYear(candidate.year);
  if (candidate.year?.trim() && year === undefined) {
    errors.push(`Year must contain a value from 1500 through 3000: ${candidate.year}.`);
  }
  const citationCount = parseNonnegativeInteger(candidate.citationCount);
  if (candidate.citationCount?.trim() && citationCount === undefined) {
    errors.push(`Citation count must be a nonnegative integer: ${candidate.citationCount}.`);
  }
  const url = validateHttpUrl(candidate.url, "URL", errors);
  const pdfUrl = validateHttpUrl(candidate.pdfUrl, "PDF URL", errors);
  if (errors.length || !title) {
    return { recordNumber: candidate.recordNumber, errors, raw: candidate.raw };
  }

  const authors = uniqueStrings(
    candidate.authors?.map(cleanText).filter((value): value is string => Boolean(value)) ?? []
  );
  const sourcePaperId = cleanText(candidate.sourcePaperId);
  const sourceAuthority = normalizeSourceAuthority(candidate.sourceAuthority);
  const paper: ReferenceImportPaper = {
    title,
    authors,
    source: "reference-import",
    isOpenAccess: false,
    fieldsOfStudy: [],
    raw: candidate.raw
  };
  const abstract = cleanText(candidate.abstract);
  const doi = normalizeDoi(candidate.doi);
  const venue = cleanText(candidate.venue);
  if (abstract) paper.abstract = abstract;
  if (year !== undefined) paper.year = year;
  if (doi) paper.doi = doi;
  if (url) paper.url = url;
  if (pdfUrl) paper.pdfUrl = pdfUrl;
  if (venue) paper.venue = venue;
  if (sourcePaperId) paper.sourcePaperId = sourcePaperId;
  if (sourceAuthority) paper.sourceAuthority = sourceAuthority;
  if (citationCount !== undefined) paper.citationCount = citationCount;

  return {
    recordNumber: candidate.recordNumber,
    paper,
    provenance: {
      source: "reference-import",
      format,
      recordNumber: candidate.recordNumber,
      sourceIdentifier: sourcePaperId,
      sourceAuthority
    }
  };
}

function extractBibtexEntries(
  content: string,
  maxRecords: number
): {
  entries: Array<{ number: number; body: string; raw: string }>;
  invalidRecords: InvalidReferenceImportRecord[];
  totalRecords: number;
} {
  const entries: Array<{ number: number; body: string; raw: string }> = [];
  const invalidRecords: InvalidReferenceImportRecord[] = [];
  let totalRecords = 0;
  let index = 0;
  while (index < content.length) {
    const at = content.indexOf("@", index);
    if (at < 0) break;
    const typeMatch = /^@([a-zA-Z][\w-]*)\s*([{(])/.exec(content.slice(at));
    if (!typeMatch) {
      index = at + 1;
      continue;
    }
    const type = typeMatch[1].toLowerCase();
    const opener = typeMatch[2];
    const openIndex = at + typeMatch[0].lastIndexOf(opener);
    const closeIndex = findBalancedEnd(content, openIndex, opener, opener === "{" ? "}" : ")");
    if (["comment", "preamble", "string"].includes(type)) {
      index = closeIndex < 0 ? content.length : closeIndex + 1;
      continue;
    }
    totalRecords += 1;
    if (totalRecords > maxRecords) throw new ImportRecordLimitError();
    if (closeIndex < 0) {
      invalidRecords.push({
        recordNumber: totalRecords,
        errors: [`BibTeX entry @${type} has no closing ${opener === "{" ? "brace" : "parenthesis"}.`],
        raw: truncate(content.slice(at))
      });
      break;
    }
    entries.push({
      number: totalRecords,
      body: content.slice(openIndex + 1, closeIndex),
      raw: content.slice(at, closeIndex + 1)
    });
    index = closeIndex + 1;
  }
  return { entries, invalidRecords, totalRecords };
}

function parseBibtexEntry(body: string): { key: string; fields: Map<string, string> } {
  const comma = findTopLevelComma(body);
  if (comma < 0) throw new Error("BibTeX entry is missing its field list.");
  const key = body.slice(0, comma).trim();
  if (!key) throw new Error("BibTeX entry is missing its citation key.");
  const fields = new Map<string, string>();
  let index = comma + 1;
  while (index < body.length) {
    index = skipWhitespaceAndCommas(body, index);
    if (index >= body.length) break;
    const nameMatch = /^[a-zA-Z][\w-]*/.exec(body.slice(index));
    if (!nameMatch) throw new Error(`Malformed BibTeX field near: ${truncate(body.slice(index), 80)}`);
    const name = nameMatch[0].toLowerCase();
    index += nameMatch[0].length;
    index = skipWhitespace(body, index);
    if (body[index] !== "=") throw new Error(`BibTeX field ${name} is missing '='.`);
    index = skipWhitespace(body, index + 1);
    const parts: string[] = [];
    while (index < body.length) {
      const token = readBibtexValue(body, index);
      parts.push(token.value);
      index = skipWhitespace(body, token.nextIndex);
      if (body[index] !== "#") break;
      index = skipWhitespace(body, index + 1);
    }
    fields.set(name, parts.join(""));
    index = skipWhitespace(body, index);
    if (index < body.length && body[index] !== ",") {
      throw new Error(`BibTeX field ${name} is not followed by a comma.`);
    }
  }
  return { key, fields };
}

function readBibtexValue(content: string, start: number): { value: string; nextIndex: number } {
  const opener = content[start];
  if (opener === "{") {
    const end = findBalancedEnd(content, start, "{", "}");
    if (end < 0) throw new Error("BibTeX field has an unclosed brace.");
    return { value: content.slice(start + 1, end), nextIndex: end + 1 };
  }
  if (opener === '"') {
    let escaped = false;
    for (let index = start + 1; index < content.length; index += 1) {
      const character = content[index];
      if (character === '"' && !escaped) {
        return { value: content.slice(start + 1, index), nextIndex: index + 1 };
      }
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
    throw new Error("BibTeX field has an unclosed quote.");
  }
  let index = start;
  while (index < content.length && !/[#,\s]/.test(content[index])) index += 1;
  if (index === start) throw new Error("BibTeX field has no value.");
  return { value: content.slice(start, index), nextIndex: index };
}

function findBalancedEnd(content: string, start: number, opener: string, closer: string): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"' && !escaped) quoted = !quoted;
    if (!quoted) {
      if (character === opener) depth += 1;
      else if (character === closer) {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return -1;
}

function findTopLevelComma(content: string): number {
  let braces = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"' && !escaped) quoted = !quoted;
    if (!quoted) {
      if (character === "{") braces += 1;
      else if (character === "}") braces = Math.max(0, braces - 1);
      else if (character === "," && braces === 0) return index;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return -1;
}

function parseCsvRows(content: string, maxDataRowsPlusHeader: number): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const finishRow = (): void => {
    cells.push(cell);
    if (cells.some((value) => value.length > 0)) {
      rows.push({ line: rowLine, cells });
      if (rows.length > maxDataRowsPlusHeader) throw new ImportRecordLimitError();
    }
    cells = [];
    cell = "";
    rowLine = line + 1;
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += character;
        if (character === "\n") line += 1;
      }
      continue;
    }

    if (character === '"' && cell.length === 0) inQuotes = true;
    else if (character === ",") {
      cells.push(cell);
      cell = "";
    } else if (character === "\n") {
      finishRow();
      line += 1;
      rowLine = line;
    } else if (character !== "\r") cell += character;
  }
  if (inQuotes) throw new Error(`CSV has an unclosed quoted field beginning near line ${rowLine}.`);
  if (cell.length || cells.length) finishRow();
  return rows;
}

function splitAuthors(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((author) => typeof author === "string")) return parsed;
    } catch {
      // Continue with delimiter-based parsing.
    }
  }
  const delimiter = trimmed.includes(";") ? /\s*;\s*/ : trimmed.includes("|") ? /\s*\|\s*/ : /\s+and\s+/i;
  return trimmed
    .split(delimiter)
    .map(cleanText)
    .filter((author): author is string => Boolean(author));
}

function splitBibtexAuthors(value: string): string[] {
  const authors: string[] = [];
  let braces = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") braces += 1;
    else if (value[index] === "}") braces = Math.max(0, braces - 1);
    else if (braces === 0 && /^\s+and\s+/i.test(value.slice(index))) {
      const match = /^\s+and\s+/i.exec(value.slice(index))!;
      const author = cleanBibtexValue(value.slice(start, index));
      if (author) authors.push(author);
      index += match[0].length - 1;
      start = index + 1;
    }
  }
  const finalAuthor = cleanBibtexValue(value.slice(start));
  if (finalAuthor) authors.push(finalAuthor);
  return uniqueStrings(authors);
}

function cleanBibtexValue(value: string): string {
  return value
    .replace(/\\url\s*{([^}]*)}/gi, "$1")
    .replace(/\\(?:textit|textbf|emph)\s*{([^}]*)}/gi, "$1")
    .replace(/\\([#$%&_{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYear(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const match = /(?:^|\D)(\d{4})(?:\D|$)/.exec(value);
  if (!match) return undefined;
  const year = Number.parseInt(match[1], 10);
  return year >= 1500 && year <= 3000 ? year : undefined;
}

function parseNonnegativeInteger(value: string | undefined): number | undefined {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateHttpUrl(value: string | undefined, label: string, errors: string[]): string | undefined {
  const cleaned = cleanText(value);
  if (!cleaned) return undefined;
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    errors.push(`${label} must be an absolute HTTP or HTTPS URL: ${cleaned}.`);
    return undefined;
  }
}

function extractDoiFromUrl(value: string | undefined): string | undefined {
  if (!value || !/doi\.org\//i.test(value)) return undefined;
  return normalizeDoi(value);
}

function isLikelyPdfUrl(value: string | undefined): boolean {
  if (!value) return false;
  return /(?:\.pdf(?:[?#]|$)|\/pdf(?:[/?#]|$))/i.test(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function risRawObject(fields: ReadonlyMap<string, string[]>): Record<string, unknown> {
  return Object.fromEntries([...fields].map(([tag, values]) => [tag, values.length === 1 ? values[0] : values]));
}

function cleanRequestedMapping(mapping: CsvColumnMapping): AppliedCsvColumnMapping {
  const cleaned: AppliedCsvColumnMapping = {};
  for (const field of referenceImportFields) {
    const header = mapping[field]?.trim();
    if (header) cleaned[field] = header;
  }
  return cleaned;
}

function findDuplicateHeaders(headers: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return headers.filter((header, index) => {
    const normalized = normalizeHeader(header);
    return Boolean(
      normalized &&
      (counts.get(normalized) ?? 0) > 1 &&
      headers.findIndex((item) => normalizeHeader(item) === normalized) === index
    );
  });
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ");
}

function cleanText(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length && /\s/.test(value[index])) index += 1;
  return index;
}

function skipWhitespaceAndCommas(value: string, index: number): number {
  while (index < value.length && /[\s,]/.test(value[index])) index += 1;
  return index;
}

function decodeContent(content: string | Uint8Array): string {
  if (typeof content === "string") return content;
  return new TextDecoder("utf-8").decode(content);
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  return `${bytes.toLocaleString("en-US")} bytes`;
}

function blockedPreview(
  format: ReferenceImportFormat | "unknown",
  sizeBytes: number,
  error: string
): ReferenceImportPreview {
  return {
    format,
    sizeBytes,
    totalRecords: 0,
    records: [],
    invalidRecords: [],
    fileErrors: [error],
    warnings: [],
    canCommit: false
  };
}

function truncate(value: string, length = 2000): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

class ImportRecordLimitError extends Error {}
