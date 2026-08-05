import asyncio
from playwright.async_api import async_playwright
import json

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        apis = []
        
        page.on("response", lambda response: apis.append(response.url) if "api" in response.url.lower() or "json" in response.url.lower() else None)
        
        await page.goto("https://alabamalearningexchange.org/courses/World_Languages", wait_until="networkidle")
        await page.wait_for_timeout(3000)
        
        for u in apis:
            print("API URL:", u)
            
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
