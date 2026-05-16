export class CrawlHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false
  ) {
    super(message);
    this.name = "CrawlHttpError";
  }
}

export interface CrawlerRequestInit extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export async function getJson<T>(url: URL, init: CrawlerRequestInit = {}): Promise<T> {
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "PaperPilot/0.1 research-crawler",
      ...init.headers
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new CrawlHttpError(
      `Request failed ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`,
      response.status,
      isRetryableStatus(response.status)
    );
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new CrawlHttpError(`Malformed JSON response from ${url.host}: ${formatCrawlerError(error)}`, undefined, false);
  }
}

export async function getText(url: URL, init: CrawlerRequestInit = {}): Promise<string> {
  const response = await fetchWithRetry(url, {
    ...init,
    headers: {
      Accept: "application/xml,text/xml,text/plain,*/*",
      "User-Agent": "PaperPilot/0.1 research-crawler",
      ...init.headers
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new CrawlHttpError(
      `Request failed ${response.status} ${response.statusText}: ${detail.slice(0, 300)}`,
      response.status,
      isRetryableStatus(response.status)
    );
  }
  return response.text();
}

export async function fetchWithRetry(url: URL, init: CrawlerRequestInit = {}): Promise<Response> {
  const retries = Math.max(0, init.retries ?? 1);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, withTimeout(init));
      if (!response.ok && isRetryableStatus(response.status) && attempt < retries) {
        lastError = new CrawlHttpError(`Retryable HTTP ${response.status} from ${url.host}`, response.status, true);
        await delay(250 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = normalizeCrawlerError(error, url);
      if (!isRetryableError(lastError) || attempt >= retries) throw lastError;
      await delay(250 * (attempt + 1));
    }
  }
  throw normalizeCrawlerError(lastError, url);
}

export function formatCrawlerError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function withTimeout(init: CrawlerRequestInit): RequestInit {
  const { timeoutMs = 30000, retries: _retries, signal, ...rest } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...rest,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  };
}

function normalizeCrawlerError(error: unknown, url: URL): Error {
  if (error instanceof CrawlHttpError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new CrawlHttpError(`Request to ${url.host} timed out.`, undefined, true);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new CrawlHttpError(`Request to ${url.host} was aborted.`, undefined, true);
  }
  if (error instanceof Error && /fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(error.message)) {
    return new CrawlHttpError(`Network request to ${url.host} failed: ${error.message}`, undefined, true);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isRetryableError(error: unknown): boolean {
  return error instanceof CrawlHttpError && error.retryable;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
