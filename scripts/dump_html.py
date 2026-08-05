import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto("https://alabamalearningexchange.org/courses/World_Languages", wait_until="networkidle")
        await page.wait_for_timeout(5000)
        
        html = await page.content()
        with open("scratch/alex.html", "w") as f:
            f.write(html)
            
        print("Saved HTML.")
        await browser.close()

if __name__ == "__main__":
    asyncio.run(main())
