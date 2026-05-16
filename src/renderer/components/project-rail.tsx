import type { JSX } from "react";
import { FlaskConical, FolderPlus, ShieldCheck } from "lucide-react";
import type { Project } from "../../shared/schemas";
import { IconButton } from "./ui";

export function ProjectRail(props: {
  projects: Project[];
  activeProjectId?: string;
  onSelect(projectId: string): void;
  onCreate(): void;
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
            <button
              key={project.id}
              type="button"
              onClick={() => props.onSelect(project.id)}
              className={`w-full rounded-md px-3 py-2 text-left transition ${
                project.id === props.activeProjectId
                  ? "bg-stone-950 text-[#f4efe6] shadow-sm"
                  : "text-stone-800 hover:bg-white/60"
              }`}
            >
              <div className="truncate text-sm font-medium">{project.title}</div>
              <div className={`mt-1 truncate text-xs ${project.id === props.activeProjectId ? "text-stone-300" : "text-stone-600"}`}>
                {new Date(project.updatedAt).toLocaleString()}
              </div>
            </button>
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
