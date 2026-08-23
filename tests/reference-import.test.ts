import { describe, expect, it } from "vitest";
import {
  bibliographicFingerprint,
  mergeAuthoritativeSourceIdentifiers,
  normalizeDoi,
  normalizeFirstAuthor,
  normalizeSourceIdentifier,
  PaperIdentityResolver,
  resolvePaperIdentity
} from "../src/main/services/paper-identity";
import {
  detectReferenceImportFormat,
  inferCsvColumnMapping,
  previewReferenceImport,
  REFERENCE_IMPORT_MAX_BYTES,
  REFERENCE_IMPORT_MAX_RECORDS,
  ReferenceImportService
} from "../src/main/services/reference-import-service";

describe("ReferenceImportService", () => {
  it("previews RIS records, including repeated authors and continued fields", () => {
    const preview = previewReferenceImport({
      format: "ris",
      content: [
        "TY  - JOUR",
        "TI  - Evidence-Grounded Reviews",
        "AU  - Doe, Jane",
        "AU  - Smith, Alex",
        "AB  - A structured abstract",
        "      continued on the next line.",
        "PY  - 2024/03/01",
        "DO  - https://doi.org/10.1000/ABC.",
        "UR  - https://example.test/article",
        "L1  - https://example.test/article.pdf",
        "JO  - Journal of Reviews",
        "AN  - PMID-123",
        "DP  - PubMed",
        "TC  - 17",
        "ER  -",
        "TY  - JOUR",
        "AU  - Missing, Title",
        "ER  -"
      ].join("\n")
    });

    expect(preview).toMatchObject({
      format: "ris",
      totalRecords: 2,
      canCommit: true
    });
    expect(preview.records).toHaveLength(1);
    expect(preview.invalidRecords).toEqual([
      expect.objectContaining({ recordNumber: 2, errors: ["Title is required."] })
    ]);
    expect(preview.records[0].paper).toMatchObject({
      title: "Evidence-Grounded Reviews",
      abstract: "A structured abstract continued on the next line.",
      authors: ["Doe, Jane", "Smith, Alex"],
      year: 2024,
      doi: "10.1000/abc",
      url: "https://example.test/article",
      pdfUrl: "https://example.test/article.pdf",
      venue: "Journal of Reviews",
      source: "reference-import",
      sourcePaperId: "PMID-123",
      sourceAuthority: "pubmed",
      citationCount: 17,
      isOpenAccess: false
    });
    expect(preview.records[0].provenance).toMatchObject({
      source: "reference-import",
      format: "ris",
      recordNumber: 1,
      sourceIdentifier: "PMID-123",
      sourceAuthority: "pubmed"
    });
  });

  it("parses nested BibTeX values and preserves source identity metadata", () => {
    const preview = previewReferenceImport({
      fileName: "library.bib",
      content: `
        @comment{ignored}
        @article{smith2023,
          title = {A {Grounded} Review},
          author = {Smith, Jane and {Evidence Consortium}},
          abstract = "An {auditable} result",
          year = 2023,
          doi = {doi:10.5555/EXAMPLE},
          url = {https://example.test/record},
          pdf = {https://example.test/record.pdf},
          journal = {Review Science},
          archivePrefix = {arXiv},
          eprint = {2301.12345v2},
          citationCount = {9}
        }
      `
    });

    expect(preview.fileErrors).toEqual([]);
    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].paper).toMatchObject({
      title: "A Grounded Review",
      authors: ["Smith, Jane", "Evidence Consortium"],
      abstract: "An auditable result",
      year: 2023,
      doi: "10.5555/example",
      sourcePaperId: "2301.12345v2",
      sourceAuthority: "arxiv",
      citationCount: 9
    });
  });

  it("reports malformed BibTeX and missing required titles per entry", () => {
    const missingTitle = previewReferenceImport({
      format: "bibtex",
      content: "@article{key, author={Doe, Jane}, year={2020}}"
    });
    expect(missingTitle.records).toEqual([]);
    expect(missingTitle.invalidRecords[0].errors).toContain("Title is required.");

    const malformed = previewReferenceImport({
      format: "bibtex",
      content: "@article{key, title={Never closed}"
    });
    expect(malformed.canCommit).toBe(false);
    expect(malformed.invalidRecords[0].errors[0]).toContain("no closing brace");
  });

  it("infers CSV columns and handles quoted commas, escaped quotes, and newlines", () => {
    const content = [
      "Paper Title,Authors,Abstract,Publication Year,DOI,Full Text URL,Citations",
      '"A CSV Study","Doe, Jane; Smith, Alex","First line',
      'second line with ""quoted"" text",2022,10.1000/csv,https://example.test/paper.pdf,4'
    ].join("\n");
    const preview = previewReferenceImport({ fileName: "references.csv", content });

    expect(preview.csv?.suggestedMapping).toMatchObject({
      title: "Paper Title",
      authors: "Authors",
      abstract: "Abstract",
      year: "Publication Year",
      pdfUrl: "Full Text URL",
      citationCount: "Citations"
    });
    expect(preview.records[0].paper).toMatchObject({
      title: "A CSV Study",
      authors: ["Doe, Jane", "Smith, Alex"],
      abstract: 'First line second line with "quoted" text',
      year: 2022,
      doi: "10.1000/csv",
      citationCount: 4
    });
  });

  it("applies editable CSV mappings and rejects unknown or absent title columns", () => {
    const service = new ReferenceImportService();
    const preview = service.preview({
      format: "csv",
      content: "Work,People,When,Identifier\nMapped study,Doe; Roe,2021,10.1234/mapped",
      csvMapping: {
        title: "Work",
        authors: "People",
        year: "When",
        doi: "Identifier"
      }
    });
    expect(preview.records[0].paper).toMatchObject({
      title: "Mapped study",
      authors: ["Doe", "Roe"],
      year: 2021,
      doi: "10.1234/mapped"
    });

    const missingTitle = service.preview({
      format: "csv",
      content: "Work,Year\nStudy,2020",
      csvMapping: { year: "Year" }
    });
    expect(missingTitle.canCommit).toBe(false);
    expect(missingTitle.fileErrors).toContain("CSV mapping must select a title column.");

    const unknownColumn = service.preview({
      format: "csv",
      content: "Title\nStudy",
      csvMapping: { title: "Not a column" }
    });
    expect(unknownColumn.fileErrors.join(" ")).toContain("unknown column");
  });

  it("reports invalid standard field values without discarding other rows", () => {
    const preview = previewReferenceImport({
      format: "csv",
      content: [
        "Title,Year,URL,Citation Count",
        "Bad study,unknown,relative/path,-1",
        "Good study,2020,https://example.test/good,2"
      ].join("\n")
    });

    expect(preview.records).toHaveLength(1);
    expect(preview.records[0].paper.title).toBe("Good study");
    expect(preview.invalidRecords[0].errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Year must contain"),
        expect.stringContaining("Citation count must"),
        expect.stringContaining("URL must be")
      ])
    );
  });

  it("enforces configurable test limits and exposes the production limits", () => {
    expect(REFERENCE_IMPORT_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(REFERENCE_IMPORT_MAX_RECORDS).toBe(50_000);

    const tooLarge = previewReferenceImport(
      { format: "csv", content: "Title\nA record that is too large" },
      { maxBytes: 10 }
    );
    expect(tooLarge.canCommit).toBe(false);
    expect(tooLarge.fileErrors[0]).toContain("10 bytes");

    const tooMany = previewReferenceImport({ format: "csv", content: "Title\nOne\nTwo\nThree" }, { maxRecords: 2 });
    expect(tooMany.canCommit).toBe(false);
    expect(tooMany.totalRecords).toBe(3);
    expect(tooMany.fileErrors[0]).toContain("at most 2 records");
  });

  it("detects supported formats without retaining a supplied path", () => {
    expect(detectReferenceImportFormat("C:\\private\\library.ris")).toBe("ris");
    expect(detectReferenceImportFormat(undefined, "@article{key, title={Study}}")).toBe("bibtex");
    expect(detectReferenceImportFormat(undefined, "Title,Year\nStudy,2020")).toBe("csv");
    expect(inferCsvColumnMapping(["ARTICLE_TITLE", "times-cited"])).toEqual({
      title: "ARTICLE_TITLE",
      citationCount: "times-cited"
    });
  });
});

describe("paper identity resolution", () => {
  it("normalizes DOI, source identifiers, and author name order", () => {
    expect(normalizeDoi(" https://doi.org/10.1000%2FABC. ")).toBe("10.1000/abc");
    expect(normalizeDoi("DOI: 10.5555/ABC-123")).toBe("10.5555/abc-123");
    expect(normalizeDoi("urn:doi:10.1002/(SICI)1099-0844(199912)17:4<290::AID-CBF849>3.0.CO;2-P")).toBe(
      "10.1002/(sici)1099-0844(199912)17:4<290::aid-cbf849>3.0.co;2-p"
    );
    expect(normalizeSourceIdentifier("https://arxiv.org/pdf/2301.12345v3.pdf", "arXiv")).toBe("2301.12345");
    expect(normalizeFirstAuthor("Jane Q. Doe")).toBe("doe:jq");
    expect(normalizeFirstAuthor("Doe, Jane Q.")).toBe("doe:jq");
  });

  it("treats placeholder and malformed DOI values as absent identity evidence", () => {
    const invalidDois = [
      "N/A",
      "unknown",
      "not available",
      "-",
      "arbitrary-reference-value",
      "10.123/too-short-prefix",
      "10.1234/contains whitespace",
      "10.1234/bad%ZZencoding"
    ];

    for (const doi of invalidDois) {
      expect(normalizeDoi(doi)).toBeUndefined();
      expect(
        resolvePaperIdentity({ title: `Incoming ${doi}`, doi }, [
          { id: `existing-${doi}`, title: `Unrelated ${doi}`, doi }
        ])
      ).toEqual({ kind: "none", candidates: [] });
    }
  });

  it("exact-matches equivalent valid DOI prefix and URL forms", () => {
    const candidates = [{ id: "valid-doi", title: "Stored record", doi: "DOI: 10.5555/ABC-123" }];

    expect(
      resolvePaperIdentity({ title: "Incoming record", doi: "https://doi.org/10.5555%2Fabc-123" }, candidates)
    ).toMatchObject({
      kind: "exact",
      strategy: "doi",
      candidate: { id: "valid-doi" }
    });
    expect(
      resolvePaperIdentity({ title: "Incoming record", doi: "URN:DOI:10.5555/ABC-123" }, candidates)
    ).toMatchObject({
      kind: "exact",
      strategy: "doi",
      candidate: { id: "valid-doi" }
    });
    expect(
      resolvePaperIdentity({ title: "Incoming record", doi: "http://dx.doi.org/10.5555/ABC-123." }, candidates)
    ).toMatchObject({ kind: "exact", strategy: "doi", candidate: { id: "valid-doi" } });
  });

  it("uses DOI, authoritative source IDs, then full bibliographic fingerprints", () => {
    const candidates = [
      {
        id: "doi-paper",
        title: "Different metadata",
        doi: "10.1000/exact",
        authors: ["One Author"],
        year: 2018
      },
      {
        id: "source-paper",
        title: "Source record",
        source: "arxiv",
        sourcePaperId: "2301.12345",
        authors: ["Two Author"],
        year: 2019
      },
      {
        id: "fingerprint-paper",
        title: "The Same: Study!",
        authors: ["Doe, Jane"],
        year: 2020
      }
    ];

    expect(resolvePaperIdentity({ title: "Incoming", doi: "https://doi.org/10.1000/EXACT" }, candidates)).toMatchObject(
      { kind: "exact", strategy: "doi", candidate: { id: "doi-paper" } }
    );
    expect(
      resolvePaperIdentity({ title: "Incoming", sourceAuthority: "arXiv", sourcePaperId: "2301.12345v2" }, candidates)
    ).toMatchObject({ kind: "exact", strategy: "source-identifier", candidate: { id: "source-paper" } });
    expect(
      resolvePaperIdentity({ title: "Incoming", sourceAuthority: "arXiv", sourcePaperId: "2301.12345v2" }, [
        {
          id: "imported-source-paper",
          title: "Imported source record",
          source: "reference-import",
          sourcePaperId: "2301.12345",
          raw: { sourceAuthority: "arxiv" }
        }
      ])
    ).toMatchObject({ kind: "exact", strategy: "source-identifier", candidate: { id: "imported-source-paper" } });
    expect(
      resolvePaperIdentity({ title: "The same study", authors: ["Jane Doe"], year: 2020 }, candidates)
    ).toMatchObject({
      kind: "exact",
      strategy: "bibliographic-fingerprint",
      candidate: { id: "fingerprint-paper" }
    });
    expect(bibliographicFingerprint({ title: "The same study", authors: ["Jane Doe"], year: 2020 })).toBe(
      "bibliographic:the same study|2020|doe:j"
    );
    expect(bibliographicFingerprint({ title: "临床试验结果", authors: ["王, 小明"], year: 2024 })).toBe(
      "bibliographic:临床试验结果|2024|王:小"
    );
  });

  it("never auto-merges a title-only match", () => {
    const result = resolvePaperIdentity({ title: "A Shared Title" }, [
      { id: "existing", title: "A shared title", authors: ["Someone Else"], year: 2019 }
    ]);
    expect(result).toMatchObject({
      kind: "ambiguous",
      strategy: "title-only",
      candidates: [{ id: "existing" }]
    });
  });

  it("returns ambiguity for duplicate fingerprints and conflicting persistent IDs", () => {
    const duplicateFingerprint = resolvePaperIdentity({ title: "Same", authors: ["Jane Doe"], year: 2020 }, [
      { id: "one", title: "Same", authors: ["Doe, Jane"], year: 2020 },
      { id: "two", title: "Same", authors: ["Jane Doe"], year: 2020 }
    ]);
    expect(duplicateFingerprint).toMatchObject({
      kind: "ambiguous",
      strategy: "bibliographic-fingerprint"
    });

    const conflicting = resolvePaperIdentity({ title: "Same", authors: ["Jane Doe"], year: 2020, doi: "10.1234/new" }, [
      { id: "old", title: "Same", authors: ["Doe, Jane"], year: 2020, doi: "10.1234/old" }
    ]);
    expect(conflicting).toMatchObject({ kind: "ambiguous", strategy: "conflicting-identifiers" });
  });

  it("supports incremental batch resolution", () => {
    const resolver = new PaperIdentityResolver<{ id: string; title: string; authors: string[]; year: number }>();
    expect(resolver.resolve({ title: "First" })).toEqual({ kind: "none", candidates: [] });
    resolver.add({ id: "first", title: "First", authors: ["Jane Doe"], year: 2024 });
    expect(resolver.list()).toHaveLength(1);
    expect(resolver.resolve({ title: "First", authors: ["Doe, Jane"], year: 2024 })).toMatchObject({
      kind: "exact",
      strategy: "bibliographic-fingerprint"
    });
  });

  it("rejects duplicate candidate IDs without corrupting the resolver", () => {
    const first = { id: "paper-1", title: "First", authors: ["Jane Doe"], year: 2024 };
    const second = { id: "paper-2", title: "Second", authors: ["Alex Smith"], year: 2023 };
    const resolver = new PaperIdentityResolver([first, second]);

    expect(() => resolver.add({ id: "paper-1", title: "Duplicate", authors: ["Taylor Jones"], year: 2022 })).toThrow(
      "duplicate paper identity candidate ID: paper-1"
    );
    expect(() => resolver.replace(first, { ...first, id: "paper-2" })).toThrow("duplicate ID: paper-2");

    expect(resolver.list()).toEqual([first, second]);
    expect(resolver.resolve({ title: "First", authors: ["Doe, Jane"], year: 2024 })).toMatchObject({
      kind: "exact",
      candidate: { id: "paper-1" }
    });
  });

  it("retains a foreign authoritative identifier without assigning it to the wrong source", () => {
    const current = {
      id: "crossref-paper",
      title: "Shared record",
      source: "crossref",
      authors: ["Jane Doe"],
      year: 2024
    };
    const identity = mergeAuthoritativeSourceIdentifiers(current, {
      title: "Shared record",
      source: "openalex",
      sourcePaperId: "https://openalex.org/W123"
    });

    expect(identity.sourcePaperId).toBeUndefined();
    expect(identity.raw.identitySourceIdentifiers).toEqual([{ authority: "openalex", identifier: "w123" }]);
    expect(
      resolvePaperIdentity({ title: "Updated title", source: "openalex", sourcePaperId: "W123" }, [
        { ...current, raw: identity.raw }
      ])
    ).toMatchObject({ kind: "exact", strategy: "source-identifier", candidate: { id: "crossref-paper" } });
  });

  it("indexes the full 50,000-record import limit and updates keys incrementally", () => {
    const candidates = Array.from({ length: REFERENCE_IMPORT_MAX_RECORDS }, (_, index) => ({
      id: `paper-${index}`,
      title: `Unique paper ${index}`,
      authors: [`Author ${index}`],
      year: 2020,
      source: "openalex",
      sourcePaperId: `W${index}`
    }));
    const resolver = new PaperIdentityResolver(candidates);

    expect(resolver.resolve({ title: "Changed title", source: "openalex", sourcePaperId: "W49999" })).toMatchObject({
      kind: "exact",
      strategy: "source-identifier",
      candidate: { id: "paper-49999" }
    });

    const previous = candidates[12345];
    const enriched = { ...previous, doi: "10.1000/new-identifier" };
    resolver.replace({ ...previous }, enriched);
    expect(resolver.resolve({ title: "Unrelated", doi: "10.1000/new-identifier" })).toMatchObject({
      kind: "exact",
      strategy: "doi",
      candidate: { id: "paper-12345" }
    });
  });

  it("keeps repeated replacement lookups bounded instead of scanning the candidate set", () => {
    type CountedCandidate = {
      id: string;
      title: string;
      authors: string[];
      year: number;
      source: string;
      sourcePaperId: string;
    };
    let storedIdReads = 0;
    const candidateCount = 4_000;
    const replacementCount = 250;
    const candidates = Array.from({ length: candidateCount }, (_, index) => {
      const candidate = {
        title: `Scale paper ${index}`,
        authors: [`Author ${index}`],
        year: 2020,
        source: "openalex",
        sourcePaperId: `W${index}`
      } as CountedCandidate;
      Object.defineProperty(candidate, "id", {
        configurable: false,
        enumerable: true,
        get: () => {
          storedIdReads += 1;
          return `paper-${index}`;
        }
      });
      return candidate;
    });
    const resolver = new PaperIdentityResolver(candidates);
    storedIdReads = 0;

    for (let offset = 0; offset < replacementCount; offset += 1) {
      const index = candidateCount - replacementCount + offset;
      resolver.replace(
        {
          id: `paper-${index}`,
          title: "Lookup placeholder",
          authors: [],
          year: 2020,
          source: "openalex",
          sourcePaperId: `W${index}`
        },
        {
          id: `paper-${index}`,
          title: `Enriched scale paper ${index}`,
          authors: [`Author ${index}`],
          year: 2020,
          source: "openalex",
          sourcePaperId: `W${index}`
        }
      );
    }

    expect(storedIdReads).toBeLessThanOrEqual(replacementCount);
    expect(resolver.list()).toHaveLength(candidateCount);
    expect(resolver.resolve({ title: "Unrelated", source: "openalex", sourcePaperId: "W3999" })).toMatchObject({
      kind: "exact",
      candidate: { id: "paper-3999", title: "Enriched scale paper 3999" }
    });
  });
});
