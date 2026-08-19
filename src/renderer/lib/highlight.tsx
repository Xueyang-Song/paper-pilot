import type { JSX } from "react";
import { useEffect, useMemo, useRef } from "react";
export function HighlightedSnippet({ value, query }: { value: string; query: string }): JSX.Element {
  const segments = parseMarkedSegments(value);
  if (segments.some((segment) => segment.match)) {
    return (
      <>
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={`${segment.text}-${index}`} className="rounded bg-accent px-0.5 text-accent-foreground">
              {segment.text}
            </mark>
          ) : (
            <span key={`${segment.text}-${index}`}>{segment.text}</span>
          )
        )}
      </>
    );
  }
  return <HighlightedText value={value} query={query} tone="light" />;
}
export function HighlightedText({
  value,
  query,
  tone,
  activeHitIndex = 0,
  onHitCountChange,
  scrollToActive = false
}: {
  value: string;
  query: string;
  tone: "light" | "dark";
  activeHitIndex?: number;
  onHitCountChange?(hitCount: number): void;
  scrollToActive?: boolean;
}): JSX.Element {
  const segments = useMemo(() => splitHighlightedText(value, query), [query, value]);
  const hitRefs = useRef<HTMLElement[]>([]);
  hitRefs.current = [];
  const hitCount = segments.filter((segment) => segment.match).length;
  useEffect(() => {
    onHitCountChange?.(hitCount);
  }, [hitCount, onHitCountChange]);
  useEffect(() => {
    if (!scrollToActive || !hitCount) return;
    const target = hitRefs.current[Math.max(0, Math.min(activeHitIndex, hitCount - 1))];
    const frame = window.requestAnimationFrame(() => {
      target?.scrollIntoView({ block: "center", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeHitIndex, hitCount, scrollToActive, segments]);
  let matchIndex = 0;
  return (
    <>
      {segments.map((segment, index) => {
        if (!segment.match) return <span key={`${segment.text}-${index}`}>{segment.text}</span>;
        const currentMatchIndex = matchIndex;
        matchIndex += 1;
        const active = currentMatchIndex === activeHitIndex;
        return (
          <mark
            key={`${segment.text}-${index}`}
            ref={(node) => {
              if (node) hitRefs.current[currentMatchIndex] = node;
            }}
            className={`rounded px-0.5 ${
              active
                ? tone === "dark"
                  ? "bg-primary text-primary-foreground ring-2 ring-primary/50"
                  : "bg-primary text-primary-foreground ring-2 ring-primary/35"
                : tone === "dark"
                  ? "bg-accent text-accent-foreground"
                  : "bg-accent text-accent-foreground"
            }`}
          >
            {segment.text}
          </mark>
        );
      })}
    </>
  );
}
function parseMarkedSegments(value: string): Array<{ text: string; match: boolean }> {
  const segments: Array<{ text: string; match: boolean }> = [];
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("[[", index);
    if (start === -1) {
      segments.push({ text: value.slice(index), match: false });
      break;
    }
    if (start > index) segments.push({ text: value.slice(index, start), match: false });
    const end = value.indexOf("]]", start + 2);
    if (end === -1) {
      segments.push({ text: value.slice(start), match: false });
      break;
    }
    segments.push({ text: value.slice(start + 2, end), match: true });
    index = end + 2;
  }
  return segments.filter((segment) => segment.text.length > 0);
}
function splitHighlightedText(value: string, query: string): Array<{ text: string; match: boolean }> {
  const tokens = buildHighlightTokens(query);
  if (!tokens.length) return [{ text: value, match: false }];
  const matcher = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (const match of value.matchAll(matcher)) {
    const matchText = match[0];
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: value.slice(cursor, index), match: false });
    segments.push({ text: matchText, match: true });
    cursor = index + matchText.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), match: false });
  return segments.length ? segments : [{ text: value, match: false }];
}
export function buildHighlightTokens(query: string): string[] {
  const normalized = query
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return Array.from(new Set(normalized))
    .slice(0, 8)
    .sort((left, right) => right.length - left.length);
}
export function countOccurrences(value: string, token: string): number {
  let count = 0;
  let index = value.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(token, index + Math.max(1, token.length));
  }
  return count;
}
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
