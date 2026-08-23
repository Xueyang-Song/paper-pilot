import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
  ActivateReviewRequest,
  AttachReviewPaperPdfRequest,
  CancelReviewRunRequest,
  DiscoveryBatch,
  ExportReviewRequest,
  ExtractionField,
  ExtractionFieldType,
  ExtractionPrimitiveValue,
  ExtractionValue,
  FetchReviewPaperFullTextRequest,
  MarkReviewPapersForReviewRequest,
  Paper,
  ReferenceImportCommitRequest,
  ReferenceImportCommitResponse,
  ReferenceImportMapping,
  ReferenceImportPreview,
  ReferenceImportPreviewRequest,
  ReorderExtractionFieldsRequest,
  RetryReviewRunRequest,
  ReviewCriterion,
  ReviewEvidence,
  ReviewFlowSummary,
  ReviewPaperPage,
  ReviewPaperQuery,
  ReviewPaperSummary,
  ReviewProtocol,
  ReviewProtocolRevision,
  ReviewRun,
  ReviewRunEvent,
  ReviewRunItem,
  ReviewStage,
  ReviewTemplate,
  ReviseReviewProtocolRequest,
  SaveExtractionValueRequest,
  SaveScreeningDecisionRequest,
  ScreeningDecision,
  ScreeningDecisionValue,
  StartReviewRunRequest,
  UpsertExtractionFieldRequest
} from "../../shared/schemas";
import { isBlankExtractionValue, MAX_EXTRACTION_FIELDS, MAX_REVIEW_BATCH_PAPERS } from "../../shared/schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ReviewView = "protocol" | "discover" | "abstract" | "full-text" | "extract" | "summary";

export interface ReviewState {
  protocol: ReviewProtocol;
  revision: ReviewProtocolRevision;
}

interface ReviewApi {
  getProjectBundle?(projectId: string): Promise<{ papers: Paper[] }>;
  getReview(projectId: string): Promise<ReviewState | undefined>;
  activateReview(input: ActivateReviewRequest): Promise<ReviewState>;
  listReviewProtocolRevisions(reviewId: string): Promise<ReviewProtocolRevision[]>;
  reviseReviewProtocol(input: ReviseReviewProtocolRequest): Promise<ReviewProtocolRevision>;
  listReviewPapers(input: ReviewPaperQuery): Promise<ReviewPaperPage>;
  listDiscoveryBatches(reviewId: string): Promise<DiscoveryBatch[]>;
  previewReferenceImport(input: ReferenceImportPreviewRequest): Promise<ReferenceImportPreview | undefined>;
  remapReferenceImport(input: { previewId: string; mapping: ReferenceImportMapping }): Promise<ReferenceImportPreview>;
  commitReferenceImport(input: ReferenceImportCommitRequest): Promise<ReferenceImportCommitResponse>;
  saveScreeningDecision(input: SaveScreeningDecisionRequest): Promise<ScreeningDecision>;
  markReviewPapersForReview(input: MarkReviewPapersForReviewRequest): Promise<{ ok: boolean }>;
  listExtractionFields(reviewId: string): Promise<ExtractionField[]>;
  upsertExtractionField(input: UpsertExtractionFieldRequest): Promise<ExtractionField>;
  reorderExtractionFields(input: ReorderExtractionFieldsRequest): Promise<ExtractionField[]>;
  listExtractionValues(input: { reviewId: string; paperIds?: string[] }): Promise<ExtractionValue[]>;
  listReviewEvidence(input: { reviewId: string; evidenceIds?: string[] }): Promise<ReviewEvidence[]>;
  saveExtractionValue(input: SaveExtractionValueRequest): Promise<ExtractionValue>;
  startReviewRun(input: StartReviewRunRequest): Promise<ReviewRun>;
  cancelReviewRun(input: CancelReviewRunRequest): Promise<ReviewRun | { cancelled: boolean }>;
  retryReviewRun(input: RetryReviewRunRequest): Promise<ReviewRun>;
  listReviewRuns(reviewId: string): Promise<ReviewRun[]>;
  listReviewRunItems(runId: string): Promise<ReviewRunItem[]>;
  onReviewRunEvent?(listener: (event: ReviewRunEvent) => void): () => void;
  getReviewSummary(reviewId: string): Promise<ReviewFlowSummary>;
  fetchReviewPaperFullText(input: FetchReviewPaperFullTextRequest): Promise<ReviewFileActionResult>;
  attachReviewPaperPdf(input: AttachReviewPaperPdfRequest): Promise<ReviewFileActionResult>;
  exportReview(input: ExportReviewRequest): Promise<{ ok: boolean; path?: string }>;
}

interface ReviewFileActionResult {
  ok: boolean;
  artifactId?: string;
  warning?: string;
}

const reviewViews: Array<{ id: ReviewView; label: string }> = [
  { id: "protocol", label: "Protocol" },
  { id: "discover", label: "Discover" },
  { id: "abstract", label: "Abstract" },
  { id: "full-text", label: "Full text" },
  { id: "extract", label: "Extract" },
  { id: "summary", label: "Summary" }
];

const AMBIGUOUS_IMPORT_PAGE_SIZE = 50;

const paperSourceFilters: Array<{ value: ReviewPaperSummary["source"]; label: string }> = [
  { value: "reference-import", label: "Reference import" },
  { value: "openalex", label: "OpenAlex" },
  { value: "crossref", label: "Crossref" },
  { value: "semantic-scholar", label: "Semantic Scholar" },
  { value: "pubmed", label: "PubMed" },
  { value: "arxiv", label: "arXiv" },
  { value: "europe-pmc", label: "Europe PMC" },
  { value: "core", label: "CORE" },
  { value: "unpaywall", label: "Unpaywall" },
  { value: "google-scholar", label: "Google Scholar" }
];

function api(): ReviewApi {
  return window.paperPilot as unknown as ReviewApi;
}

interface SuggestionSelection {
  run: ReviewRun;
  item: ReviewRunItem;
  runOrder: number;
  itemOrder: number;
}

function suggestionKey(stage: ReviewStage, paperId: string): string {
  return `${stage}\u0000${paperId}`;
}

function isActionableSuggestion(run: ReviewRun, item: ReviewRunItem): boolean {
  if (item.status !== "completed") return false;
  return run.stage === "extraction" ? item.extractionSuggestions.length > 0 : item.suggestedDecision !== undefined;
}

function suggestionTime(selection: SuggestionSelection): number {
  for (const value of [selection.item.completedAt, selection.item.updatedAt, selection.run.updatedAt]) {
    const timestamp = value ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function preferredSuggestion(
  current: SuggestionSelection | undefined,
  candidate: SuggestionSelection,
  currentRevisionId: string
): SuggestionSelection {
  if (!current) return candidate;
  const currentProtocol = current.run.protocolRevisionId === currentRevisionId;
  const candidateProtocol = candidate.run.protocolRevisionId === currentRevisionId;
  if (currentProtocol !== candidateProtocol) return candidateProtocol ? candidate : current;
  const currentFresh = !current.item.stale;
  const candidateFresh = !candidate.item.stale;
  if (currentFresh !== candidateFresh) return candidateFresh ? candidate : current;
  const timeDifference = suggestionTime(candidate) - suggestionTime(current);
  if (timeDifference !== 0) return timeDifference > 0 ? candidate : current;
  const runUpdateDifference = Date.parse(candidate.run.updatedAt) - Date.parse(current.run.updatedAt);
  if (Number.isFinite(runUpdateDifference) && runUpdateDifference !== 0) {
    return runUpdateDifference > 0 ? candidate : current;
  }
  const runCreationDifference = Date.parse(candidate.run.createdAt) - Date.parse(current.run.createdAt);
  if (Number.isFinite(runCreationDifference) && runCreationDifference !== 0) {
    return runCreationDifference > 0 ? candidate : current;
  }
  // listReviewRuns is newest-first; use its authoritative order for timestamp ties.
  if (candidate.runOrder !== current.runOrder) return candidate.runOrder < current.runOrder ? candidate : current;
  if (candidate.itemOrder !== current.itemOrder) return candidate.itemOrder > current.itemOrder ? candidate : current;
  return current;
}

function latestRun(runs: ReviewRun[]): ReviewRun | undefined {
  let selected: { run: ReviewRun; order: number } | undefined;
  runs.forEach((run, order) => {
    if (!selected) {
      selected = { run, order };
      return;
    }
    const difference = Date.parse(run.updatedAt) - Date.parse(selected.run.updatedAt);
    if (difference > 0 || (difference === 0 && order < selected.order)) selected = { run, order };
  });
  return selected?.run;
}

export function ReviewWorkspace(props: {
  projectId?: string;
  projectTitle?: string;
  onOpenArtifact?(artifactId: string, page?: number): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [view, setView] = useState<ReviewView>("protocol");
  const [activeRun, setActiveRun] = useState<ReviewRun>();
  const [runProgress, setRunProgress] = useState({ completed: 0, failed: 0, cancelled: 0, total: 0 });
  const [suggestions, setSuggestions] = useState<Record<string, SuggestionSelection>>({});

  useEffect(() => {
    setView("protocol");
    setActiveRun(undefined);
    setRunProgress({ completed: 0, failed: 0, cancelled: 0, total: 0 });
    setSuggestions({});
  }, [props.projectId]);

  const reviewQuery = useQuery({
    queryKey: ["review", props.projectId],
    queryFn: () => api().getReview(props.projectId!),
    enabled: Boolean(props.projectId),
    retry: false
  });
  const review = reviewQuery.data;
  const protocolHistoryQuery = useQuery({
    queryKey: ["review-protocol-history", review?.protocol.id],
    queryFn: () => api().listReviewProtocolRevisions(review!.protocol.id),
    enabled: Boolean(review)
  });
  const runsQuery = useQuery({
    queryKey: ["review-runs", review?.protocol.id],
    queryFn: () => api().listReviewRuns(review!.protocol.id),
    enabled: Boolean(review)
  });
  const knownRuns = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const persistedRun =
    latestRun(knownRuns.filter((run) => run.status === "queued" || run.status === "running")) ?? latestRun(knownRuns);
  const runItemsQuery = useQuery({
    queryKey: ["review-run-items", review?.protocol.id, knownRuns.map((run) => run.id)],
    queryFn: async () =>
      Promise.all(
        knownRuns.map(async (run, runOrder) => ({ run, runOrder, items: await api().listReviewRunItems(run.id) }))
      ),
    enabled: knownRuns.length > 0
  });

  useEffect(() => {
    if (!persistedRun) return;
    setActiveRun((current) =>
      current?.id === persistedRun.id && current.updatedAt >= persistedRun.updatedAt ? current : persistedRun
    );
    setRunProgress({
      completed: persistedRun.completedCount,
      failed: persistedRun.failedCount,
      cancelled: persistedRun.cancelledCount,
      total: persistedRun.paperIds.length
    });
  }, [persistedRun]);

  useEffect(() => {
    if (!runItemsQuery.data) return;
    const latestByStageAndPaper: Record<string, SuggestionSelection> = {};
    for (const { run, runOrder, items } of runItemsQuery.data) {
      items.forEach((item, itemOrder) => {
        if (!isActionableSuggestion(run, item)) return;
        const key = suggestionKey(run.stage, item.paperId);
        latestByStageAndPaper[key] = preferredSuggestion(
          latestByStageAndPaper[key],
          { run, item, runOrder, itemOrder },
          review!.revision.id
        );
      });
    }
    setSuggestions(latestByStageAndPaper);
  }, [review, runItemsQuery.data]);

  useEffect(() => {
    const subscribe = api().onReviewRunEvent;
    if (!subscribe || !review) return;
    return subscribe((event) => {
      if (event.reviewId !== review.protocol.id) return;
      if (event.type === "status") {
        setActiveRun((current) => (current?.id === event.runId ? { ...current, status: event.status } : current));
      } else if (event.type === "progress") {
        setRunProgress({
          completed: event.completed,
          failed: event.failed,
          cancelled: event.cancelled,
          total: event.total
        });
      } else if (event.type === "item") {
        const eventRun =
          knownRuns.find((run) => run.id === event.runId) ?? (activeRun?.id === event.runId ? activeRun : undefined);
        if (eventRun && isActionableSuggestion(eventRun, event.item)) {
          const key = suggestionKey(eventRun.stage, event.item.paperId);
          const candidate = { run: eventRun, item: event.item, runOrder: -1, itemOrder: 0 };
          setSuggestions((current) => ({
            ...current,
            [key]: preferredSuggestion(current[key], candidate, review.revision.id)
          }));
        }
      } else if (event.type === "complete") {
        setActiveRun(event.run);
        void invalidateReviewData(queryClient, event.reviewId);
      } else if (event.type === "error") {
        setActiveRun((current) =>
          current?.id === event.runId ? { ...current, status: event.status, error: event.error } : current
        );
      }
    });
  }, [activeRun, knownRuns, queryClient, review]);

  const activate = useMutation({
    mutationFn: (input: ActivateReviewRequest) => api().activateReview(input),
    onSuccess: (state) => {
      queryClient.setQueryData(["review", props.projectId], state);
      setView("protocol");
    }
  });

  const revise = useMutation({
    mutationFn: (input: ReviseReviewProtocolRequest) => api().reviseReviewProtocol(input),
    onSuccess: (revision) => {
      queryClient.setQueryData<ReviewState>(["review", props.projectId], (current) =>
        current
          ? {
              protocol: {
                ...current.protocol,
                currentRevisionId: revision.id,
                currentRevisionNumber: revision.version,
                updatedAt: revision.createdAt
              },
              revision
            }
          : current
      );
      void queryClient.invalidateQueries({ queryKey: ["review-protocol-history", revision.reviewId] });
      void invalidateReviewData(queryClient, revision.reviewId);
    }
  });

  const startRun = useMutation({
    mutationFn: (input: StartReviewRunRequest) => api().startReviewRun(input),
    onSuccess: (run) => {
      setActiveRun(run);
      setRunProgress({ completed: 0, failed: 0, cancelled: 0, total: run.paperIds.length });
      void queryClient.invalidateQueries({ queryKey: ["review-runs", run.reviewId] });
    }
  });

  const cancelRun = useMutation({
    mutationFn: (input: CancelReviewRunRequest) => api().cancelReviewRun(input),
    onSuccess: () => {
      setActiveRun((current) => (current ? { ...current, status: "cancelled" } : current));
    }
  });

  const retryRun = useMutation({
    mutationFn: (input: RetryReviewRunRequest) => api().retryReviewRun(input),
    onSuccess: (run) => {
      setActiveRun(run);
      setRunProgress({ completed: 0, failed: 0, cancelled: 0, total: run.paperIds.length });
      void queryClient.invalidateQueries({ queryKey: ["review-runs", run.reviewId] });
    }
  });

  if (!props.projectId) return <EmptyReview message="Select a project to begin an evidence review." />;
  if (reviewQuery.isPending) return <EmptyReview message="Loading evidence review…" />;
  if (reviewQuery.isError) {
    return (
      <EmptyReview
        message={`The evidence review could not be loaded: ${errorMessage(reviewQuery.error)}`}
        action={<Button onClick={() => void reviewQuery.refetch()}>Retry</Button>}
      />
    );
  }
  if (!review) {
    return (
      <ReviewActivation
        projectId={props.projectId}
        projectTitle={props.projectTitle}
        busy={activate.isPending}
        error={activate.error}
        onActivate={(input) => activate.mutate(input)}
      />
    );
  }

  const running = activeRun?.status === "queued" || activeRun?.status === "running";
  const runControls = (
    <RunStatus
      run={activeRun}
      progress={runProgress}
      onCancel={() => activeRun && cancelRun.mutate({ runId: activeRun.id })}
      onRetry={() => activeRun && retryRun.mutate({ runId: activeRun.id })}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-testid="review-workspace">
      <header className="border-b border-border bg-card px-5 pt-4">
        <div className="flex items-start justify-between gap-4 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">Evidence review</h1>
              <Badge variant="secondary">Protocol v{review.revision.version}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Human-confirmed screening and extraction with an append-only audit trail.
            </p>
          </div>
          {runControls}
        </div>
        {startRun.error || cancelRun.error || retryRun.error || runsQuery.error || runItemsQuery.error ? (
          <div className="pb-3">
            <InlineError
              error={startRun.error ?? cancelRun.error ?? retryRun.error ?? runsQuery.error ?? runItemsQuery.error}
            />
          </div>
        ) : null}
        <nav aria-label="Review stages" className="flex gap-1 overflow-x-auto">
          {reviewViews.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
              className={cn(
                "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                view === item.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {view === "protocol" ? (
          <ProtocolEditor
            protocol={review.protocol}
            revision={review.revision}
            history={protocolHistoryQuery.data ?? [review.revision]}
            busy={revise.isPending}
            error={revise.error ?? protocolHistoryQuery.error}
            onSave={(input) => revise.mutate(input)}
          />
        ) : null}
        {view === "discover" ? <DiscoverStage reviewId={review.protocol.id} projectId={props.projectId} /> : null}
        {view === "abstract" || view === "full-text" ? (
          <ScreeningStage
            reviewId={review.protocol.id}
            projectId={props.projectId}
            protocolRevisionId={review.revision.id}
            criteria={review.revision.criteria}
            stage={view === "abstract" ? "title-abstract" : "full-text"}
            suggestions={suggestions}
            runBusy={running || startRun.isPending}
            onOpenArtifact={props.onOpenArtifact}
            onStartRun={(input) => startRun.mutate(input)}
          />
        ) : null}
        {view === "extract" ? (
          <ExtractionStage
            reviewId={review.protocol.id}
            suggestions={suggestions}
            runBusy={running || startRun.isPending}
            onOpenArtifact={props.onOpenArtifact}
            onStartRun={(input) => startRun.mutate(input)}
          />
        ) : null}
        {view === "summary" ? <SummaryStage reviewId={review.protocol.id} /> : null}
      </div>
    </div>
  );
}

function EmptyReview(props: { message: string; action?: JSX.Element }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <p className="text-sm text-muted-foreground">{props.message}</p>
        {props.action ? <div className="mt-4">{props.action}</div> : null}
      </div>
    </div>
  );
}

const templateContent: Record<
  ReviewTemplate,
  { name: string; description: string; question: string; objectives: string[]; criteria: ReviewCriterion[] }
> = {
  blank: {
    name: "Blank review",
    description: "Start with an empty protocol and define your own review structure.",
    question: "",
    objectives: [],
    criteria: []
  },
  "general-empirical": {
    name: "Empirical studies",
    description: "A discipline-neutral starting point for empirical evidence.",
    question: "What does the available empirical evidence show about the research topic?",
    objectives: ["Identify relevant empirical studies", "Compare reported methods and outcomes"],
    criteria: [
      criterion("general-ta-include", "title-abstract", "inclusion", "Addresses the research question", 0),
      criterion("general-ft-exclude", "full-text", "exclusion", "No empirical results", 0)
    ]
  },
  pico: {
    name: "PICO-style review",
    description: "Frame evidence around population, intervention, comparator, and outcome.",
    question: "In [population], how does [intervention] compared with [comparator] affect [outcome]?",
    objectives: ["Assess eligible populations and interventions", "Extract comparator and outcome data"],
    criteria: [
      criterion("pico-ta-population", "title-abstract", "inclusion", "Eligible population", 0),
      criterion("pico-ta-intervention", "title-abstract", "inclusion", "Relevant intervention", 1),
      criterion("pico-ft-outcome", "full-text", "exclusion", "Does not report an eligible outcome", 0)
    ]
  }
};

function ReviewActivation(props: {
  projectId: string;
  projectTitle?: string;
  busy: boolean;
  error: unknown;
  onActivate(input: ActivateReviewRequest): void;
}): JSX.Element {
  const [template, setTemplate] = useState<ReviewTemplate>("blank");
  const selected = templateContent[template];
  const [question, setQuestion] = useState(selected.question);
  const [objectives, setObjectives] = useState(selected.objectives.join("\n"));

  const chooseTemplate = (next: ReviewTemplate): void => {
    setTemplate(next);
    setQuestion(templateContent[next].question);
    setObjectives(templateContent[next].objectives.join("\n"));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6" data-testid="review-activation">
      <div className="mx-auto max-w-4xl">
        <Badge variant="secondary">Solo evidence review</Badge>
        <h1 className="mt-3 text-2xl font-semibold">Set up an auditable review</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Add a versioned protocol to {props.projectTitle ?? "this project"}. Existing papers will enter a pending
          screening queue without changing their reading status.
        </p>

        <fieldset className="mt-6 grid gap-3 md:grid-cols-3">
          <legend className="sr-only">Review template</legend>
          {(Object.entries(templateContent) as Array<[ReviewTemplate, (typeof templateContent)[ReviewTemplate]]>).map(
            ([id, item]) => (
              <button
                key={id}
                type="button"
                aria-pressed={template === id}
                onClick={() => chooseTemplate(id)}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  template === id ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/50"
                )}
              >
                <span className="block font-medium">{item.name}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{item.description}</span>
              </button>
            )
          )}
        </fieldset>

        <Card className="mt-5 gap-4 p-5">
          <label className="grid gap-1.5 text-sm font-medium">
            Research question
            <Textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="What question will this review answer?"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Objectives <span className="font-normal text-muted-foreground">One per line</span>
            <Textarea
              value={objectives}
              onChange={(event) => setObjectives(event.target.value)}
              placeholder="Identify relevant studies"
            />
          </label>
          <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            Activation records {templateContent[template].criteria.length} starter criteria and creates a “Pre-existing
            project papers” discovery batch. If papers already exist, historical duplicate counts will be marked
            unavailable.
          </div>
          {props.error ? <InlineError error={props.error} /> : null}
          <div className="flex justify-end">
            <Button
              disabled={props.busy}
              onClick={() =>
                props.onActivate({
                  projectId: props.projectId,
                  template,
                  researchQuestion: question,
                  objectives: lines(objectives),
                  criteria: templateContent[template].criteria
                })
              }
            >
              {props.busy ? "Activating…" : "Activate review"}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ProtocolEditor(props: {
  protocol: ReviewProtocol;
  revision: ReviewProtocolRevision;
  history: ReviewProtocolRevision[];
  busy: boolean;
  error: unknown;
  onSave(input: ReviseReviewProtocolRequest): void;
}): JSX.Element {
  const [question, setQuestion] = useState(props.revision.researchQuestion);
  const [objectives, setObjectives] = useState(props.revision.objectives.join("\n"));
  const [criteria, setCriteria] = useState(() => criterionDraft(props.revision.criteria));
  const [changeNote, setChangeNote] = useState("");

  useEffect(() => {
    setQuestion(props.revision.researchQuestion);
    setObjectives(props.revision.objectives.join("\n"));
    setCriteria(criterionDraft(props.revision.criteria));
    setChangeNote("");
  }, [props.revision]);

  const nextCriteria = (): ReviewCriterion[] => {
    const groups: Array<{
      value: string;
      stage: ReviewCriterion["stage"];
      type: ReviewCriterion["type"];
      prefix: string;
    }> = [
      { value: criteria.abstractInclusion, stage: "title-abstract", type: "inclusion", prefix: "ta-i" },
      { value: criteria.abstractExclusion, stage: "title-abstract", type: "exclusion", prefix: "ta-e" },
      { value: criteria.fullTextInclusion, stage: "full-text", type: "inclusion", prefix: "ft-i" },
      { value: criteria.fullTextExclusion, stage: "full-text", type: "exclusion", prefix: "ft-e" }
    ];
    return groups.flatMap((group) =>
      lines(group.value).map((label, order) =>
        criterion(`${group.prefix}-${slug(label)}-${order}`, group.stage, group.type, label, order)
      )
    );
  };

  return (
    <section aria-labelledby="protocol-heading" className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="protocol-heading" className="text-xl font-semibold">
            Review protocol
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Revisions preserve decisions but mark prior AI suggestions stale. Template: {props.protocol.template}.
          </p>
        </div>
        <Badge variant={props.protocol.historicalCountsAvailable ? "secondary" : "outline"}>
          {props.protocol.historicalCountsAvailable ? "Complete provenance counts" : "Historical counts unavailable"}
        </Badge>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Card className="gap-4 p-5 lg:col-span-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Research question
            <Textarea value={question} onChange={(event) => setQuestion(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Objectives <span className="font-normal text-muted-foreground">One per line</span>
            <Textarea value={objectives} onChange={(event) => setObjectives(event.target.value)} />
          </label>
        </Card>
        <CriteriaCard
          title="Title and abstract criteria"
          inclusion={criteria.abstractInclusion}
          exclusion={criteria.abstractExclusion}
          onInclusion={(value) => setCriteria((current) => ({ ...current, abstractInclusion: value }))}
          onExclusion={(value) => setCriteria((current) => ({ ...current, abstractExclusion: value }))}
        />
        <CriteriaCard
          title="Full-text criteria"
          inclusion={criteria.fullTextInclusion}
          exclusion={criteria.fullTextExclusion}
          onInclusion={(value) => setCriteria((current) => ({ ...current, fullTextInclusion: value }))}
          onExclusion={(value) => setCriteria((current) => ({ ...current, fullTextExclusion: value }))}
        />
        <Card className="gap-3 p-5 lg:col-span-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Revision note
            <Input
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              placeholder="Why is the protocol changing?"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Saving creates protocol version {props.revision.version + 1}; previous versions remain auditable.
          </p>
          {props.error ? <InlineError error={props.error} /> : null}
          <div className="flex justify-end">
            <Button
              disabled={props.busy}
              onClick={() =>
                props.onSave({
                  reviewId: props.protocol.id,
                  expectedVersion: props.revision.version,
                  researchQuestion: question,
                  objectives: lines(objectives),
                  criteria: nextCriteria(),
                  changeNote: changeNote.trim() || undefined
                })
              }
            >
              {props.busy ? "Saving revision…" : "Save new protocol version"}
            </Button>
          </div>
        </Card>
        <Card className="gap-3 p-5 lg:col-span-2">
          <h3 className="font-medium">Protocol history</h3>
          <ol className="grid gap-2">
            {[...props.history]
              .sort((left, right) => right.version - left.version)
              .map((item) => (
                <li key={item.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong>Version {item.version}</strong>
                    <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {item.changeNote ?? (item.version === 1 ? "Initial protocol" : "No revision note")}
                  </p>
                  <p className="mt-2 line-clamp-2">{item.researchQuestion || "No research question specified."}</p>
                </li>
              ))}
          </ol>
        </Card>
      </div>
    </section>
  );
}

function CriteriaCard(props: {
  title: string;
  inclusion: string;
  exclusion: string;
  onInclusion(value: string): void;
  onExclusion(value: string): void;
}): JSX.Element {
  return (
    <Card className="gap-4 p-5">
      <h3 className="font-medium">{props.title}</h3>
      <label className="grid gap-1.5 text-sm">
        Inclusion criteria <span className="text-xs text-muted-foreground">One per line</span>
        <Textarea value={props.inclusion} onChange={(event) => props.onInclusion(event.target.value)} />
      </label>
      <label className="grid gap-1.5 text-sm">
        Exclusion criteria <span className="text-xs text-muted-foreground">One per line</span>
        <Textarea value={props.exclusion} onChange={(event) => props.onExclusion(event.target.value)} />
      </label>
    </Card>
  );
}

function DiscoverStage(props: { reviewId: string; projectId: string }): JSX.Element {
  const queryClient = useQueryClient();
  const [preview, setPreview] = useState<ReferenceImportPreview>();
  const [mapping, setMapping] = useState<Partial<ReferenceImportMapping>>({});
  const [resolutions, setResolutions] = useState<Record<number, "keep-separate" | "merge" | "skip">>({});
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({});
  const [importNotice, setImportNotice] = useState<string>();
  const [mappingApplied, setMappingApplied] = useState(true);
  const [ambiguousPage, setAmbiguousPage] = useState(1);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewFilter, setPreviewFilter] = useState<"all" | "invalid">("all");

  const applyPreview = (result: ReferenceImportPreview, useSuggestedMapping: boolean): void => {
    setPreview(result);
    if (useSuggestedMapping) setMapping(result.suggestedMapping ?? {});
    setResolutions({});
    setMergeTargets(
      Object.fromEntries(
        result.items
          .filter((item) => item.match.kind === "ambiguous" && item.match.candidatePaperIds.length)
          .map((item) => [item.recordIndex, item.match.candidatePaperIds[0]])
      )
    );
    setMappingApplied(true);
    setAmbiguousPage(1);
    setPreviewPage(1);
    setPreviewFilter("all");
  };

  const batchesQuery = useQuery({
    queryKey: ["review-discovery", props.reviewId],
    queryFn: () => api().listDiscoveryBatches(props.reviewId)
  });
  const previewImport = useMutation({
    mutationFn: () => api().previewReferenceImport({ projectId: props.projectId, reviewId: props.reviewId }),
    onSuccess: (result) => {
      if (!result) {
        setImportNotice("No reference file was selected.");
        return;
      }
      setImportNotice(undefined);
      applyPreview(result, true);
    }
  });
  const remapImport = useMutation({
    mutationFn: () =>
      api().remapReferenceImport({
        previewId: preview!.previewId,
        mapping: mapping as ReferenceImportMapping
      }),
    onSuccess: (result) => {
      applyPreview(result, false);
      setImportNotice("CSV mapping applied. The preview and match resolutions have been refreshed.");
    }
  });
  const commitImport = useMutation({
    mutationFn: (input: ReferenceImportCommitRequest) => api().commitReferenceImport(input),
    onMutate: () => setImportNotice(undefined),
    onSuccess: (result) => {
      setPreview(undefined);
      setImportNotice(
        `Import complete: ${result.counts.newRecords.toLocaleString()} new, ${result.counts.duplicates.toLocaleString()} duplicate, ${result.counts.merged.toLocaleString()} merged, and ${result.counts.invalid.toLocaleString()} invalid records.`
      );
      void queryClient.invalidateQueries({ queryKey: ["review-discovery", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-summary", props.reviewId] });
    }
  });

  const ambiguous = preview?.items.filter((item) => item.match.kind === "ambiguous") ?? [];
  const unresolvedAmbiguous = ambiguous.filter((item) => resolutions[item.recordIndex] === undefined);
  const ambiguousTotalPages = Math.max(1, Math.ceil(ambiguous.length / AMBIGUOUS_IMPORT_PAGE_SIZE));
  const visibleAmbiguous = ambiguous.slice(
    (ambiguousPage - 1) * AMBIGUOUS_IMPORT_PAGE_SIZE,
    ambiguousPage * AMBIGUOUS_IMPORT_PAGE_SIZE
  );
  const filteredPreviewItems = preview?.items.filter((item) => previewFilter === "all" || !item.valid) ?? [];
  const previewTotalPages = Math.max(1, Math.ceil(filteredPreviewItems.length / AMBIGUOUS_IMPORT_PAGE_SIZE));
  const visiblePreviewItems = filteredPreviewItems.slice(
    (previewPage - 1) * AMBIGUOUS_IMPORT_PAGE_SIZE,
    previewPage * AMBIGUOUS_IMPORT_PAGE_SIZE
  );
  const csvMappingReady = preview?.format !== "csv" || (Boolean(mapping.title) && mappingApplied);

  return (
    <section aria-labelledby="discover-heading" className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="discover-heading" className="text-xl font-semibold">
            Discover and import
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            RIS, BibTeX, and CSV files are previewed before any project data changes.
          </p>
        </div>
        <Button disabled={previewImport.isPending} onClick={() => previewImport.mutate()}>
          {previewImport.isPending ? "Reading file…" : "Import references"}
        </Button>
      </div>
      {previewImport.error ? (
        <div className="mt-3">
          <InlineError error={previewImport.error} />
        </div>
      ) : null}
      {importNotice ? (
        <p role="status" className="mt-3 rounded-lg bg-primary/10 px-3 py-2 text-sm text-foreground">
          {importNotice}
        </p>
      ) : null}

      {preview ? (
        <Card className="mt-5 gap-4 p-5" data-testid="reference-import-preview">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium">Preview: {preview.fileName}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {preview.totalRecords.toLocaleString()} records · {preview.validRecords.toLocaleString()} valid ·{" "}
                {preview.invalidRecords.toLocaleString()} invalid
              </p>
            </div>
            <Badge variant="outline">{preview.format.toUpperCase()}</Badge>
          </div>

          {preview.format === "csv" ? (
            <div>
              <h4 className="text-sm font-medium">CSV column mapping</h4>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(
                  [
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
                  ] as const
                ).map((field) => (
                  <label key={field} className="grid gap-1 text-xs capitalize">
                    {field === "title" ? "Title (required)" : field.replace(/([A-Z])/g, " $1")}
                    <select
                      className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                      value={mapping[field] ?? ""}
                      onChange={(event) => {
                        setMapping((current) => ({ ...current, [field]: event.target.value || undefined }));
                        setMappingApplied(false);
                      }}
                    >
                      <option value="">Not mapped</option>
                      {preview.columns.map((column) => (
                        <option key={column} value={column}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!mapping.title || mappingApplied || remapImport.isPending}
                  onClick={() => remapImport.mutate()}
                >
                  {remapImport.isPending ? "Refreshing preview…" : "Apply mapping and refresh preview"}
                </Button>
                {!mappingApplied ? (
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    Refresh the preview before committing this mapping.
                  </span>
                ) : null}
              </div>
              {remapImport.error ? (
                <div className="mt-3">
                  <InlineError error={remapImport.error} />
                </div>
              ) : null}
            </div>
          ) : null}

          {ambiguous.length ? (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="text-sm font-medium">Resolve ambiguous matches</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {ambiguous.length - unresolvedAmbiguous.length} of {ambiguous.length} explicitly resolved. Every
                    ambiguous record must be reviewed before import.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setResolutions((current) => ({
                        ...current,
                        ...Object.fromEntries(
                          unresolvedAmbiguous.map((item) => [item.recordIndex, "keep-separate" as const])
                        )
                      }))
                    }
                  >
                    Keep all unresolved separate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setResolutions((current) => ({
                        ...current,
                        ...Object.fromEntries(unresolvedAmbiguous.map((item) => [item.recordIndex, "skip" as const]))
                      }))
                    }
                  >
                    Skip all unresolved
                  </Button>
                </div>
              </div>
              <div className="mt-2 grid gap-2">
                {visibleAmbiguous.map((item) => (
                  <div key={item.recordIndex} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto]">
                    <span className="min-w-0 truncate text-sm">
                      {item.record?.title ?? item.rawTitle ?? `Record ${item.recordIndex + 1}`}
                    </span>
                    <div className="flex flex-wrap gap-2">
                      <select
                        aria-label={`Resolution for ${item.record?.title ?? `record ${item.recordIndex + 1}`}`}
                        className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
                        value={resolutions[item.recordIndex] ?? ""}
                        onChange={(event) =>
                          setResolutions((current) => ({
                            ...current,
                            [item.recordIndex]: event.target.value as "keep-separate" | "merge" | "skip"
                          }))
                        }
                      >
                        <option value="" disabled>
                          Choose resolution…
                        </option>
                        <option value="skip">Skip</option>
                        <option value="keep-separate">Keep separate</option>
                        <option value="merge">Merge with match</option>
                      </select>
                      {resolutions[item.recordIndex] === "merge" ? (
                        <select
                          aria-label={`Merge target for ${item.record?.title ?? `record ${item.recordIndex + 1}`}`}
                          className="h-8 max-w-56 rounded-lg border border-input bg-background px-2 font-mono text-xs"
                          value={mergeTargets[item.recordIndex] ?? item.match.candidatePaperIds[0] ?? ""}
                          onChange={(event) =>
                            setMergeTargets((current) => ({ ...current, [item.recordIndex]: event.target.value }))
                          }
                        >
                          {item.match.candidatePaperIds.map((paperId) => (
                            <option key={paperId} value={paperId}>
                              {paperId}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              {ambiguousTotalPages > 1 ? (
                <Pagination
                  label="Ambiguous matches"
                  page={ambiguousPage}
                  totalPages={ambiguousTotalPages}
                  onPage={setAmbiguousPage}
                />
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">Parsed records</h4>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Preview records
              <select
                aria-label="Preview records"
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                value={previewFilter}
                onChange={(event) => {
                  setPreviewFilter(event.target.value as "all" | "invalid");
                  setPreviewPage(1);
                }}
              >
                <option value="all">All ({preview.items.length})</option>
                <option value="invalid">Invalid only ({preview.invalidRecords})</option>
              </select>
            </label>
          </div>
          <div className="max-h-64 overflow-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Record</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Match</th>
                </tr>
              </thead>
              <tbody>
                {visiblePreviewItems.map((item) => (
                  <tr key={item.recordIndex} className="border-t">
                    <td className="p-2">{item.record?.title ?? item.rawTitle ?? `Record ${item.recordIndex + 1}`}</td>
                    <td className="p-2">{item.valid ? "Valid" : item.errors.join("; ")}</td>
                    <td className="p-2 capitalize">{item.match.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visiblePreviewItems.length ? (
            <p className="text-xs text-muted-foreground">No records match this preview filter.</p>
          ) : null}
          <Pagination
            label="Reference preview"
            page={previewPage}
            totalPages={previewTotalPages}
            onPage={setPreviewPage}
          />
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-xs text-amber-700 dark:text-amber-300">
              {warning}
            </p>
          ))}
          {commitImport.error ? <InlineError error={commitImport.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPreview(undefined)}>
              Cancel
            </Button>
            <Button
              disabled={commitImport.isPending || !csvMappingReady || unresolvedAmbiguous.length > 0}
              onClick={() =>
                commitImport.mutate({
                  projectId: props.projectId,
                  reviewId: props.reviewId,
                  previewId: preview.previewId,
                  mapping: preview.format === "csv" ? (mapping as ReferenceImportMapping) : undefined,
                  resolutions: ambiguous.map((item) => ({
                    recordIndex: item.recordIndex,
                    action: resolutions[item.recordIndex]!,
                    paperId:
                      resolutions[item.recordIndex] === "merge"
                        ? (mergeTargets[item.recordIndex] ?? item.match.paperId ?? item.match.candidatePaperIds[0])
                        : undefined
                  }))
                })
              }
            >
              {commitImport.isPending ? "Importing…" : "Commit import"}
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="mt-6">
        <h3 className="font-medium">Discovery provenance</h3>
        {batchesQuery.isPending ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading discovery batches…</p>
        ) : null}
        {batchesQuery.error ? (
          <div className="mt-3">
            <InlineError error={batchesQuery.error} />
          </div>
        ) : null}
        <div className="mt-3 grid gap-3">
          {(batchesQuery.data ?? []).map((batch) => (
            <Card key={batch.id} className="gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h4 className="font-medium">{batch.label}</h4>
                  <p className="text-xs text-muted-foreground">
                    {batch.kind} · {batch.status}
                  </p>
                </div>
                {!batch.historicalCountsAvailable ? (
                  <Badge variant="outline">Historical duplicates unavailable</Badge>
                ) : null}
              </div>
              <dl className="grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
                <Count label="Identified" value={batch.counts.identified} />
                <Count label="Filtered" value={batch.counts.filtered} />
                <Count label="Invalid" value={batch.counts.invalid} />
                <Count label="Duplicates" value={batch.counts.duplicates} />
                <Count label="Merged" value={batch.counts.merged} />
                <Count label="New" value={batch.counts.newRecords} />
              </dl>
            </Card>
          ))}
          {!batchesQuery.isPending && !(batchesQuery.data ?? []).length ? (
            <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
              No discovery batches yet.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ScreeningStage(props: {
  reviewId: string;
  projectId: string;
  protocolRevisionId: string;
  criteria: ReviewCriterion[];
  stage: "title-abstract" | "full-text";
  suggestions: Record<string, SuggestionSelection>;
  runBusy: boolean;
  onOpenArtifact?(artifactId: string, page?: number): void;
  onStartRun(input: StartReviewRunRequest): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<"all" | ReviewPaperSummary["source"]>("all");
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "pending" | ScreeningDecisionValue>("all");
  const [fullText, setFullText] = useState<"any" | "available" | "missing">("any");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exclusionCriterionId, setExclusionCriterionId] = useState("");
  const [exclusionReason, setExclusionReason] = useState("");
  const [decisionError, setDecisionError] = useState<string>();
  const [decisionNotice, setDecisionNotice] = useState<string>();
  const [fullTextFeedback, setFullTextFeedback] = useState<
    Record<string, { kind: "success" | "error"; message: string }>
  >({});

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setExclusionCriterionId("");
    setExclusionReason("");
    setDecisionError(undefined);
    setDecisionNotice(undefined);
    setFullTextFeedback({});
  }, [props.stage]);

  const query = useMemo<ReviewPaperQuery>(
    () => ({
      reviewId: props.reviewId,
      stage: props.stage,
      search: search.trim() || undefined,
      sources: source === "all" ? [] : [source],
      yearFrom: reviewYear(yearFrom),
      yearTo: reviewYear(yearTo),
      decisions: decisionFilter === "all" ? [] : [decisionFilter],
      fullText,
      sort: "created",
      direction: "asc",
      page,
      pageSize: 25
    }),
    [decisionFilter, fullText, page, props.reviewId, props.stage, search, source, yearFrom, yearTo]
  );
  const papersQuery = useQuery({
    queryKey: ["review-papers", props.reviewId, query],
    queryFn: () => api().listReviewPapers(query)
  });
  const projectPapersQuery = useQuery({
    queryKey: ["project-paper-details", props.projectId],
    queryFn: () => api().getProjectBundle!(props.projectId),
    enabled: typeof api().getProjectBundle === "function"
  });
  const provenanceQuery = useQuery({
    queryKey: ["review-discovery", props.reviewId],
    queryFn: () => api().listDiscoveryBatches(props.reviewId)
  });
  const fullTextExclusionCriteria = useMemo(
    () =>
      props.criteria
        .filter((criterion) => criterion.stage === "full-text" && criterion.type === "exclusion")
        .sort((left, right) => left.order - right.order),
    [props.criteria]
  );
  const paperDetails = useMemo(
    () => new Map((projectPapersQuery.data?.papers ?? []).map((paper) => [paper.id, paper])),
    [projectPapersQuery.data]
  );
  const batchLabels = useMemo(
    () => new Map((provenanceQuery.data ?? []).map((batch) => [batch.id, batch.label])),
    [provenanceQuery.data]
  );

  const saveDecision = useMutation({
    mutationFn: (input: SaveScreeningDecisionRequest) => api().saveScreeningDecision(input),
    onMutate: () => setDecisionNotice(undefined),
    onSuccess: () => {
      setDecisionError(undefined);
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-summary", props.reviewId] });
    }
  });
  const markForReview = useMutation({
    mutationFn: (input: MarkReviewPapersForReviewRequest) => api().markReviewPapersForReview(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] })
  });
  const fullTextAction = useMutation({
    mutationFn: (input: { paperId: string; mode: "fetch" | "attach" }) =>
      input.mode === "fetch"
        ? api().fetchReviewPaperFullText({
            projectId: props.projectId,
            reviewId: props.reviewId,
            paperId: input.paperId
          })
        : api().attachReviewPaperPdf({ projectId: props.projectId, reviewId: props.reviewId, paperId: input.paperId }),
    onMutate: (input) => {
      setFullTextFeedback((current) => {
        const next = { ...current };
        delete next[input.paperId];
        return next;
      });
    },
    onSuccess: (result, input) => {
      const action = input.mode === "fetch" ? "Full text" : "PDF";
      const message = result.ok
        ? `${action} ${input.mode === "fetch" ? "fetched and indexed" : "attached and indexed"}.${result.warning ? ` ${result.warning}` : ""}`
        : input.mode === "attach"
          ? "PDF attachment was cancelled."
          : "Full-text retrieval did not add an indexed document.";
      setFullTextFeedback((current) => ({
        ...current,
        [input.paperId]: { kind: result.ok ? "success" : "error", message }
      }));
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
    },
    onError: (error, input) => {
      setFullTextFeedback((current) => ({
        ...current,
        [input.paperId]: {
          kind: "error",
          message: `${input.mode === "fetch" ? "Full-text retrieval" : "PDF attachment"} failed: ${errorMessage(error)}`
        }
      }));
    }
  });

  const bulkDecision = useMutation({
    mutationFn: async (input: { paperIds: string[]; decision: ScreeningDecisionValue }) => {
      const results = await Promise.allSettled(
        input.paperIds.map((paperId) =>
          api().saveScreeningDecision({
            reviewId: props.reviewId,
            paperId,
            stage: props.stage,
            decision: input.decision,
            protocolRevisionId: props.protocolRevisionId,
            reasonCriterionId: input.decision === "exclude" && exclusionCriterionId ? exclusionCriterionId : undefined,
            customReason: input.decision === "exclude" ? exclusionReason.trim() || undefined : undefined
          })
        )
      );
      return {
        succeeded: input.paperIds.filter((_paperId, index) => results[index]?.status === "fulfilled"),
        failed: input.paperIds.filter((_paperId, index) => results[index]?.status === "rejected")
      };
    },
    onSuccess: ({ succeeded, failed }) => {
      setSelected(new Set(failed));
      setDecisionNotice(
        failed.length
          ? `${succeeded.length} decisions saved; ${failed.length} failed and remain selected.`
          : `${succeeded.length} decisions saved.`
      );
      setDecisionError(failed.length ? `${failed.length} selected papers could not be updated.` : undefined);
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-summary", props.reviewId] });
    },
    onError: (error) => setDecisionError(errorMessage(error))
  });

  const decide = (paper: ReviewPaperSummary, decision: ScreeningDecisionValue, suggestion?: ReviewRunItem): void => {
    const reasonCriterionId =
      decision === "exclude"
        ? (suggestion?.suggestedReasonCriterionId ?? exclusionCriterionId) || undefined
        : undefined;
    const customReason =
      decision === "exclude" ? (suggestion?.suggestedCustomReason ?? exclusionReason.trim()) || undefined : undefined;
    if (props.stage === "full-text" && decision === "exclude" && !reasonCriterionId && !customReason) {
      setDecisionError("Enter a full-text exclusion reason or select a protocol criterion before excluding a paper.");
      return;
    }
    setDecisionError(undefined);
    saveDecision.mutate({
      reviewId: props.reviewId,
      paperId: paper.paperId,
      stage: props.stage,
      decision,
      protocolRevisionId: props.protocolRevisionId,
      reasonCriterionId,
      customReason,
      runItemId: suggestion?.id
    });
  };

  const decideSelected = (decision: ScreeningDecisionValue): void => {
    if (!selected.size) return;
    if (props.stage === "full-text" && decision === "exclude" && !exclusionCriterionId && !exclusionReason.trim()) {
      setDecisionError("Enter a full-text exclusion reason or select a protocol criterion before excluding papers.");
      return;
    }
    setDecisionError(undefined);
    setDecisionNotice(undefined);
    bulkDecision.mutate({ paperIds: [...selected], decision });
  };

  const handlePaperKey = (event: KeyboardEvent<HTMLElement>, paper: ReviewPaperSummary): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || isFormControl(event.target)) return;
    const key = event.key.toLowerCase();
    const decision = key === "i" ? "include" : key === "e" ? "exclude" : key === "u" ? "uncertain" : undefined;
    if (!decision) return;
    event.preventDefault();
    decide(paper, decision);
  };

  const papers = papersQuery.data?.items ?? [];
  const allSelected = papers.length > 0 && papers.every((paper) => selected.has(paper.paperId));

  return (
    <section aria-labelledby="screening-heading" className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="screening-heading" className="text-xl font-semibold">
            {props.stage === "title-abstract" ? "Title and abstract screening" : "Full-text screening"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Focus a paper row and press I, E, or U to include, exclude, or mark uncertain.
          </p>
        </div>
        <Button
          disabled={!selected.size || selected.size > MAX_REVIEW_BATCH_PAPERS || props.runBusy}
          onClick={() => props.onStartRun({ reviewId: props.reviewId, stage: props.stage, paperIds: [...selected] })}
        >
          Suggest with AI ({selected.size})
        </Button>
      </div>

      <Card className="mt-5 gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_160px_120px_120px_160px_160px]">
          <label className="grid gap-1 text-xs text-muted-foreground">
            Search papers
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Title, author, abstract…"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Source
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={source}
              onChange={(event) => {
                setSource(event.target.value as typeof source);
                setPage(1);
              }}
            >
              <option value="all">All sources</option>
              {paperSourceFilters.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Year from
            <Input
              type="number"
              min={1500}
              max={3000}
              value={yearFrom}
              onChange={(event) => {
                setYearFrom(event.target.value);
                setPage(1);
              }}
              placeholder="Any"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Year to
            <Input
              type="number"
              min={1500}
              max={3000}
              value={yearTo}
              onChange={(event) => {
                setYearTo(event.target.value);
                setPage(1);
              }}
              placeholder="Any"
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Decision
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={decisionFilter}
              onChange={(event) => {
                setDecisionFilter(event.target.value as typeof decisionFilter);
                setPage(1);
              }}
            >
              <option value="all">All decisions</option>
              <option value="pending">Pending</option>
              <option value="include">Included</option>
              <option value="exclude">Excluded</option>
              <option value="uncertain">Uncertain</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Full text
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
              value={fullText}
              onChange={(event) => {
                setFullText(event.target.value as typeof fullText);
                setPage(1);
              }}
            >
              <option value="any">Any availability</option>
              <option value="available">Available</option>
              <option value="missing">Missing</option>
            </select>
          </label>
        </div>
        {props.stage === "full-text" ? (
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              Full-text exclusion criterion
              <select
                className="h-8 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
                value={exclusionCriterionId}
                onChange={(event) => setExclusionCriterionId(event.target.value)}
              >
                <option value="">No protocol criterion selected</option>
                {fullTextExclusionCriteria.map((criterion) => (
                  <option key={criterion.id} value={criterion.id}>
                    {criterion.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Full-text exclusion reason <span>Custom reason (optional when a criterion is selected)</span>
              <Input
                value={exclusionReason}
                onChange={(event) => setExclusionReason(event.target.value)}
                placeholder="Enter a custom reason"
              />
            </label>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setSelected(
                  checked ? new Set(papers.slice(0, MAX_REVIEW_BATCH_PAPERS).map((paper) => paper.paperId)) : new Set()
                )
              }
            />{" "}
            Select this page
          </label>
          {papersQuery.data ? (
            <span>
              {papersQuery.data.total.toLocaleString()} papers · {papersQuery.data.counts.pending} pending
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Bulk screening actions">
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.size || bulkDecision.isPending}
            onClick={() => decideSelected("include")}
          >
            Include selected ({selected.size})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.size || bulkDecision.isPending}
            onClick={() => decideSelected("exclude")}
          >
            Exclude selected ({selected.size})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected.size || bulkDecision.isPending}
            onClick={() => decideSelected("uncertain")}
          >
            Uncertain selected ({selected.size})
          </Button>
        </div>
      </Card>

      {decisionError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {decisionError}
        </p>
      ) : null}
      {decisionNotice ? (
        <p role="status" className="mt-3 text-sm text-foreground">
          {decisionNotice}
        </p>
      ) : null}
      {saveDecision.error ? (
        <div className="mt-3">
          <InlineError error={saveDecision.error} />
        </div>
      ) : null}
      {papersQuery.isPending ? <p className="mt-5 text-sm text-muted-foreground">Loading screening queue…</p> : null}
      {papersQuery.error ? (
        <div className="mt-5">
          <InlineError error={papersQuery.error} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-3">
        {papers.map((paper) => {
          const decision = props.stage === "title-abstract" ? paper.titleAbstractDecision : paper.fullTextDecision;
          const candidateSuggestion = props.suggestions[suggestionKey(props.stage, paper.paperId)]?.item;
          const suggestion = decision?.runItemId === candidateSuggestion?.id ? undefined : candidateSuggestion;
          const suggestionStale = suggestion?.stale ?? paper.aiSuggestionStale;
          const projectPaper = paperDetails.get(paper.paperId);
          const doi = paper.doi ?? projectPaper?.doi;
          const paperUrl = projectPaper?.url;
          const fullAbstract = projectPaper?.abstract ?? paper.abstract;
          const provenance = paper.discoveryBatchIds.map((batchId) => batchLabels.get(batchId) ?? batchId);
          return (
            <Card
              key={paper.paperId}
              tabIndex={0}
              onKeyDown={(event) => handlePaperKey(event, paper)}
              className="gap-3 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Screen ${paper.title}`}
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  aria-label={`Select ${paper.title}`}
                  checked={selected.has(paper.paperId)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => toggledSet(current, paper.paperId, checked === true))
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="font-medium leading-5">{paper.title}</h3>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={decision ? "secondary" : "outline"}>{decision?.decision ?? "pending"}</Badge>
                      <Badge variant={paper.hasFullText ? "secondary" : "outline"}>
                        {paper.hasFullText ? "Full text" : "Metadata only"}
                      </Badge>
                      {paper.needsReReview ? <Badge variant="outline">Needs re-review</Badge> : null}
                      {suggestionStale ? <Badge variant="outline">AI suggestion stale</Badge> : null}
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {paper.authors.slice(0, 3).join(", ") || "Unknown authors"}
                    {paper.year ? ` · ${paper.year}` : ""}
                    {paper.venue ? ` · ${paper.venue}` : ""}
                  </p>
                  {paper.abstract ? (
                    <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{paper.abstract}</p>
                  ) : (
                    <p className="mt-2 text-sm italic text-muted-foreground">No abstract available.</p>
                  )}
                  <details
                    className="mt-3 rounded-lg border bg-muted/20 p-3"
                    data-testid={`paper-details-${paper.paperId}`}
                  >
                    <summary className="cursor-pointer text-sm font-medium">View paper details</summary>
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">DOI</dt>
                        <dd className="mt-1 break-words">
                          {doi ? (
                            <a
                              className="underline underline-offset-2"
                              href={`https://doi.org/${encodeURIComponent(doi)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {doi}
                            </a>
                          ) : (
                            "Not available"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-medium text-muted-foreground">URL</dt>
                        <dd className="mt-1 break-all">
                          {paperUrl ? (
                            <a
                              className="underline underline-offset-2"
                              href={paperUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {paperUrl}
                            </a>
                          ) : (
                            "Not available"
                          )}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs font-medium text-muted-foreground">Full abstract</dt>
                        <dd className="mt-1 whitespace-pre-wrap leading-6">
                          {fullAbstract ?? "No abstract available."}
                        </dd>
                      </div>
                      <div className="sm:col-span-2">
                        <dt className="text-xs font-medium text-muted-foreground">Discovery provenance</dt>
                        <dd className="mt-1">
                          Source: {sourceLabel(paper.source)}
                          {provenance.length ? ` · Batches: ${provenance.join(", ")}` : " · No batch recorded"}
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              </div>

              {suggestion?.suggestedDecision ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong>AI suggestion:</strong> {suggestion.suggestedDecision}
                    </span>
                    <Badge variant="outline">Unconfirmed</Badge>
                  </div>
                  {suggestion.rationale ? (
                    <p className="mt-1 text-xs text-muted-foreground">{suggestion.rationale}</p>
                  ) : null}
                  {suggestion.criterionAssessments?.length ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        Criterion assessments ({suggestion.criterionAssessments.length})
                      </summary>
                      <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
                        {suggestion.criterionAssessments.map((assessment) => (
                          <li key={assessment.criterionId}>
                            <strong>{assessment.assessment}:</strong> {assessment.explanation}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {suggestion.evidence.length ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        Evidence ({suggestion.evidence.length})
                      </summary>
                      <div className="mt-2 grid gap-2">
                        {suggestion.evidence.map((evidence) => (
                          <div key={evidence.id} className="rounded-md border bg-background p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-medium">
                                {evidence.evidenceId} · {evidence.locator ?? evidence.title}
                              </span>
                              {evidence.artifactId ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => props.onOpenArtifact?.(evidence.artifactId!, evidence.page)}
                                >
                                  Open source{evidence.page ? ` · p. ${evidence.page}` : ""}
                                </Button>
                              ) : null}
                            </div>
                            <blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">
                              “{evidence.excerpt}”
                            </blockquote>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    disabled={suggestion.stale}
                    onClick={() => decide(paper, suggestion.suggestedDecision!, suggestion)}
                  >
                    {suggestion.stale ? "Rerun required for current protocol" : "Confirm suggestion"}
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Include ${paper.title}`}
                  onClick={() => decide(paper, "include")}
                >
                  Include <kbd className="text-[10px] text-muted-foreground">I</kbd>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Exclude ${paper.title}`}
                  onClick={() => decide(paper, "exclude")}
                >
                  Exclude <kbd className="text-[10px] text-muted-foreground">E</kbd>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Uncertain ${paper.title}`}
                  onClick={() => decide(paper, "uncertain")}
                >
                  Uncertain <kbd className="text-[10px] text-muted-foreground">U</kbd>
                </Button>
                {decision ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={markForReview.isPending}
                    onClick={() =>
                      markForReview.mutate({ reviewId: props.reviewId, paperIds: [paper.paperId], stage: props.stage })
                    }
                  >
                    Mark for re-review
                  </Button>
                ) : null}
                {!paper.hasFullText ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={fullTextAction.isPending}
                      onClick={() => fullTextAction.mutate({ paperId: paper.paperId, mode: "fetch" })}
                    >
                      Fetch full text
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={fullTextAction.isPending}
                      onClick={() => fullTextAction.mutate({ paperId: paper.paperId, mode: "attach" })}
                    >
                      Attach PDF
                    </Button>
                  </>
                ) : null}
              </div>
              {fullTextFeedback[paper.paperId] ? (
                <p
                  role={fullTextFeedback[paper.paperId]?.kind === "error" ? "alert" : "status"}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    fullTextFeedback[paper.paperId]?.kind === "error"
                      ? "bg-destructive/10 text-destructive"
                      : "bg-primary/10 text-foreground"
                  )}
                >
                  {fullTextFeedback[paper.paperId]?.message}
                </p>
              ) : null}
            </Card>
          );
        })}
        {!papersQuery.isPending && !papers.length ? (
          <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No papers match this stage and filter.
          </p>
        ) : null}
      </div>
      <Pagination
        page={papersQuery.data?.page ?? page}
        totalPages={papersQuery.data?.totalPages ?? 0}
        onPage={setPage}
      />
    </section>
  );
}

function ExtractionStage(props: {
  reviewId: string;
  suggestions: Record<string, SuggestionSelection>;
  runBusy: boolean;
  onOpenArtifact?(artifactId: string, page?: number): void;
  onStartRun(input: StartReviewRunRequest): void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [fieldDraft, setFieldDraft] = useState<{
    id?: string;
    revision?: number;
    name: string;
    type: ExtractionFieldType;
    options: string;
  }>({ name: "", type: "short-text", options: "" });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fieldsQuery = useQuery({
    queryKey: ["review-fields", props.reviewId],
    queryFn: () => api().listExtractionFields(props.reviewId)
  });
  const paperQuery = useMemo<ReviewPaperQuery>(
    () => ({
      reviewId: props.reviewId,
      stage: "extraction",
      search: search.trim() || undefined,
      sources: [],
      decisions: [],
      fullText: "any",
      sort: "created",
      direction: "asc",
      page,
      pageSize: 25
    }),
    [page, props.reviewId, search]
  );
  const papersQuery = useQuery({
    queryKey: ["review-papers", props.reviewId, paperQuery],
    queryFn: () => api().listReviewPapers(paperQuery)
  });
  const paperIds = (papersQuery.data?.items ?? []).map((paper) => paper.paperId);
  const valuesQuery = useQuery({
    queryKey: ["review-values", props.reviewId, paperIds],
    queryFn: () => api().listExtractionValues({ reviewId: props.reviewId, paperIds }),
    enabled: paperIds.length > 0
  });
  const evidenceIds = [...new Set((valuesQuery.data ?? []).flatMap((value) => value.evidenceIds))];
  const evidenceQuery = useQuery({
    queryKey: ["review-evidence", props.reviewId, evidenceIds],
    queryFn: () => api().listReviewEvidence({ reviewId: props.reviewId, evidenceIds }),
    enabled: evidenceIds.length > 0
  });

  const upsertField = useMutation({
    mutationFn: (input: UpsertExtractionFieldRequest) => api().upsertExtractionField(input),
    onSuccess: () => {
      setFieldDraft({ name: "", type: "short-text", options: "" });
      void queryClient.invalidateQueries({ queryKey: ["review-fields", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
    }
  });
  const reorderFields = useMutation({
    mutationFn: (input: ReorderExtractionFieldsRequest) => api().reorderExtractionFields(input),
    onSuccess: (nextFields) => queryClient.setQueryData(["review-fields", props.reviewId], nextFields)
  });
  const saveValue = useMutation({
    mutationFn: (input: SaveExtractionValueRequest) => api().saveExtractionValue(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["review-values", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-papers", props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ["review-summary", props.reviewId] });
    }
  });

  const fields = fieldsQuery.data ?? [];
  const papers = papersQuery.data?.items ?? [];
  const values = valuesQuery.data ?? [];
  const valuesByCell = new Map(values.map((value) => [`${value.paperId}:${value.fieldId}`, value]));
  const evidenceById = new Map((evidenceQuery.data ?? []).map((evidence) => [evidence.id, evidence]));
  const isSelect = fieldDraft.type === "single-select" || fieldDraft.type === "multi-select";

  const submitField = (): void => {
    upsertField.mutate({
      reviewId: props.reviewId,
      fieldId: fieldDraft.id,
      expectedRevision: fieldDraft.revision,
      name: fieldDraft.name,
      type: fieldDraft.type,
      options: isSelect
        ? fieldDraft.options
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      order: fieldDraft.id ? (fields.find((field) => field.id === fieldDraft.id)?.order ?? 0) : fields.length
    });
  };
  const moveField = (fieldId: string, offset: -1 | 1): void => {
    const fieldIds = fields.map((field) => field.id);
    const from = fieldIds.indexOf(fieldId);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= fieldIds.length) return;
    [fieldIds[from], fieldIds[to]] = [fieldIds[to], fieldIds[from]];
    reorderFields.mutate({ reviewId: props.reviewId, fieldIds });
  };

  return (
    <section aria-labelledby="extract-heading" className="mx-auto max-w-full">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="extract-heading" className="text-xl font-semibold">
            Evidence extraction
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Only full-text inclusions appear here. AI suggestions require evidence before confirmation.
          </p>
        </div>
        <Button
          disabled={!selected.size || !fields.length || props.runBusy}
          onClick={() =>
            props.onStartRun({
              reviewId: props.reviewId,
              stage: "extraction",
              paperIds: [...selected],
              fieldIds: fields.map((field) => field.id)
            })
          }
        >
          Suggest values with AI ({selected.size})
        </Button>
      </div>

      <Card className="mt-5 gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Extraction fields</h3>
          <span className="text-xs text-muted-foreground">
            {fields.length}/{MAX_EXTRACTION_FIELDS}
          </span>
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(160px,1fr)_180px_minmax(180px,1fr)_auto]">
          <Input
            aria-label="Field name"
            value={fieldDraft.name}
            onChange={(event) => setFieldDraft((current) => ({ ...current, name: event.target.value }))}
            placeholder="Field name"
          />
          <select
            aria-label="Field type"
            className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            value={fieldDraft.type}
            onChange={(event) =>
              setFieldDraft((current) => ({ ...current, type: event.target.value as ExtractionFieldType }))
            }
          >
            {(
              ["short-text", "long-text", "number", "boolean", "single-select", "multi-select"] as ExtractionFieldType[]
            ).map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Input
            aria-label="Field options"
            disabled={!isSelect}
            value={fieldDraft.options}
            onChange={(event) => setFieldDraft((current) => ({ ...current, options: event.target.value }))}
            placeholder={isSelect ? "Options separated by commas" : "No options for this type"}
          />
          <div className="flex gap-2">
            <Button
              disabled={
                !fieldDraft.name.trim() ||
                upsertField.isPending ||
                (!fieldDraft.id && fields.length >= MAX_EXTRACTION_FIELDS)
              }
              onClick={submitField}
            >
              {fieldDraft.id ? "Save field" : "Add field"}
            </Button>
            {fieldDraft.id ? (
              <Button variant="ghost" onClick={() => setFieldDraft({ name: "", type: "short-text", options: "" })}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
        {upsertField.error ? <InlineError error={upsertField.error} /> : null}
        <div className="flex flex-wrap gap-2">
          {fields.map((field, index) => (
            <div key={field.id} className="flex items-center rounded-lg border">
              <button
                type="button"
                className="px-3 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() =>
                  setFieldDraft({
                    id: field.id,
                    revision: field.revision,
                    name: field.name,
                    type: field.type,
                    options: field.options.join(", ")
                  })
                }
              >
                <strong>{field.name}</strong>
                <span className="ml-1 text-muted-foreground">
                  {field.type} · v{field.revision}
                </span>
              </button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Move ${field.name} earlier`}
                disabled={index === 0 || reorderFields.isPending}
                onClick={() => moveField(field.id, -1)}
              >
                ↑
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Move ${field.name} later`}
                disabled={index === fields.length - 1 || reorderFields.isPending}
                onClick={() => moveField(field.id, 1)}
              >
                ↓
              </Button>
            </div>
          ))}
        </div>
        {reorderFields.error ? <InlineError error={reorderFields.error} /> : null}
      </Card>

      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <label className="grid min-w-64 gap-1 text-xs text-muted-foreground">
          Search included papers
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={papers.length > 0 && papers.every((paper) => selected.has(paper.paperId))}
            onCheckedChange={(checked) =>
              setSelected(checked ? new Set(papers.map((paper) => paper.paperId)) : new Set())
            }
          />{" "}
          Select page for AI
        </label>
      </div>

      <div className="mt-3 overflow-auto rounded-xl border">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="min-w-64 p-3">Included paper</th>
              {fields.map((field) => (
                <th key={field.id} className="min-w-56 border-l p-3">
                  {field.name}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">v{field.revision}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {papers.map((paper) => (
              <tr key={paper.paperId} className="border-t align-top">
                <th className="p-3 font-normal">
                  <label className="flex items-start gap-2">
                    <Checkbox
                      aria-label={`Select ${paper.title} for extraction`}
                      checked={selected.has(paper.paperId)}
                      onCheckedChange={(checked) =>
                        setSelected((current) => toggledSet(current, paper.paperId, checked === true))
                      }
                    />
                    <span>
                      <strong className="block font-medium">{paper.title}</strong>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {paper.extractionProgress.confirmed}/{paper.extractionProgress.total} confirmed
                      </span>
                      {props.suggestions[suggestionKey("extraction", paper.paperId)]?.item.extractionSuggestions
                        .length ? (
                        <Badge className="mt-2" variant="outline">
                          New AI suggestions
                        </Badge>
                      ) : null}
                    </span>
                  </label>
                </th>
                {fields.map((field) => {
                  const value = valuesByCell.get(`${paper.paperId}:${field.id}`);
                  return (
                    <td key={field.id} className="border-l p-3">
                      <ExtractionCell
                        field={field}
                        value={value}
                        evidence={(value?.evidenceIds ?? []).flatMap((evidenceId) => {
                          const evidence = evidenceById.get(evidenceId);
                          return evidence ? [evidence] : [];
                        })}
                        busy={saveValue.isPending}
                        onOpenArtifact={props.onOpenArtifact}
                        onSave={(nextValue, status) =>
                          saveValue.mutate({
                            reviewId: props.reviewId,
                            paperId: paper.paperId,
                            fieldId: field.id,
                            expectedFieldRevision: field.revision,
                            value: nextValue,
                            status,
                            evidenceIds: value?.evidenceIds ?? []
                          })
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!fields.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Add an extraction field to build the evidence matrix.
          </p>
        ) : null}
        {fields.length > 0 && !papersQuery.isPending && !papers.length ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No full-text inclusions are ready for extraction.
          </p>
        ) : null}
      </div>
      {saveValue.error ? (
        <div className="mt-3">
          <InlineError error={saveValue.error} />
        </div>
      ) : null}
      <Pagination
        page={papersQuery.data?.page ?? page}
        totalPages={papersQuery.data?.totalPages ?? 0}
        onPage={setPage}
      />
    </section>
  );
}

function ExtractionCell(props: {
  field: ExtractionField;
  value?: ExtractionValue;
  evidence: ReviewEvidence[];
  busy: boolean;
  onOpenArtifact?(artifactId: string, page?: number): void;
  onSave(value: ExtractionPrimitiveValue, status: SaveExtractionValueRequest["status"]): void;
}): JSX.Element {
  const [draft, setDraft] = useState(() => extractionDraft(props.value?.value));
  useEffect(() => setDraft(extractionDraft(props.value?.value)), [props.value?.updatedAt, props.value?.value]);
  const parsed = parseExtractionDraft(draft, props.field.type);
  const blank = isBlankExtractionValue(parsed);
  const suggestedNotFound =
    props.value?.origin === "ai" && props.value.status === "suggested" && props.value.value === null;
  const unclearSuggestion =
    props.value?.origin === "ai" && props.value.status === "needs-review" && props.value.value === null;
  return (
    <div className="grid gap-2">
      <ExtractionInput field={props.field} draft={draft} onDraft={setDraft} />
      <div className="flex flex-wrap items-center gap-1">
        {props.value ? (
          <Badge variant={props.value.status === "confirmed" ? "secondary" : "outline"}>
            {suggestedNotFound
              ? "Suggested: not found"
              : unclearSuggestion
                ? "Needs review: unclear"
                : props.value.status}
          </Badge>
        ) : (
          <Badge variant="outline">Empty</Badge>
        )}
        {props.value?.origin === "manual" && !props.value.evidenceIds.length ? (
          <span className="text-[10px] text-muted-foreground">Manual—no linked evidence</span>
        ) : null}
        {props.value?.evidenceIds.length ? (
          <span className="text-[10px] text-muted-foreground">{props.value.evidenceIds.length} evidence</span>
        ) : null}
      </div>
      {props.evidence.length ? (
        <details className="rounded-md border bg-muted/20 p-2">
          <summary className="cursor-pointer text-xs font-medium">Evidence ({props.evidence.length})</summary>
          <div className="mt-2 grid gap-2">
            {props.evidence.map((evidence) => (
              <div key={evidence.id} className="text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{evidence.locator ?? evidence.title}</span>
                  {evidence.artifactId ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => props.onOpenArtifact?.(evidence.artifactId!, evidence.page)}
                    >
                      Open source{evidence.page ? ` · p. ${evidence.page}` : ""}
                    </Button>
                  ) : null}
                </div>
                <blockquote className="mt-1 line-clamp-4 border-l-2 pl-2 text-muted-foreground">
                  “{evidence.excerpt}”
                </blockquote>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <div className="flex gap-1">
        <Button size="xs" disabled={props.busy || blank} onClick={() => props.onSave(parsed, "confirmed")}>
          {props.value?.status === "suggested" ? "Confirm" : "Save"}
        </Button>
        <Button size="xs" variant="ghost" disabled={props.busy} onClick={() => props.onSave(null, "not-found")}>
          {suggestedNotFound || unclearSuggestion ? "Accept not found" : "Not found"}
        </Button>
        {props.value?.origin === "ai" &&
        (props.value.status === "suggested" || props.value.status === "needs-review") ? (
          <Button size="xs" variant="ghost" disabled={props.busy} onClick={() => props.onSave(parsed, "rejected")}>
            Reject
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ExtractionInput(props: { field: ExtractionField; draft: string; onDraft(value: string): void }): JSX.Element {
  if (props.field.type === "long-text")
    return (
      <Textarea
        aria-label={props.field.name}
        value={props.draft}
        onChange={(event) => props.onDraft(event.target.value)}
      />
    );
  if (props.field.type === "boolean")
    return (
      <select
        aria-label={props.field.name}
        className="h-8 w-full rounded-lg border border-input bg-background px-2"
        value={props.draft}
        onChange={(event) => props.onDraft(event.target.value)}
      >
        <option value="">Not set</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  if (props.field.type === "single-select")
    return (
      <select
        aria-label={props.field.name}
        className="h-8 w-full rounded-lg border border-input bg-background px-2"
        value={props.draft}
        onChange={(event) => props.onDraft(event.target.value)}
      >
        <option value="">Not set</option>
        {props.field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  return (
    <Input
      aria-label={props.field.name}
      type={props.field.type === "number" ? "number" : "text"}
      value={props.draft}
      onChange={(event) => props.onDraft(event.target.value)}
      placeholder={props.field.type === "multi-select" ? "Values separated by commas" : undefined}
    />
  );
}

function SummaryStage(props: { reviewId: string }): JSX.Element {
  const summaryQuery = useQuery({
    queryKey: ["review-summary", props.reviewId],
    queryFn: () => api().getReviewSummary(props.reviewId)
  });
  const exportMutation = useMutation({ mutationFn: () => api().exportReview({ reviewId: props.reviewId }) });
  const summary = summaryQuery.data;
  return (
    <section aria-labelledby="summary-heading" className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="summary-heading" className="text-xl font-semibold">
            Review summary
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Deterministic counts and exports derived from recorded provenance and human decisions.
          </p>
        </div>
        <Button disabled={!summary || exportMutation.isPending} onClick={() => exportMutation.mutate()}>
          {exportMutation.isPending ? "Exporting…" : "Export review package"}
        </Button>
      </div>
      {summaryQuery.isPending ? <p className="mt-5 text-sm text-muted-foreground">Calculating review flow…</p> : null}
      {summaryQuery.error ? (
        <div className="mt-5">
          <InlineError error={summaryQuery.error} />
        </div>
      ) : null}
      {exportMutation.error ? (
        <div className="mt-5">
          <InlineError error={exportMutation.error} />
        </div>
      ) : null}
      {exportMutation.data?.path ? (
        <p role="status" className="mt-3 text-sm">
          Exported to {exportMutation.data.path}
        </p>
      ) : null}
      {summary ? (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Card className="gap-3 p-5">
            <h3 className="font-medium">Review flow counts</h3>
            <table className="w-full text-sm">
              <tbody>
                <SummaryRow label="Records identified" value={summary.identifiedRecords} />
                <SummaryRow label="Filtered before screening" value={summary.filteredRecords} />
                <SummaryRow label="Invalid records" value={summary.invalidRecords} />
                <SummaryRow label="Duplicate records" value={summary.duplicateRecords} />
                <SummaryRow label="Unique records screened" value={summary.uniqueRecordsScreened} />
                <SummaryRow label="Title/abstract exclusions" value={summary.titleAbstractExclusions} />
                <SummaryRow label="Full texts sought" value={summary.fullTextsSought} />
                <SummaryRow label="Full texts unavailable" value={summary.fullTextsUnavailable} />
                {Object.entries(summary.fullTextExclusionsByReason)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([reason, count]) => (
                    <SummaryRow key={reason} label={`Full-text exclusions — ${reason}`} value={count} />
                  ))}
                <SummaryRow label="Included papers" value={summary.includedPapers} />
              </tbody>
            </table>
            {!summary.historicalCountsAvailable ? (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Historical duplicate counts are unavailable for papers that predate review activation.
              </p>
            ) : null}
          </Card>
          <FlowDiagram summary={summary} />
          <Card className="gap-3 p-5 lg:col-span-2">
            <h3 className="font-medium">Extraction completion</h3>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${summary.extraction.completionPercent}%` }} />
            </div>
            <p className="text-sm">
              {summary.extraction.completionPercent}% complete · {summary.extraction.confirmedCells} confirmed ·{" "}
              {summary.extraction.notFoundCells} not found · {summary.extraction.needsReviewCells} need review
            </p>
          </Card>
        </div>
      ) : null}
    </section>
  );
}

function FlowDiagram({ summary }: { summary: ReviewFlowSummary }): JSX.Element {
  return (
    <Card className="gap-3 p-5">
      <h3 className="font-medium">Review flow</h3>
      <svg
        role="img"
        aria-labelledby="review-flow-title review-flow-description"
        viewBox="0 0 520 330"
        className="w-full"
      >
        <title id="review-flow-title">Review flow</title>
        <desc id="review-flow-description">
          Flow from identified records through screening to included studies. This is not a formal PRISMA 2020 diagram.
        </desc>
        <FlowBox y={10} label="Records identified" value={summary.identifiedRecords} />
        <FlowArrow y={75} />
        <FlowBox y={95} label="Unique records screened" value={summary.uniqueRecordsScreened} />
        <FlowArrow y={160} />
        <FlowBox y={180} label="Full texts sought" value={summary.fullTextsSought} />
        <FlowArrow y={245} />
        <FlowBox y={265} label="Papers included" value={summary.includedPapers} />
      </svg>
      <p className="text-xs text-muted-foreground">Review flow — not a claim of formal PRISMA 2020 compliance.</p>
    </Card>
  );
}

function FlowBox(props: { y: number; label: string; value: number }): JSX.Element {
  return (
    <g>
      <rect x="90" y={props.y} width="340" height="50" rx="10" className="fill-muted stroke-border" />
      <text x="110" y={props.y + 30} className="fill-foreground text-[14px]">
        {props.label}
      </text>
      <text x="405" y={props.y + 30} textAnchor="end" className="fill-foreground text-[16px] font-semibold">
        {props.value}
      </text>
    </g>
  );
}
function FlowArrow({ y }: { y: number }): JSX.Element {
  return <path d={`M260 ${y}v14m-5-5 5 5 5-5`} className="fill-none stroke-muted-foreground" />;
}

function RunStatus(props: {
  run?: ReviewRun;
  progress: { completed: number; failed: number; cancelled: number; total: number };
  onCancel(): void;
  onRetry(): void;
}): JSX.Element {
  if (!props.run) return <Badge variant="outline">AI assistance is advisory</Badge>;
  const active = props.run.status === "queued" || props.run.status === "running";
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      <Badge variant={active ? "secondary" : "outline"}>
        {props.run.stage} · {props.run.status}
      </Badge>
      <span className="text-muted-foreground">
        {props.run.provider} · {props.run.model}
      </span>
      {props.progress.total ? (
        <span className="text-muted-foreground">
          {props.progress.completed}/{props.progress.total} complete
          {props.progress.failed ? ` · ${props.progress.failed} failed` : ""}
        </span>
      ) : null}
      {props.run.error ? <span className="max-w-72 text-right text-destructive">{props.run.error}</span> : null}
      {active ? (
        <Button size="xs" variant="outline" onClick={props.onCancel}>
          Stop
        </Button>
      ) : null}
      {props.run.status === "failed" || props.run.status === "cancelled" || props.run.status === "partial" ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          Retry unfinished
        </Button>
      ) : null}
    </div>
  );
}

function Pagination(props: {
  label?: string;
  page: number;
  totalPages: number;
  onPage(page: number): void;
}): JSX.Element {
  if (props.totalPages <= 1) return <></>;
  return (
    <nav aria-label={props.label ?? "Pagination"} className="mt-4 flex items-center justify-center gap-3">
      <Button
        size="sm"
        variant="outline"
        aria-label={props.label ? `${props.label}: previous` : undefined}
        disabled={props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
      >
        Previous
      </Button>
      <span className="text-xs text-muted-foreground">
        Page {props.page} of {props.totalPages}
      </span>
      <Button
        size="sm"
        variant="outline"
        aria-label={props.label ? `${props.label}: next` : undefined}
        disabled={props.page >= props.totalPages}
        onClick={() => props.onPage(props.page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

function Count(props: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-lg bg-muted/60 p-2">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="mt-1 text-sm font-semibold text-foreground">{props.value.toLocaleString()}</dd>
    </div>
  );
}
function SummaryRow(props: { label: string; value: number }): JSX.Element {
  return (
    <tr className="border-t first:border-t-0">
      <th className="py-2 text-left font-normal text-muted-foreground">{props.label}</th>
      <td className="py-2 text-right font-semibold">{props.value.toLocaleString()}</td>
    </tr>
  );
}
function InlineError({ error }: { error: unknown }): JSX.Element {
  return (
    <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {errorMessage(error)}
    </p>
  );
}

function criterion(
  id: string,
  stage: ReviewCriterion["stage"],
  type: ReviewCriterion["type"],
  label: string,
  order: number
): ReviewCriterion {
  return { id, stage, type, label, order };
}
function criterionDraft(criteria: ReviewCriterion[]): {
  abstractInclusion: string;
  abstractExclusion: string;
  fullTextInclusion: string;
  fullTextExclusion: string;
} {
  const text = (stage: ReviewCriterion["stage"], type: ReviewCriterion["type"]) =>
    criteria
      .filter((item) => item.stage === stage && item.type === type)
      .sort((a, b) => a.order - b.order)
      .map((item) => item.label)
      .join("\n");
  return {
    abstractInclusion: text("title-abstract", "inclusion"),
    abstractExclusion: text("title-abstract", "exclusion"),
    fullTextInclusion: text("full-text", "inclusion"),
    fullTextExclusion: text("full-text", "exclusion")
  };
}
function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "criterion"
  );
}
function toggledSet(current: Set<string>, value: string, enabled: boolean): Set<string> {
  const next = new Set(current);
  if (enabled) next.add(value);
  else next.delete(value);
  return next;
}
function reviewYear(value: string): number | undefined {
  if (!/^\d{4}$/.test(value)) return undefined;
  const year = Number(value);
  return year >= 1500 && year <= 3000 ? year : undefined;
}
function sourceLabel(source: ReviewPaperSummary["source"]): string {
  return paperSourceFilters.find((item) => item.value === source)?.label ?? source;
}
function isFormControl(target: EventTarget): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement
  );
}
function extractionDraft(value: ExtractionPrimitiveValue | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined) return "";
  return String(value);
}
function parseExtractionDraft(value: string, type: ExtractionFieldType): ExtractionPrimitiveValue {
  if (type === "number") return value.trim() ? Number(value) : null;
  if (type === "boolean") return value === "" ? null : value === "true";
  if (type === "multi-select")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "An unexpected review error occurred.";
}
async function invalidateReviewData(queryClient: ReturnType<typeof useQueryClient>, reviewId: string): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["review-papers", reviewId] }),
    queryClient.invalidateQueries({ queryKey: ["review-fields", reviewId] }),
    queryClient.invalidateQueries({ queryKey: ["review-values", reviewId] }),
    queryClient.invalidateQueries({ queryKey: ["review-summary", reviewId] }),
    queryClient.invalidateQueries({ queryKey: ["review-runs", reviewId] }),
    queryClient.invalidateQueries({ queryKey: ["review-run-items"] })
  ]);
}
