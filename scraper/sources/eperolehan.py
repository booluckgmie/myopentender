"""
ePerolehan — Federal procurement portal.
URL: https://www.eperolehan.gov.my/quotation-tender-notice

Strategy (no browser required):
  1. GET page with curl_cffi (Chrome TLS fingerprint) — bypasses TLS-based WAF
  2. Extract JSF ViewState + Liferay p_auth token from HTML
  3. POST PrimeFaces partial-render AJAX calls to paginate — pure HTTP, fast
  4. Fall back to Playwright+Tor if curl_cffi is blocked

PrimeFaces pagination = POST with javax.faces.partial.ajax=true to the portlet action URL.
"""
import logging
import re
from typing import Iterator

from bs4 import BeautifulSoup

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 1
SOURCE_NAME = "ePerolehan"
BASE_URL = "https://www.eperolehan.gov.my/quotation-tender-notice"
TABS_TO_SCRAPE = [0, 1]
TAB_NAMES = ["DIIKLANKAN", "DIKEMASKINI", "DITUTUP", "SELESAI", "DIBATALKAN"]

# Playwright proxy (Tor or residential) — set EPEROLEHAN_PROXY_URL env var
import os
PROXY_URL = os.environ.get("EPEROLEHAN_PROXY_URL")

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _tbody_id(i):    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_data"
def _paginator_id(i):return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_paginator_bottom"
def _tab_href(i):    return f"#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbresultTabs"
def _form_id():      return "_scNoticeBoard_WAR_NGePportlet_:form"
def _table_id(i):    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults"


def _parse_date_str(raw: str):
    if not raw:
        return None
    m = re.match(r'^(\d{2})/(\d{2})/(\d{4})', raw.strip())
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return parse_date(raw)


def _infer_category(title: str):
    if not title:
        return None
    t = title.upper()
    if re.match(r'^TENDER\b', t):                       return 'Tender'
    if re.match(r'^SEBUT\s*HARGA\b|^SEBUTHARGA\b', t): return 'Sebut Harga'
    if re.match(r'^MEMBEKAL\b|^BEKALAN\b', t):          return 'Bekalan'
    if re.match(r'^PERKHIDMATAN\b', t):                 return 'Perkhidmatan'
    if re.match(r'^KERJA[\s\-]', t):                    return 'Kerja'
    if re.match(r'^CADANGAN\b', t):                     return 'Cadangan'
    return None


def _parse_rows_from_html(html: str, tab_idx: int) -> list:
    """Parse tender rows from full-page or partial JSF response HTML."""
    soup = BeautifulSoup(html, "lxml")
    tbody_id = _tbody_id(tab_idx)
    tbody = soup.find(id=tbody_id)
    if not tbody:
        # Try unwrapping CDATA from JSF partial response
        # <update id="..."><![CDATA[...]]></update>
        cdata = re.search(
            r'<update[^>]+id="' + re.escape(tbody_id) + r'"[^>]*>'
            r'(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</update>',
            html, re.DOTALL
        )
        if cdata:
            soup2 = BeautifulSoup(cdata.group(1), "lxml")
            tbody = soup2.find(lambda t: t.name in ("tbody", "table") and t.get("id") == tbody_id) \
                    or soup2.find("tbody")
    if not tbody:
        return []

    rows = []
    for tr in tbody.find_all("tr", attrs={"data-ri": True}):
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        link = tds[0].find("a", class_="ui-commandlink")
        title = (link.get_text() if link else tds[0].get_text()).strip()
        ministry = tds[1].get_text().strip() if tds[1] else None
        open_raw = tds[2].get_text().strip() if tds[2] else None
        close_raw = tds[3].get_text().strip() if tds[3] else None
        rows.append({"title": title, "ministry": ministry, "openRaw": open_raw, "closeRaw": close_raw})
    return rows


def _get_paginator_total(html: str, tab_idx: int) -> int:
    soup = BeautifulSoup(html, "lxml")
    pg_id = _paginator_id(tab_idx)
    pg = soup.find(id=pg_id)
    if not pg:
        return 1
    cur = pg.find(class_="ui-paginator-current")
    if not cur:
        return 1
    m = re.search(r'(\d+)\s*/\s*(\d+)', cur.get_text())
    return int(m.group(2)) if m else 1


# ── Approach 1: curl_cffi direct HTTP (Chrome TLS fingerprint, no browser) ──

def _scrape_curl_cffi(now: str) -> Iterator[dict]:
    """
    Use curl_cffi to GET the page (Chrome TLS impersonation) then POST
    PrimeFaces AJAX partial-render requests for each page of each tab.
    This bypasses TLS-fingerprint WAFs without needing a browser.
    """
    from curl_cffi import requests as cffi

    session = cffi.Session(impersonate="chrome124")
    session.headers.update({
        "User-Agent": _UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.eperolehan.gov.my/",
    })

    logger.info("[%s] curl_cffi GET %s", SOURCE_NAME, BASE_URL)
    resp = session.get(BASE_URL, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"GET returned {resp.status_code}")
    html = resp.text
    if "Access Is Currently Unavailable" in html:
        raise RuntimeError("WAF blocked curl_cffi request")

    soup = BeautifulSoup(html, "lxml")

    # Extract Liferay p_auth token (CSRF) from a portlet action link
    p_auth = None
    for a in soup.find_all("a", href=True):
        m = re.search(r'p_auth=([^&"]+)', a["href"])
        if m:
            p_auth = m.group(1)
            break
    if not p_auth:
        # Try form action
        form = soup.find("form", id=_form_id())
        if form and form.get("action"):
            m = re.search(r'p_auth=([^&"]+)', form["action"])
            if m:
                p_auth = m.group(1)

    # Extract JSF ViewState
    vs_input = soup.find("input", {"name": "javax.faces.ViewState"})
    view_state = vs_input["value"] if vs_input else None

    if not view_state:
        raise RuntimeError("Could not extract ViewState from page — JS-only rendering, need browser fallback")

    logger.info("[%s] curl_cffi: ViewState=%s… p_auth=%s", SOURCE_NAME,
                str(view_state)[:20], p_auth)

    # Build the portlet action POST URL
    portlet_id = "scNoticeBoard_WAR_NGePportlet"
    action_url = (
        f"{BASE_URL}?p_p_id={portlet_id}&p_p_lifecycle=1"
        f"&p_p_state=normal&p_p_mode=view"
        f"&p_p_col_id=column-1&p_p_col_count=5&p_p_col_pos=2"
    )
    if p_auth:
        action_url += f"&p_auth={p_auth}"

    session.headers.update({
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Faces-Request": "partial/ajax",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://www.eperolehan.gov.my",
        "Referer": BASE_URL,
    })

    total_yielded = 0

    for tab_idx in TABS_TO_SCRAPE:
        tab_name = TAB_NAMES[tab_idx] if tab_idx < len(TAB_NAMES) else str(tab_idx)
        logger.info("[%s] ── tab %d (%s)", SOURCE_NAME, tab_idx, tab_name)

        table_comp = _table_id(tab_idx)

        # For tab > 0: POST a tab-click action first
        if tab_idx > 0:
            tab_payload = {
                "javax.faces.partial.ajax": "true",
                "javax.faces.source": table_comp,
                "javax.faces.partial.execute": "@all",
                "javax.faces.partial.render": table_comp,
                _form_id(): _form_id(),
                "javax.faces.ViewState": view_state,
                f"_{portlet_id}_:form:j_idt282:{tab_idx}:nbresultTabs_newTab":
                    f"_{portlet_id}_:form:j_idt282:{tab_idx}:nbresultTabs",
                f"_{portlet_id}_:form:j_idt282:{tab_idx}:nbresultTabs_tabindex": str(tab_idx),
            }
            tr = session.post(action_url, data=tab_payload, timeout=30)
            if tr.status_code == 200:
                new_vs = re.search(r'javax\.faces\.ViewState["\s\w:=]*value="([^"]+)"', tr.text)
                if new_vs:
                    view_state = new_vs.group(1)

        # First page: parse from current HTML
        first_resp = session.post(action_url, timeout=30, data={
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": table_comp,
            "javax.faces.partial.execute": table_comp,
            "javax.faces.partial.render": table_comp,
            _form_id(): _form_id(),
            "javax.faces.ViewState": view_state,
        })
        page_html = first_resp.text if first_resp.status_code == 200 else html

        total_pages = _get_paginator_total(page_html, tab_idx)
        logger.info("[%s]   total pages: %d", SOURCE_NAME, total_pages)

        for pn in range(1, total_pages + 1):
            rows = _parse_rows_from_html(page_html, tab_idx)
            logger.info("[%s]   p%d/%d: %d rows", SOURCE_NAME, pn, total_pages, len(rows))

            for r in rows:
                title = r.get("title", "")
                if not title or len(title) < 15:
                    continue
                od = _parse_date_str(r.get("openRaw"))
                dl = _parse_date_str(r.get("closeRaw"))
                yield {
                    "source_id": SOURCE_ID, "ref": None, "title": title,
                    "category": _infer_category(title),
                    "ministry": r.get("ministry") or None,
                    "open_date": od, "deadline": dl,
                    "status": infer_status(od, dl),
                    "url": BASE_URL, "scraped_at": now,
                }
                total_yielded += 1

            if pn >= total_pages:
                break

            # Click next page via partial AJAX POST
            next_payload = {
                "javax.faces.partial.ajax": "true",
                "javax.faces.source": f"{table_comp}_paginator_bottom",
                "javax.faces.partial.execute": table_comp,
                "javax.faces.partial.render": table_comp,
                _form_id(): _form_id(),
                "javax.faces.ViewState": view_state,
                f"{table_comp}_pagination": "true",
                f"{table_comp}_first": str(pn * 20),
                f"{table_comp}_rows": "20",
            }
            nr = session.post(action_url, data=next_payload, timeout=30)
            if nr.status_code != 200:
                logger.warning("[%s]   pagination POST returned %d", SOURCE_NAME, nr.status_code)
                break
            page_html = nr.text
            # Update ViewState from AJAX response
            new_vs = re.search(r'javax\.faces\.ViewState[^"]*"([^"]{20,})"', page_html)
            if new_vs:
                view_state = new_vs.group(1)

    logger.info("[%s] curl_cffi done — %d records", SOURCE_NAME, total_yielded)


# ── Approach 2: Playwright + Tor/proxy fallback ──

def _tbody_id_js(i):    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_data"
def _paginator_id_js(i):return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_paginator_bottom"
def _tab_href_js(i):    return f"#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbresultTabs"


def _parse_proxy_for_playwright(url):
    if not url:
        return None
    try:
        from urllib.parse import urlparse, unquote
        u = urlparse(url)
        cfg = {"server": f"{u.scheme}://{u.hostname}:{u.port}"}
        if u.username: cfg["username"] = unquote(u.username)
        if u.password: cfg["password"] = unquote(u.password)
        return cfg
    except Exception:
        return {"server": url}


def _scrape_playwright_browser(pw, browser_type_name: str, now: str) -> Iterator[dict]:
    proxy_cfg = _parse_proxy_for_playwright(PROXY_URL)
    proxy_args = {"proxy": proxy_cfg} if proxy_cfg else {}

    if browser_type_name == "chromium":
        btype = pw.chromium
        launch = {"headless": True, "args": [
            "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled", "--window-size=1366,768",
        ], **proxy_args}
        ctx_opts = {
            "user_agent": _UA, "locale": "ms-MY",
            "viewport": {"width": 1366, "height": 768},
            "extra_http_headers": {"Accept-Language": "ms-MY,ms;q=0.9,en;q=0.7"},
            **proxy_args,
        }
        init_script = ("() => { Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
                        "window.chrome={runtime:{}}; }")
    else:
        btype = pw.firefox
        launch = {"headless": True, **proxy_args}
        ctx_opts = {
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
            "locale": "ms-MY", "viewport": {"width": 1366, "height": 768},
            **proxy_args,
        }
        init_script = None

    browser = btype.launch(**launch)
    total_yielded = 0
    try:
        ctx = browser.new_context(**ctx_opts)
        if init_script:
            ctx.add_init_script(init_script)
        page = ctx.new_page()
        page.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image","media","font") else r.continue_())

        page.goto(BASE_URL, wait_until="load", timeout=90000)
        page.wait_for_timeout(5000)
        try:
            page.wait_for_function("()=>document.querySelectorAll('tr[data-ri]').length>0", timeout=60000)
        except Exception:
            pass

        row_count = page.evaluate("()=>document.querySelectorAll('tr[data-ri]').length")
        logger.info("[%s] [%s] page ready — %d rows", SOURCE_NAME, browser_type_name, row_count)
        if row_count == 0:
            snippet = page.evaluate("()=>document.body.innerText.slice(0,200)").replace("\n"," ")
            logger.warning("[%s] 0 rows. Page: %s", SOURCE_NAME, snippet)
            return

        for tab_idx in TABS_TO_SCRAPE:
            tab_name = TAB_NAMES[tab_idx] if tab_idx < len(TAB_NAMES) else str(tab_idx)
            logger.info("[%s] ── tab %d (%s)", SOURCE_NAME, tab_idx, tab_name)
            if tab_idx != 0:
                href = _tab_href_js(tab_idx)
                page.evaluate(f'()=>{{ const l=document.querySelector(`.ui-tabs-nav a[href=\\"{href}\\"]`); if(l)l.click(); }}')
                try:
                    tb = _tbody_id_js(tab_idx)
                    page.wait_for_function(f'(id)=>{{ const t=document.getElementById(id); return t&&t.querySelectorAll("tr[data-ri]").length>0; }}', tb, timeout=30000)
                except Exception:
                    page.wait_for_timeout(6000)
            page.wait_for_timeout(1000)

            def get_state(ti=tab_idx):
                return page.evaluate(f"""(pgId)=>{{
                    const pg=document.getElementById(pgId);
                    if(!pg) return {{current:1,total:1}};
                    const cur=pg.querySelector('.ui-paginator-current');
                    if(!cur) return {{current:1,total:1}};
                    const m=cur.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
                    return m?{{current:parseInt(m[1],10),total:parseInt(m[2],10)}}:{{current:1,total:1}};
                }}""", _paginator_id_js(ti))

            state = get_state()
            total_pages = state["total"]
            logger.info("[%s]   total pages: %d", SOURCE_NAME, total_pages)

            for pn in range(1, total_pages + 1):
                rows = page.evaluate(f"""(tbId)=>{{
                    const tbody=document.getElementById(tbId);
                    if(!tbody) return [];
                    const rows=[];
                    tbody.querySelectorAll('tr[data-ri]').forEach(tr=>{{
                        const tds=tr.querySelectorAll('td');
                        if(tds.length<4) return;
                        const l=tds[0].querySelector('a.ui-commandlink');
                        rows.push({{
                            title:(l?l.textContent:tds[0].textContent).trim(),
                            ministry:tds[1]?tds[1].textContent.trim():null,
                            openRaw:tds[2]?tds[2].textContent.trim():null,
                            closeRaw:tds[3]?tds[3].textContent.trim():null,
                        }});
                    }});
                    return rows;
                }}""", _tbody_id_js(tab_idx))
                logger.info("[%s]   p%d/%d: %d rows", SOURCE_NAME, pn, total_pages, len(rows))

                for r in rows:
                    title = r.get("title", "")
                    if not title or len(title) < 15:
                        continue
                    od = _parse_date_str(r.get("openRaw"))
                    dl = _parse_date_str(r.get("closeRaw"))
                    yield {
                        "source_id": SOURCE_ID, "ref": None, "title": title,
                        "category": _infer_category(title),
                        "ministry": r.get("ministry") or None,
                        "open_date": od, "deadline": dl,
                        "status": infer_status(od, dl),
                        "url": BASE_URL, "scraped_at": now,
                    }
                    total_yielded += 1

                if pn >= total_pages:
                    break
                clicked = page.evaluate(f"""(pgId)=>{{
                    const pg=document.getElementById(pgId);
                    if(!pg) return false;
                    const next=pg.querySelector('.ui-paginator-next');
                    if(!next||next.classList.contains('ui-state-disabled')) return false;
                    next.click(); return true;
                }}""", _paginator_id_js(tab_idx))
                if not clicked:
                    break
                try:
                    page.wait_for_function(f"""({{pgId,from}})=>{{
                        const pg=document.getElementById(pgId);
                        if(!pg) return false;
                        const cur=pg.querySelector('.ui-paginator-current');
                        if(!cur) return false;
                        const m=cur.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
                        return m&&parseInt(m[1],10)!==from;
                    }}""", {"pgId": _paginator_id_js(tab_idx), "from": pn}, timeout=25000)
                except Exception:
                    page.wait_for_timeout(5000)
                page.wait_for_timeout(400)

        logger.info("[%s] playwright done — %d records", SOURCE_NAME, total_yielded)
    finally:
        try: browser.close()
        except Exception: pass


def scrape() -> Iterator[dict]:
    logger.info("[%s] loading %s", SOURCE_NAME, BASE_URL)
    now = now_iso()

    # ── Attempt 1: curl_cffi (Chrome TLS impersonation, no browser, fastest) ──
    try:
        rows = list(_scrape_curl_cffi(now))
        if rows:
            logger.info("[%s] curl_cffi succeeded — %d records", SOURCE_NAME, len(rows))
            yield from rows
            return
        logger.warning("[%s] curl_cffi returned 0 rows — falling back to browser", SOURCE_NAME)
    except Exception as e:
        logger.warning("[%s] curl_cffi failed: %s — falling back to browser", SOURCE_NAME, e)

    # ── Attempt 2: Playwright browser (Chromium then Firefox) ──
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("[%s] playwright not installed", SOURCE_NAME)
        return

    if PROXY_URL:
        import re as _re
        masked = _re.sub(r':([^:@]+)@', ':***@', PROXY_URL)
        logger.info("[%s] using proxy: %s", SOURCE_NAME, masked)

    with sync_playwright() as pw:
        for browser_name in ("chromium", "firefox"):
            got = False
            try:
                for row in _scrape_playwright_browser(pw, browser_name, now):
                    got = True
                    yield row
            except Exception as e:
                logger.warning("[%s] %s failed: %s", SOURCE_NAME, browser_name, e)
            if got:
                return
            logger.warning("[%s] %s yielded 0 — trying next browser", SOURCE_NAME, browser_name)

    logger.error("[%s] All methods failed. Set EPEROLEHAN_PROXY_URL to a residential proxy.", SOURCE_NAME)
