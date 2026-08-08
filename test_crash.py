import asyncio
import os
import sys

# add backend to path
sys.path.append(os.path.abspath('backend'))

from routes.generate import generate_stream
from pydantic import BaseModel
class req:
    query = "let's try it"
    chat_id = "test"

# wait, generate_stream is a normal function returning a StreamingResponse.
# StreamingResponse body is an async generator or a sync generator
response = generate_stream(req(), None, "default_user")

# run the generator
gen = response.body_iterator
for item in gen:
    print("YIELDED:", repr(item))
