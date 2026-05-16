import type { JSX, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownMessage({ content, isUser }: { content: string; isUser: boolean }): JSX.Element {
  return (
    <div className={`markdown-body ${isUser ? "markdown-body-user" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function PolicyToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(checked: boolean): void }): JSX.Element {
  return (
    <label className="mt-3 flex items-center justify-between rounded-md border border-stone-200 bg-white px-3 py-2 text-sm">
      {label}
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-[#175c62]" />
    </label>
  );
}

export function PanelSection({ icon, title, children }: { icon: JSX.Element; title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-stone-600">{label}</div>
    </div>
  );
}

export function StatusPill({ icon, label, title }: { icon: JSX.Element; label: string; title?: string }): JSX.Element {
  return (
    <div
      title={title}
      className="hidden h-8 max-w-[360px] items-center gap-2 rounded-md border border-stone-300 bg-white px-3 text-xs text-stone-700 lg:inline-flex"
    >
      {icon}
      <span className="truncate">{label}</span>
    </div>
  );
}

export function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-md border border-stone-300 bg-white text-stone-700 transition hover:border-stone-500 hover:bg-stone-100"
    >
      {children}
    </button>
  );
}
