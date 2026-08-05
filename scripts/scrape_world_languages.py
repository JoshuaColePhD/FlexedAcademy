import asyncio
from playwright.async_api import async_playwright
import re
import urllib.request
import os

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        print("Navigating to World Languages...")
        await page.goto("https://alabamalearningexchange.org/courses/World_Languages", wait_until="networkidle")
        
        # Give it a bit more time to render Javascript
        await page.wait_for_timeout(3000)
        
        print("Finding links...")
        # Get all links
        links = await page.evaluate(r"""
            Array.from(document.querySelectorAll('a')).map(a => a.href).filter(href => href.toLowerCase().endsWith('.pdf') || href.includes('pdf'))
        """)
        
        links = list(set(links)) # deduplicate
        
        print(f"Found {len(links)} PDF links.")
        
        if len(links) == 0:
            # Maybe the page structure is different. Let's print the whole body text to debug
            body = await page.evaluate("document.body.innerText")
            print("Body text preview:")
            print(body[:500])
        
        os.makedirs("data/raw/universal", exist_ok=True)
        
        for url in links:
            if not url: continue
            filename = url.split("/")[-1].split("?")[0]
            if not filename.endswith(".pdf"):
                filename += ".pdf"
            print(f"Downloading {filename}...")
            urllib.request.urlretrieve(url, f"data/raw/universal/{filename}")
            
        await browser.close()
        print("Done.")

if __name__ == "__main__":
    asyncio.run(main())
