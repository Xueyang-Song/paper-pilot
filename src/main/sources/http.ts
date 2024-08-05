export async function getJson<T>(url: URL, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "PaperPilot/0.1 research-crawler",
      ...init.headers
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Request failed ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export async function getText(url: URL, init: RequestInit = {}): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/xml,text/xml,text/plain,*/*",
      "User-Agent": "PaperPilot/0.1 research-crawler",
      ...init.headers
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Request failed ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`);
  }
  return response.text();
}

export function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

export function cleanDoi(value: unknown): string | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;
  return raw.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
}

export function yearFromDate(value: unknown): number | undefined {
  const raw = firstString(value);
  if (!raw) return undefined;
  const match = raw.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}
