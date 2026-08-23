/**
 * Conservative paper identity helpers used by reference imports and crawlers.
 *
 * A title by itself is deliberately never considered enough evidence for an
 * automatic merge. Callers must surface ambiguous results to a human.
 */

export interface PaperIdentityInput {
  id?: string;
  title: string;
  authors?: readonly string[];
  year?: number;
  doi?: string;
  source?: string;
  sourcePaperId?: string;
  sourceAuthority?: string;
  raw?: Record<string, unknown>;
}

export type PaperIdentityStrategy = "doi" | "source-identifier" | "bibliographic-fingerprint";

export type PaperIdentityAmbiguity = PaperIdentityStrategy | "title-only" | "conflicting-identifiers";

export interface AuthoritativeSourceIdentifier {
  authority: string;
  identifier: string;
}

export type PaperIdentityMatch<T extends PaperIdentityInput> =
  | {
      kind: "exact";
      strategy: PaperIdentityStrategy;
      key: string;
      candidate: T;
    }
  | {
      kind: "ambiguous";
      strategy: PaperIdentityAmbiguity;
      key?: string;
      candidates: T[];
      reasons: string[];
    }
  | {
      kind: "none";
      candidates: [];
    };

export function normalizeDoi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Invalid URL encoding is not safe identity evidence. The import itself can
    // still proceed with the DOI omitted.
    return undefined;
  }

  normalized = normalized
    .replace(/^doi\s*:\s*/i, "")
    .replace(/^(?:https?:\/\/)?(?:www\.)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^urn:doi:/i, "")
    .trim()
    .replace(/[\s.,;:]+$/g, "");

  const match = /^10\.\d{4,9}\/(.+)$/u.exec(normalized);
  if (!match || normalized.length > 2_048) return undefined;
  const suffix = match[1];
  if (/\s/u.test(suffix) || /[\u0000-\u001f\u007f]/u.test(suffix)) return undefined;
  if (!/[\p{Letter}\p{Number}]/u.test(suffix)) return undefined;

  return normalized;
}

export function normalizeSourceAuthority(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = foldText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized || normalized === "reference-import") return undefined;

  const aliases: Record<string, string> = {
    arxiv: "arxiv",
    crossref: "crossref",
    doi: "crossref",
    openalex: "openalex",
    "open-alex": "openalex",
    pmid: "pubmed",
    pubmed: "pubmed",
    "semantic-scholar": "semantic-scholar",
    semanticscholar: "semantic-scholar",
    s2: "semantic-scholar",
    "europe-pmc": "europe-pmc",
    europepmc: "europe-pmc",
    core: "core"
  };
  return aliases[normalized] ?? normalized;
}

export function normalizeSourceIdentifier(value: string | undefined, authority?: string): string | undefined {
  if (!value) return undefined;
  const normalizedAuthority = normalizeSourceAuthority(authority);
  let normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the literal identifier when it is not valid URL encoding.
  }

  normalized = normalized
    .replace(/^https?:\/\/(?:www\.)?openalex\.org\//, "")
    .replace(/^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\//, "")
    .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//, "")
    .replace(/\.pdf$/i, "")
    .replace(/\/+$/g, "")
    .trim();

  if (normalizedAuthority === "arxiv") {
    normalized = normalized.replace(/^arxiv\s*:\s*/, "").replace(/v\d+$/i, "");
  } else if (normalizedAuthority === "pubmed") {
    normalized = normalized.replace(/^pmid\s*:\s*/, "");
  } else if (normalizedAuthority === "openalex") {
    normalized = normalized.replace(/^openalex\s*:\s*/, "");
  }

  return normalized.replace(/\s+/g, "") || undefined;
}

export function normalizeBibliographicTitle(value: string): string {
  return foldText(value)
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeFirstAuthor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = foldText(value)
    .replace(/\b(?:orcid|https?):\S+/g, " ")
    .replace(/[^\p{Letter}\p{Number}, ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;

  const commaParts = cleaned
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  let family: string;
  let given: string;
  if (commaParts.length > 1) {
    family = commaParts[0];
    given = commaParts.slice(1).join(" ");
  } else {
    const tokens = cleaned.split(" ").filter(Boolean);
    family = tokens.at(-1) ?? "";
    given = tokens.slice(0, -1).join(" ");
  }
  if (!family) return undefined;
  const initials = given
    .split(" ")
    .filter(Boolean)
    .map((part) => [...part][0])
    .join("");
  return `${family.replace(/\s+/g, "")}:${initials}`;
}

export function doiIdentityKey(input: Pick<PaperIdentityInput, "doi">): string | undefined {
  const doi = normalizeDoi(input.doi);
  return doi ? `doi:${doi}` : undefined;
}

export function sourceIdentifierIdentityKey(
  input: Pick<PaperIdentityInput, "source" | "sourcePaperId" | "sourceAuthority" | "raw">
): string | undefined {
  return sourceIdentifierIdentityKeys(input)[0];
}

/**
 * Returns every authoritative identifier retained for a paper. The first item
 * is the paper's primary source identifier; later items are identifiers learned
 * from other connectors/imports and retained in raw metadata.
 */
export function sourceIdentifierIdentityKeys(
  input: Pick<PaperIdentityInput, "source" | "sourcePaperId" | "sourceAuthority" | "raw">
): string[] {
  return authoritativeSourceIdentifiers(input).map(({ authority, identifier }) => `source:${authority}:${identifier}`);
}

export function authoritativeSourceIdentifiers(
  input: Pick<PaperIdentityInput, "source" | "sourcePaperId" | "sourceAuthority" | "raw">
): AuthoritativeSourceIdentifier[] {
  const identifiers: AuthoritativeSourceIdentifier[] = [];
  const primaryAuthority = normalizeSourceAuthority(identitySourceAuthority(input));
  const primaryIdentifier = normalizeSourceIdentifier(input.sourcePaperId, primaryAuthority);
  if (primaryAuthority && primaryIdentifier) {
    identifiers.push({ authority: primaryAuthority, identifier: primaryIdentifier });
  }

  const retained = input.raw?.identitySourceIdentifiers;
  if (Array.isArray(retained)) {
    for (const item of retained) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const candidate = item as Record<string, unknown>;
      const authority = normalizeSourceAuthority(
        typeof candidate.authority === "string" ? candidate.authority : undefined
      );
      const identifier = normalizeSourceIdentifier(
        typeof candidate.identifier === "string" ? candidate.identifier : undefined,
        authority
      );
      if (authority && identifier) identifiers.push({ authority, identifier });
    }
  }
  return uniqueSourceIdentifiers(identifiers);
}

/**
 * Retains newly learned source identities without ever placing an identifier
 * in a primary source namespace that does not own it.
 */
export function mergeAuthoritativeSourceIdentifiers(
  current: Pick<PaperIdentityInput, "source" | "sourcePaperId" | "sourceAuthority" | "raw">,
  incoming: Pick<PaperIdentityInput, "source" | "sourcePaperId" | "sourceAuthority" | "raw">
): { sourcePaperId?: string; raw: Record<string, unknown> } {
  const raw: Record<string, unknown> = { ...(current.raw ?? {}) };
  const currentAuthority = normalizeSourceAuthority(identitySourceAuthority(current));
  let sourcePaperId = current.sourcePaperId;
  let retained = authoritativeSourceIdentifiers(current);

  for (const identity of authoritativeSourceIdentifiers(incoming)) {
    if (retained.some((candidate) => sameSourceIdentifier(candidate, identity))) continue;

    const mayBecomePrimary =
      !sourcePaperId &&
      (currentAuthority === identity.authority || (!currentAuthority && current.source === "reference-import"));
    if (mayBecomePrimary) {
      sourcePaperId = identity.identifier;
      if (!currentAuthority) raw.sourceAuthority = identity.authority;
    } else {
      retained.push(identity);
    }
  }

  retained = uniqueSourceIdentifiers(retained).filter((identity) => {
    const primaryAuthority = normalizeSourceAuthority(
      typeof raw.sourceAuthority === "string" && current.source === "reference-import"
        ? raw.sourceAuthority
        : current.source
    );
    const primaryIdentifier = normalizeSourceIdentifier(sourcePaperId, primaryAuthority);
    return identity.authority !== primaryAuthority || identity.identifier !== primaryIdentifier;
  });
  if (retained.length) raw.identitySourceIdentifiers = retained;
  else delete raw.identitySourceIdentifiers;
  return { sourcePaperId, raw };
}

export function bibliographicFingerprint(
  input: Pick<PaperIdentityInput, "title" | "year" | "authors">
): string | undefined {
  const title = normalizeBibliographicTitle(input.title);
  const author = normalizeFirstAuthor(input.authors?.[0]);
  if (!title || !input.year || !author) return undefined;
  return `bibliographic:${title}|${input.year}|${author}`;
}

export function resolvePaperIdentity<T extends PaperIdentityInput>(
  incoming: PaperIdentityInput,
  candidates: readonly T[]
): PaperIdentityMatch<T> {
  return new PaperIdentityResolver(candidates).resolve(incoming);
}

export class PaperIdentityResolver<T extends PaperIdentityInput> {
  private readonly candidates: T[];
  private readonly candidatePositions = new Map<T, number>();
  private readonly idPositions = new Map<string, number>();
  private readonly indexedIds = new Map<T, string | undefined>();
  private readonly doiIndex = new Map<string, Set<T>>();
  private readonly sourceIndex = new Map<string, Set<T>>();
  private readonly fingerprintIndex = new Map<string, Set<T>>();
  private readonly titleIndex = new Map<string, Set<T>>();

  constructor(candidates: readonly T[] = []) {
    this.candidates = [];
    for (const candidate of candidates) this.add(candidate);
  }

  resolve(incoming: PaperIdentityInput): PaperIdentityMatch<T> {
    const doiKey = doiIdentityKey(incoming);
    const sourceKeys = sourceIdentifierIdentityKeys(incoming);
    const sourceKey = sourceKeys[0];
    const fingerprint = bibliographicFingerprint(incoming);
    const doiMatches = doiKey ? this.lookup(this.doiIndex, [doiKey]) : [];
    const sourceMatches = this.lookup(this.sourceIndex, sourceKeys);

    if (doiMatches.length > 1) {
      return ambiguous("doi", doiKey, doiMatches, "More than one paper has the same normalized DOI.");
    }
    if (doiMatches.length === 1) {
      const conflictingSources = sourceMatches.filter((candidate) => candidate !== doiMatches[0]);
      if (conflictingSources.length) {
        return ambiguous(
          "conflicting-identifiers",
          undefined,
          uniqueCandidates([...doiMatches, ...conflictingSources]),
          "The DOI and authoritative source identifier point to different papers."
        );
      }
      return { kind: "exact", strategy: "doi", key: doiKey!, candidate: doiMatches[0] };
    }

    if (sourceMatches.length > 1) {
      return ambiguous(
        "source-identifier",
        sourceKey,
        sourceMatches,
        "More than one paper has the same authoritative source identifier."
      );
    }
    if (sourceMatches.length === 1) {
      if (hasConflictingDoi(incoming, sourceMatches[0])) {
        return ambiguous(
          "conflicting-identifiers",
          sourceKey,
          sourceMatches,
          "The source identifier matches, but the papers have different DOIs."
        );
      }
      return {
        kind: "exact",
        strategy: "source-identifier",
        key: sourceKey!,
        candidate: sourceMatches[0]
      };
    }

    const fingerprintMatches = fingerprint ? this.lookup(this.fingerprintIndex, [fingerprint]) : [];
    if (fingerprintMatches.length > 1) {
      return ambiguous(
        "bibliographic-fingerprint",
        fingerprint,
        fingerprintMatches,
        "More than one paper has the same title, year, and first-author fingerprint."
      );
    }
    if (fingerprintMatches.length === 1) {
      const candidate = fingerprintMatches[0];
      if (hasConflictingDoi(incoming, candidate) || hasConflictingSourceIdentifier(incoming, candidate)) {
        return ambiguous(
          "conflicting-identifiers",
          fingerprint,
          fingerprintMatches,
          "The bibliographic fingerprint matches, but a persistent identifier conflicts."
        );
      }
      return {
        kind: "exact",
        strategy: "bibliographic-fingerprint",
        key: fingerprint!,
        candidate
      };
    }

    const title = normalizeBibliographicTitle(incoming.title);
    const titleMatches = title ? this.lookup(this.titleIndex, [`title:${title}`]) : [];
    if (titleMatches.length) {
      return ambiguous(
        "title-only",
        `title:${title}`,
        titleMatches,
        "A title match alone is not sufficient for an automatic merge."
      );
    }

    return { kind: "none", candidates: [] };
  }

  add(candidate: T): void {
    if (this.candidatePositions.has(candidate)) {
      throw new Error("Cannot add the same paper identity candidate more than once.");
    }
    const id = candidateIdentityId(candidate);
    if (id !== undefined && this.idPositions.has(id)) {
      throw new Error(`Cannot add duplicate paper identity candidate ID: ${id}`);
    }

    const position = this.candidates.length;
    this.candidates.push(candidate);
    this.candidatePositions.set(candidate, position);
    this.indexedIds.set(candidate, id);
    if (id !== undefined) this.idPositions.set(id, position);
    this.indexCandidate(candidate);
  }

  replace(previous: T, next: T): void {
    const previousId = candidateIdentityId(previous);
    const position =
      this.candidatePositions.get(previous) ??
      (previousId === undefined ? undefined : this.idPositions.get(previousId));
    if (position === undefined) {
      this.add(next);
      return;
    }

    const current = this.candidates[position];
    const nextId = candidateIdentityId(next);
    const nextPosition = this.candidatePositions.get(next);
    if (nextPosition !== undefined && nextPosition !== position) {
      throw new Error("Cannot replace a paper identity candidate with a candidate that is already indexed.");
    }
    const duplicateIdPosition = nextId === undefined ? undefined : this.idPositions.get(nextId);
    if (duplicateIdPosition !== undefined && duplicateIdPosition !== position) {
      throw new Error(`Cannot replace paper identity candidate with duplicate ID: ${nextId}`);
    }

    this.removeCandidate(current);
    this.candidatePositions.delete(current);
    const currentId = this.indexedIds.get(current);
    this.indexedIds.delete(current);
    if (currentId !== undefined) this.idPositions.delete(currentId);

    this.candidates[position] = next;
    this.candidatePositions.set(next, position);
    this.indexedIds.set(next, nextId);
    if (nextId !== undefined) this.idPositions.set(nextId, position);
    this.indexCandidate(next);
  }

  list(): readonly T[] {
    return this.candidates;
  }

  private lookup(index: Map<string, Set<T>>, keys: readonly string[]): T[] {
    const matches = new Set<T>();
    for (const key of keys) {
      for (const candidate of index.get(key) ?? []) matches.add(candidate);
    }
    return [...matches];
  }

  private indexCandidate(candidate: T): void {
    const doi = doiIdentityKey(candidate);
    if (doi) addToIndex(this.doiIndex, doi, candidate);
    for (const key of sourceIdentifierIdentityKeys(candidate)) addToIndex(this.sourceIndex, key, candidate);
    const fingerprint = bibliographicFingerprint(candidate);
    if (fingerprint) addToIndex(this.fingerprintIndex, fingerprint, candidate);
    const title = normalizeBibliographicTitle(candidate.title);
    if (title) addToIndex(this.titleIndex, `title:${title}`, candidate);
  }

  private removeCandidate(candidate: T): void {
    const doi = doiIdentityKey(candidate);
    if (doi) removeFromIndex(this.doiIndex, doi, candidate);
    for (const key of sourceIdentifierIdentityKeys(candidate)) removeFromIndex(this.sourceIndex, key, candidate);
    const fingerprint = bibliographicFingerprint(candidate);
    if (fingerprint) removeFromIndex(this.fingerprintIndex, fingerprint, candidate);
    const title = normalizeBibliographicTitle(candidate.title);
    if (title) removeFromIndex(this.titleIndex, `title:${title}`, candidate);
  }
}

function hasConflictingDoi(left: PaperIdentityInput, right: PaperIdentityInput): boolean {
  const leftDoi = normalizeDoi(left.doi);
  const rightDoi = normalizeDoi(right.doi);
  return Boolean(leftDoi && rightDoi && leftDoi !== rightDoi);
}

function candidateIdentityId(candidate: PaperIdentityInput): string | undefined {
  return typeof candidate.id === "string" ? candidate.id : undefined;
}

function hasConflictingSourceIdentifier(left: PaperIdentityInput, right: PaperIdentityInput): boolean {
  const leftByAuthority = groupSourceIdentifiers(authoritativeSourceIdentifiers(left));
  const rightByAuthority = groupSourceIdentifiers(authoritativeSourceIdentifiers(right));
  for (const [authority, leftIdentifiers] of leftByAuthority) {
    const rightIdentifiers = rightByAuthority.get(authority);
    if (!rightIdentifiers?.size) continue;
    if (![...leftIdentifiers].some((identifier) => rightIdentifiers.has(identifier))) return true;
  }
  return false;
}

function identitySourceAuthority(
  input: Pick<PaperIdentityInput, "source" | "sourceAuthority" | "raw">
): string | undefined {
  if (input.sourceAuthority) return input.sourceAuthority;
  if (input.source && input.source !== "reference-import") return input.source;
  const rawAuthority = input.raw?.sourceAuthority;
  if (typeof rawAuthority === "string" && rawAuthority.trim()) return rawAuthority;
  const imported = input.raw?.referenceImport;
  if (imported && typeof imported === "object" && !Array.isArray(imported)) {
    const provenanceAuthority = (imported as Record<string, unknown>).sourceAuthority;
    if (typeof provenanceAuthority === "string" && provenanceAuthority.trim()) return provenanceAuthority;
  }
  return undefined;
}

function ambiguous<T extends PaperIdentityInput>(
  strategy: PaperIdentityAmbiguity,
  key: string | undefined,
  candidates: readonly T[],
  reason: string
): PaperIdentityMatch<T> {
  return {
    kind: "ambiguous",
    strategy,
    key,
    candidates: [...candidates],
    reasons: [reason]
  };
}

function uniqueCandidates<T>(candidates: readonly T[]): T[] {
  return [...new Set(candidates)];
}

function uniqueSourceIdentifiers(
  identifiers: readonly AuthoritativeSourceIdentifier[]
): AuthoritativeSourceIdentifier[] {
  const unique = new Map<string, AuthoritativeSourceIdentifier>();
  for (const identity of identifiers) unique.set(`${identity.authority}:${identity.identifier}`, identity);
  return [...unique.values()];
}

function sameSourceIdentifier(left: AuthoritativeSourceIdentifier, right: AuthoritativeSourceIdentifier): boolean {
  return left.authority === right.authority && left.identifier === right.identifier;
}

function groupSourceIdentifiers(identities: readonly AuthoritativeSourceIdentifier[]): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const identity of identities) {
    const identifiers = grouped.get(identity.authority) ?? new Set<string>();
    identifiers.add(identity.identifier);
    grouped.set(identity.authority, identifiers);
  }
  return grouped;
}

function addToIndex<T>(index: Map<string, Set<T>>, key: string, candidate: T): void {
  const bucket = index.get(key) ?? new Set<T>();
  bucket.add(candidate);
  index.set(key, bucket);
}

function removeFromIndex<T>(index: Map<string, Set<T>>, key: string, candidate: T): void {
  const bucket = index.get(key);
  if (!bucket) return;
  bucket.delete(candidate);
  if (!bucket.size) index.delete(key);
}

function foldText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
