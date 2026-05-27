"""
Fetch a BizScout listing using Playwright with stealth-ish headers.
BizScout's dealOS uses Vercel Security Checkpoint — needs real browser + JS execution.

Usage:
    .venv/bin/python scrapers/fetch_bizscout.py <URL>

Output: prints JSON with extracted listing data to stdout.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from typing import Any

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Safari/605.1.15"
)


async def login_if_needed(page, email: str, password: str) -> bool:
    """If page shows login form, fill it and submit. Returns True if login was attempted."""
    title = await page.title()
    if "Vercel Security Checkpoint" in title:
        return False
    # Detect login form
    login_email = await page.query_selector("input[type='email'], input[name='email']")
    login_pw = await page.query_selector("input[type='password'], input[name='password']")
    if not (login_email and login_pw):
        return False
    await login_email.fill(email)
    await login_pw.fill(password)
    # Find submit button
    btn = await page.query_selector("button[type='submit'], button:has-text('Log in'), button:has-text('Sign in')")
    if btn:
        await btn.click()
        await page.wait_for_load_state("networkidle", timeout=20_000)
        return True
    return False


async def fetch(url: str, email: str = "", password: str = "", cookie: str = "") -> dict[str, Any]:
    import os
    email = email or os.environ.get("BIZSCOUT_EMAIL", "")
    password = password or os.environ.get("BIZSCOUT_PASSWORD", "")
    cookie = cookie or os.environ.get("BIZSCOUT_COOKIE", "")

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        ctx = await browser.new_context(
            user_agent=UA,
            viewport={"width": 1440, "height": 900},
            locale="en-US",
            timezone_id="America/Chicago",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        # Apply session cookie if provided (faster than full login)
        if cookie:
            await ctx.add_cookies([{
                "name": "session", "value": cookie,
                "domain": ".bizscout.com", "path": "/", "secure": True, "httpOnly": True,
            }])

        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            await page.wait_for_timeout(8_000)  # Vercel checkpoint
            try:
                await page.wait_for_load_state("networkidle", timeout=15_000)
            except Exception:
                pass

            # Try login if we landed on login screen
            if email and password:
                logged_in = await login_if_needed(page, email, password)
                if logged_in:
                    # Navigate back to original URL after login
                    await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                    await page.wait_for_timeout(5_000)
                    try:
                        await page.wait_for_load_state("networkidle", timeout=15_000)
                    except Exception:
                        pass
        except Exception as e:
            await browser.close()
            return {"_error": f"Navigation failed: {e}"}

        html = await page.content()
        title = await page.title()
        await browser.close()

    soup = BeautifulSoup(html, "lxml")

    # If still on checkpoint
    if "Vercel Security Checkpoint" in title:
        return {"_error": "Still on Vercel Security Checkpoint after 8s wait", "title": title, "html_len": len(html)}

    # Strip script/style for text extraction
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)

    # Heuristic extraction
    out: dict[str, Any] = {"title": title, "url_fetched": True, "html_len": len(html)}

    # Try common patterns
    patterns = {
        "asking_price": [
            r"asking\s*price[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[MK])?)",
            r"price[:\s]+\$([\d,]+(?:\.\d+)?(?:\s*[MK])?)",
            r"\$([\d,]+)\s*asking",
        ],
        "revenue": [
            r"(?:annual\s+)?revenue[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[MK])?)",
            r"gross\s*revenue[:\s]+\$?([\d,]+)",
            r"gross\s*sales[:\s]+\$?([\d,]+)",
        ],
        "sde": [
            r"(?:SDE|seller'?s?\s*discretionary\s*earnings)[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[MK])?)",
            r"cash\s*flow[:\s]+\$?([\d,]+)",
            r"owner'?s?\s*(?:cash\s*flow|benefit)[:\s]+\$?([\d,]+)",
        ],
        "ebitda": [r"EBITDA[:\s]+\$?([\d,]+(?:\.\d+)?(?:\s*[MK])?)"],
        "established": [r"established[:\s]+(\d{4})", r"in\s+business\s+since\s+(\d{4})"],
        "employees": [r"(\d+)\s*employees", r"(\d+)\s*staff"],
        "location": [r"location[:\s]+([A-Za-z\s,]+\d{5}?)"],
    }
    for field, regs in patterns.items():
        for r in regs:
            m = re.search(r, text, re.IGNORECASE)
            if m:
                out[field] = m.group(1).strip()
                break

    # Look for state code (TX, FL, etc.)
    state_match = re.search(r"\b(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b", text)
    if state_match:
        out["state"] = state_match.group(1)

    # Description heuristic — grab first 2-3 paragraphs that aren't menu
    paragraphs = [p.get_text(strip=True) for p in soup.find_all("p") if len(p.get_text(strip=True)) > 80]
    out["description_paragraphs"] = paragraphs[:3]

    # First H1/H2 — usually the business title
    h1 = soup.find("h1")
    if h1:
        out["business_title"] = h1.get_text(strip=True)

    # Full text dump (truncated) for manual inspection if heuristics fail
    out["text_dump"] = text[:4000]

    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"_error": "usage: fetch_bizscout.py <URL>"}))
        sys.exit(1)
    url = sys.argv[1]
    result = asyncio.run(fetch(url))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
