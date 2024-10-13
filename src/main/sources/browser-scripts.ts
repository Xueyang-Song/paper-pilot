export const googleScholarPlaywrightScript = String.raw`
import json
import os
import re
import subprocess
import sys
import urllib.parse

def ensure_playwright():
    try:
        import playwright  # noqa: F401
    except Exception:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)

def text_or_empty(locator):
    try:
        return locator.inner_text(timeout=1200).strip()
    except Exception:
        return ""

def attr_or_empty(locator, attr):
    try:
        return locator.get_attribute(attr, timeout=1200) or ""
    except Exception:
        return ""

def parse_year(text):
    match = re.search(r"\b(19|20)\d{2}\b", text or "")
    return int(match.group(0)) if match else None

def main():
    ensure_playwright()
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

    topic = sys.argv[1]
    max_papers = max(1, min(int(sys.argv[2]), 50))
    base_url = os.environ.get("PAPER_PILOT_SCHOLAR_URL", "https://scholar.google.com/scholar")
    warnings = []
    papers = []
    seen = set()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 1280, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 PaperPilot/0.1",
        )
        page.set_default_timeout(12000)
        try:
            if base_url.startswith("file:"):
                url = base_url
            else:
                url = base_url + "?" + urllib.parse.urlencode({"q": topic, "hl": "en"})
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_selector("div.gs_r, .paper-pilot-result", timeout=15000)
            except PlaywrightTimeoutError:
                warnings.append("Timed out waiting for search results. The source may be blocking automation or the query returned no visible results.")

            if "sorry" in page.url.lower() or "captcha" in page.content().lower():
                warnings.append("Google Scholar returned an anti-automation or CAPTCHA page. No results were extracted.")
            else:
                while len(papers) < max_papers:
                    result_locators = page.locator("div.gs_r, .paper-pilot-result").all()
                    if not result_locators:
                        break
                    for result in result_locators:
                        if len(papers) >= max_papers:
                            break
                        title_node = result.locator("h3.gs_rt, .paper-pilot-title").first
                        link_node = result.locator("h3.gs_rt a, .paper-pilot-title a").first
                        title = text_or_empty(title_node).replace("[PDF]", "").replace("[HTML]", "").strip()
                        url_value = attr_or_empty(link_node, "href")
                        snippet = text_or_empty(result.locator(".gs_rs, .paper-pilot-snippet").first)
                        meta = text_or_empty(result.locator(".gs_a, .paper-pilot-meta").first)
                        if not title:
                            continue
                        key = (title.lower(), url_value)
                        if key in seen:
                            continue
                        seen.add(key)
                        papers.append({
                            "title": title,
                            "abstract": snippet or None,
                            "authors": [part.strip() for part in re.split(r"\s+-\s+|,", meta.split(" - ")[0] if meta else "") if part.strip()][:8],
                            "year": parse_year(meta),
                            "url": url_value or None,
                            "source": "google-scholar",
                            "sourcePaperId": url_value or title,
                            "venue": meta or None,
                            "isOpenAccess": False,
                            "fieldsOfStudy": [],
                            "raw": {"meta": meta},
                        })
                    next_link = page.locator("a:has-text('Next')").last
                    if len(papers) >= max_papers or next_link.count() == 0:
                        break
                    try:
                        next_link.click(timeout=3000)
                        page.wait_for_load_state("domcontentloaded", timeout=15000)
                    except Exception:
                        warnings.append("Could not advance to the next Scholar page.")
                        break
        except Exception as exc:
            warnings.append(f"Browser crawl failed gracefully: {type(exc).__name__}: {exc}")
        finally:
            browser.close()

    print(json.dumps({"papers": papers, "warnings": warnings}, ensure_ascii=True))

if __name__ == "__main__":
    main()
`;
