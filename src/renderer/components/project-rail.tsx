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
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import type { Project } from "../../shared/schemas";
import { IconButton } from "./ui";

export function ProjectRail(props: {
  projects: Project[];
  activeProjectId?: string;
  onSelect(projectId: string): void;
  onCreate(): void;
  onRename(projectId: string, title: string): Promise<unknown>;
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
    [project.title, project.topic, project.description].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter)
  );
  const activeProjects = filteredProjects.filter((project) => !project.archivedAt);
  const archivedProjects = filteredProjects.filter((project) => project.archivedAt);
  return (
    <aside className="flex min-h-0 flex-col bg-[#e8dfd2]">
      <div className="flex h-16 items-center justify-between border-b border-stone-300 px-4">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-md bg-stone-950 text-[#f4efe6]">
            <FlaskConical size={18} />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-wide">Paper Pilot</div>
            <div className="text-xs text-stone-600">Local research agent</div>
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
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex items-center gap-2 rounded-md border border-stone-300 bg-white/70 px-2">
          <Search size={14} className="shrink-0 text-stone-500" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search projects"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-stone-500"
          />
        </div>
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600">Projects</div>
        <div className="space-y-1">
          {activeProjects.map((project) => (
            <ProjectRailItem
              key={project.id}
              project={project}
              selected={project.id === props.activeProjectId}
              onSelect={props.onSelect}
              onRename={props.onRename}
              onUpdate={props.onUpdate}
              onPin={props.onPin}
              onArchive={props.onArchive}
              onDelete={props.onDelete}
              onDuplicate={props.onDuplicate}
              onExport={props.onExport}
            />
          ))}
          {!filteredProjects.length ? (
            <div className="rounded-md border border-dashed border-stone-400 px-3 py-4 text-sm text-stone-600">
              {props.projects.length ? "No projects match that search." : "Create a project from chat or the toolbar."}
            </div>
          ) : null}
        </div>
        {archivedProjects.length ? (
          <div className="mt-5">
            <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600">Archived</div>
            <div className="space-y-1">
              {archivedProjects.map((project) => (
                <ProjectRailItem
                  key={project.id}
                  project={project}
                  selected={project.id === props.activeProjectId}
                  onSelect={props.onSelect}
                  onRename={props.onRename}
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
      <div className="border-t border-stone-300 p-3">
        <div className="rounded-md bg-[#d8eadf] p-3 text-xs text-stone-800">
          <div className="mb-1 flex items-center gap-2 font-semibold">
            <ShieldCheck size={14} />
            Local-first storage
          </div>
          SQLite, artifacts, keys, scripts, and logs stay on this machine.
        </div>
      </div>
    </aside>
  );
}

function ProjectRailItem({
  project,
  selected,
  onSelect,
  onRename,
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
  onRename(projectId: string, title: string): Promise<unknown>;
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
      <div className={`rounded-md px-3 py-2 ${selected ? "bg-stone-950 text-[#f4efe6] shadow-sm" : "bg-white/70 text-stone-800"}`}>
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
                ? "border-stone-600 bg-stone-900 text-[#f4efe6] focus:border-[#d8eadf]"
                : "border-stone-300 bg-white text-stone-900 focus:border-[#175c62]"
            }`}
            maxLength={120}
          />
          <input
            value={draftTopic}
            onChange={(event) => setDraftTopic(event.target.value)}
            disabled={saving}
            placeholder="Topic"
            className="h-8 w-full rounded-md border border-stone-300 bg-white px-2 text-xs text-stone-900 outline-none focus:border-[#175c62]"
            maxLength={240}
          />
          <textarea
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            disabled={saving}
            placeholder="Description"
            className="min-h-16 w-full resize-none rounded-md border border-stone-300 bg-white px-2 py-1.5 text-xs text-stone-900 outline-none focus:border-[#175c62]"
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
        {error ? <div className={`mt-1 text-xs ${selected ? "text-[#f3d4dc]" : "text-[#7b2d43]"}`}>{error}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={`group flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition ${
        selected ? "bg-stone-950 text-[#f4efe6] shadow-sm" : "text-stone-800 hover:bg-white/60"
      }`}
    >
      <button type="button" onClick={() => onSelect(project.id)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-medium">{project.title}</div>
        <div className={`mt-1 truncate text-xs ${selected ? "text-stone-300" : "text-stone-600"}`}>
          {project.archivedAt ? "Archived" : project.topic || new Date(project.updatedAt).toLocaleString()}
        </div>
      </button>
      <div className="flex shrink-0 flex-wrap justify-end gap-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        <RailAction label={project.pinnedAt ? "Unpin project" : "Pin project"} selected={selected} onClick={() => void onPin(project.id, !project.pinnedAt)}>
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
      className={`grid size-6 place-items-center rounded-md border transition ${
        selected
          ? "border-stone-700 text-stone-300 hover:bg-stone-800"
          : danger
            ? "border-stone-300 bg-white/70 text-[#7b2d43] hover:border-[#7b2d43]"
            : "border-stone-300 bg-white/70 text-stone-600 hover:border-[#175c62] hover:text-[#175c62]"
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
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`grid size-8 shrink-0 place-items-center rounded-md border transition ${
        selected ? "border-stone-600 text-[#d8eadf] hover:bg-stone-800" : "border-stone-300 text-stone-700 hover:bg-stone-100"
      } disabled:opacity-50`}
    >
      {children}
    </button>
  );
}
