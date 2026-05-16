import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Check, FlaskConical, FolderPlus, Pencil, ShieldCheck, X } from "lucide-react";
import type { Project } from "../../shared/schemas";
import { IconButton } from "./ui";

export function ProjectRail(props: {
  projects: Project[];
  activeProjectId?: string;
  onSelect(projectId: string): void;
  onCreate(): void;
  onRename(projectId: string, title: string): Promise<unknown>;
}): JSX.Element {
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
        <IconButton label="New project" onClick={props.onCreate}>
          <FolderPlus size={18} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600">Projects</div>
        <div className="space-y-1">
          {props.projects.map((project) => (
            <ProjectRailItem
              key={project.id}
              project={project}
              selected={project.id === props.activeProjectId}
              onSelect={props.onSelect}
              onRename={props.onRename}
            />
          ))}
          {!props.projects.length ? (
            <div className="rounded-md border border-dashed border-stone-400 px-3 py-4 text-sm text-stone-600">
              Create a project from chat or the toolbar.
            </div>
          ) : null}
        </div>
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
  onRename
}: {
  project: Project;
  selected: boolean;
  onSelect(projectId: string): void;
  onRename(projectId: string, title: string): Promise<unknown>;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!editing) setDraftTitle(project.title);
  }, [editing, project.title]);

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
    if (nextTitle === project.title) {
      setEditing(false);
      setError(undefined);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onRename(project.id, nextTitle);
      setEditing(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setSaving(false);
    }
  }

  function cancel(): void {
    setDraftTitle(project.title);
    setEditing(false);
    setError(undefined);
  }

  if (editing) {
    return (
      <div className={`rounded-md px-3 py-2 ${selected ? "bg-stone-950 text-[#f4efe6] shadow-sm" : "bg-white/70 text-stone-800"}`}>
        <form
          className="flex items-center gap-1"
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
            className={`h-8 min-w-0 flex-1 rounded-md border px-2 text-sm font-medium outline-none ${
              selected
                ? "border-stone-600 bg-stone-900 text-[#f4efe6] focus:border-[#d8eadf]"
                : "border-stone-300 bg-white text-stone-900 focus:border-[#175c62]"
            }`}
            maxLength={120}
          />
          <button
            type="submit"
            disabled={saving}
            title="Save project name"
            aria-label="Save project name"
            className={`grid size-8 shrink-0 place-items-center rounded-md border transition ${
              selected ? "border-stone-600 text-[#d8eadf] hover:bg-stone-800" : "border-stone-300 text-stone-700 hover:bg-stone-100"
            } disabled:opacity-50`}
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            title="Cancel rename"
            aria-label="Cancel rename"
            className={`grid size-8 shrink-0 place-items-center rounded-md border transition ${
              selected ? "border-stone-600 text-stone-300 hover:bg-stone-800" : "border-stone-300 text-stone-700 hover:bg-stone-100"
            } disabled:opacity-50`}
          >
            <X size={14} />
          </button>
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
          {new Date(project.updatedAt).toLocaleString()}
        </div>
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename project"
        aria-label={`Rename ${project.title}`}
        className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border opacity-0 transition group-hover:opacity-100 focus:opacity-100 ${
          selected ? "border-stone-700 text-stone-300 hover:bg-stone-800" : "border-stone-300 bg-white/70 text-stone-600 hover:border-[#175c62] hover:text-[#175c62]"
        }`}
      >
        <Pencil size={13} />
      </button>
    </div>
  );
}
