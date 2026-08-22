import asyncio
import httpx
from backend.routes.admin import _generate_password
from backend.db import create_beta_account

password = _generate_password()
print(f"Creating beta account with password: {password}")

user = create_beta_account("test-beta@example.com", "", password_hash=password, days=7)
print("User created:", user)

async def test():
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8010") as client:
        # We need the real auth hash. Wait, create_beta_account takes password_hash.
        pass

asyncio.run(test())
