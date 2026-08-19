import type { JSX, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

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

export function PolicyToggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}): JSX.Element {
  return (
    <label className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

export function PanelSection({
  icon,
  title,
  children
}: {
  icon: JSX.Element;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="mb-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <Card className="min-w-0 rounded-lg">
      <CardContent className="min-w-0 p-3">
        <div className="text-xl font-semibold text-foreground">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export function StatusPill({ icon, label, title }: { icon: JSX.Element; label: string; title?: string }): JSX.Element {
  return (
    <Badge
      title={title}
      variant="outline"
      className="hidden h-8 max-w-[360px] gap-2 rounded-lg bg-card px-3 text-xs text-muted-foreground lg:inline-flex"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Badge>
  );
}

export function IconButton({
  label,
  onClick,
  children
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-lg"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="window-no-drag"
    >
      {children}
    </Button>
  );
}
