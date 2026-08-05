import asyncio
from playwright.async_api import async_playwright
import os

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        print("Navigating...")
        await page.goto("https://alabamalearningexchange.org/courses/World_Languages", wait_until="networkidle")
        await page.wait_for_timeout(5000)
        
        # Take screenshot
        os.makedirs("scratch", exist_ok=True)
        await page.screenshot(path="scratch/alex.png", full_page=True)
        print("Saved screenshot to scratch/alex.png")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
