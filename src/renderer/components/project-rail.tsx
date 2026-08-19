import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Download,
  FlaskConical,
  FolderPlus,
  Import,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { Project } from "../../shared/schemas";
import { IconButton } from "./ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function ProjectRail(props: {
  projects: Project[];
  activeProjectId?: string;
  onSelect(projectId: string): void;
  onCreate(): void;
  onUpdate(input: { projectId: string; title?: string; topic?: string; description?: string }): Promise<unknown>;
  onPin(projectId: string, pinned: boolean): Promise<unknown>;
  onArchive(projectId: string, archived: boolean): Promise<unknown>;
  onDelete(projectId: string): Promise<unknown>;
  onDuplicate(projectId: string): Promise<unknown>;
  onExport(projectId: string): Promise<unknown>;
  onImport(): Promise<unknown>;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredProjects = props.projects.filter((project) =>
    [project.title, project.topic, project.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedFilter)
  );
  const activeProjects = filteredProjects.filter((project) => !project.archivedAt);
  const archivedProjects = filteredProjects.filter((project) => project.archivedAt);
  return (
    <aside className="flex min-h-0 min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-12 items-center justify-between border-b border-sidebar-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <FlaskConical size={16} className="text-primary" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Projects</div>
            <div className="truncate text-[11px] text-muted-foreground">{activeProjects.length} active</div>
          </div>
        </div>
        <div className="flex gap-1">
          <IconButton label="Import project" onClick={() => void props.onImport()}>
            <Import size={18} />
          </IconButton>
          <IconButton label="New project" onClick={props.onCreate}>
            <FolderPlus size={18} />
          </IconButton>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-sidebar-border bg-input/30 px-2 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
            <Search size={14} className="shrink-0 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search projects"
              className="h-9 min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
          </div>
          <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Projects
          </div>
          <div className="space-y-1">
            {activeProjects.map((project) => (
              <ProjectRailItem
                key={project.id}
                project={project}
                selected={project.id === props.activeProjectId}
                onSelect={props.onSelect}
                onUpdate={props.onUpdate}
                onPin={props.onPin}
                onArchive={props.onArchive}
                onDelete={props.onDelete}
                onDuplicate={props.onDuplicate}
                onExport={props.onExport}
              />
            ))}
            {!filteredProjects.length ? (
              <Alert className="border-dashed">
                <AlertDescription>
                  {props.projects.length
                    ? "No projects match that search."
                    : "Create a project from chat or the title bar."}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          {archivedProjects.length ? (
            <div className="mt-5">
              <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Archived
              </div>
              <div className="space-y-1">
                {archivedProjects.map((project) => (
                  <ProjectRailItem
                    key={project.id}
                    project={project}
                    selected={project.id === props.activeProjectId}
                    onSelect={props.onSelect}
                    onUpdate={props.onUpdate}
                    onPin={props.onPin}
                    onArchive={props.onArchive}
                    onDelete={props.onDelete}
                    onDuplicate={props.onDuplicate}
                    onExport={props.onExport}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </aside>
  );
}

function ProjectRailItem({
  project,
  selected,
  onSelect,
  onUpdate,
  onPin,
  onArchive,
  onDelete,
  onDuplicate,
  onExport
}: {
  project: Project;
  selected: boolean;
  onSelect(projectId: string): void;
  onUpdate(input: { projectId: string; title?: string; topic?: string; description?: string }): Promise<unknown>;
  onPin(projectId: string, pinned: boolean): Promise<unknown>;
  onArchive(projectId: string, archived: boolean): Promise<unknown>;
  onDelete(projectId: string): Promise<unknown>;
  onDuplicate(projectId: string): Promise<unknown>;
  onExport(projectId: string): Promise<unknown>;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);
  const [draftTopic, setDraftTopic] = useState(project.topic ?? "");
  const [draftDescription, setDraftDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!editing) {
      setDraftTitle(project.title);
      setDraftTopic(project.topic ?? "");
      setDraftDescription(project.description ?? "");
    }
  }, [editing, project.description, project.title, project.topic]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  async function save(): Promise<void> {
    const nextTitle = draftTitle.trim();
    if (!nextTitle) {
      setError("Project name cannot be empty.");
      return;
    }
    if (
      nextTitle === project.title &&
      draftTopic.trim() === (project.topic ?? "") &&
      draftDescription.trim() === (project.description ?? "")
    ) {
      setEditing(false);
      setError(undefined);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onUpdate({
        projectId: project.id,
        title: nextTitle,
        topic: draftTopic.trim(),
        description: draftDescription.trim()
      });
      setEditing(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setSaving(false);
    }
  }

  function cancel(): void {
    setDraftTitle(project.title);
    setDraftTopic(project.topic ?? "");
    setDraftDescription(project.description ?? "");
    setEditing(false);
    setError(undefined);
  }

  if (editing) {
    return (
      <div
        className={cn(
          "rounded-lg px-3 py-2",
          selected ? "bg-primary text-primary-foreground shadow-sm" : "bg-card text-card-foreground"
        )}
      >
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancel();
            }}
            disabled={saving}
            className={`h-8 w-full rounded-md border px-2 text-sm font-medium outline-none ${
              selected
                ? "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground focus:border-primary-foreground/70"
                : "border-input bg-background text-foreground focus:border-ring"
            }`}
            maxLength={120}
          />
          <Input
            value={draftTopic}
            onChange={(event) => setDraftTopic(event.target.value)}
            disabled={saving}
            placeholder="Topic"
            className={cn(
              "h-8 text-xs",
              selected &&
                "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground placeholder:text-primary-foreground/55"
            )}
            maxLength={240}
          />
          <Textarea
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            disabled={saving}
            placeholder="Description"
            className={cn(
              "min-h-16 resize-none text-xs",
              selected &&
                "border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground placeholder:text-primary-foreground/55"
            )}
            maxLength={2000}
          />
          <div className="flex gap-1">
            <ActionIcon label="Save project details" selected={selected} disabled={saving} type="submit">
              <Check size={14} />
            </ActionIcon>
            <ActionIcon label="Cancel edit" selected={selected} disabled={saving} onClick={cancel}>
              <X size={14} />
            </ActionIcon>
          </div>
        </form>
        {error ? (
          <div className={`mt-1 text-xs ${selected ? "text-primary-foreground/85" : "text-destructive"}`}>{error}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left transition",
        selected ? "bg-primary text-primary-foreground shadow-sm" : "text-sidebar-foreground hover:bg-sidebar-accent"
      )}
    >
      <button type="button" onClick={() => onSelect(project.id)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-medium">{project.title}</div>
        <div className={cn("mt-1 truncate text-xs", selected ? "text-primary-foreground/70" : "text-muted-foreground")}>
          {project.archivedAt ? "Archived" : project.topic || new Date(project.updatedAt).toLocaleString()}
        </div>
      </button>
      <div className="flex shrink-0 flex-wrap justify-end gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <RailAction
          label={project.pinnedAt ? "Unpin project" : "Pin project"}
          selected={selected}
          onClick={() => void onPin(project.id, !project.pinnedAt)}
        >
          {project.pinnedAt ? <PinOff size={12} /> : <Pin size={12} />}
        </RailAction>
        <RailAction label="Edit project" selected={selected} onClick={() => setEditing(true)}>
          <Pencil size={12} />
        </RailAction>
        <RailAction label="Duplicate project" selected={selected} onClick={() => void onDuplicate(project.id)}>
          <Copy size={12} />
        </RailAction>
        <RailAction label="Export project" selected={selected} onClick={() => void onExport(project.id)}>
          <Download size={12} />
        </RailAction>
        <RailAction
          label={project.archivedAt ? "Unarchive project" : "Archive project"}
          selected={selected}
          onClick={() => void onArchive(project.id, !project.archivedAt)}
        >
          {project.archivedAt ? <ArchiveRestore size={12} /> : <Archive size={12} />}
        </RailAction>
        <RailAction
          label="Delete project"
          selected={selected}
          danger
          onClick={() => {
            if (window.confirm(`Delete "${project.title}" and its local files? This cannot be undone.`)) {
              void onDelete(project.id);
            }
          }}
        >
          <Trash2 size={12} />
        </RailAction>
      </div>
    </div>
  );
}

function RailAction({
  label,
  selected,
  danger,
  onClick,
  children
}: {
  label: string;
  selected: boolean;
  danger?: boolean;
  onClick(): void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`window-no-drag grid size-6 place-items-center rounded-md border transition ${
        selected
          ? "border-primary-foreground/25 text-primary-foreground/75 hover:bg-primary-foreground/10"
          : danger
            ? "border-border bg-card text-destructive hover:border-destructive"
            : "border-border bg-card text-muted-foreground hover:border-primary hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function ActionIcon({
  label,
  selected,
  disabled,
  type = "button",
  onClick,
  children
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  onClick?(): void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      variant={selected ? "secondary" : "outline"}
      size="icon"
      className="window-no-drag"
    >
      {children}
    </Button>
  );
}
