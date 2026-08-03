# backend/server.py
from fastapi import FastAPI, BackgroundTasks, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import sys
import os
import uuid
import json
import subprocess
import shutil
from pathlib import Path
from openai import OpenAI

# Add the project root to sys.path to import our existing scripts
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.append(str(PROJECT_ROOT / "scripts"))

from dotenv import load_dotenv
load_dotenv(PROJECT_ROOT / ".env")

try:
    generate_module = __import__("04_generate")
except ImportError:
    raise RuntimeError("Could not import 04_generate.py")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # For local development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GenerateRequest(BaseModel):
    query: str

class RewriteDayRequest(BaseModel):
    day_json: str
    feedback: str
    full_plan_context: str

def cleanup_files(file_paths: list[Path]):
    for p in file_paths:
        try:
            if p.exists():
                p.unlink()
        except Exception as e:
            print(f"Failed to delete {p}: {e}")

@app.post("/api/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or api_key == "your-api-key-here":
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not set.")
    
    client = OpenAI(api_key=api_key)
    
    # Save the uploaded file temporarily
    temp_audio_path = PROJECT_ROOT / f"temp_{uuid.uuid4().hex}_{audio.filename}"
    try:
        with open(temp_audio_path, "wb") as f:
            f.write(await audio.read())
            
        with open(temp_audio_path, "rb") as f:
            transcription = client.audio.transcriptions.create(
                model="whisper-1",
                file=f
            )
            
        return {"text": transcription.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        if temp_audio_path.exists():
            temp_audio_path.unlink()

@app.post("/api/generate")
async def generate_lesson_plan(req: GenerateRequest):
    try:
        # 1. Generate JSON using our existing RAG pipeline
        json_str = generate_module.generate_lesson_plan(req.query, top_k=5)
        
        # Cleanup markdown blocks if any
        if json_str.startswith("```json"):
            json_str = json_str[7:]
        if json_str.startswith("```"):
            json_str = json_str[3:]
        if json_str.endswith("```"):
            json_str = json_str[:-3]
        json_str = json_str.strip()
        
        # Verify it's valid JSON
        lesson_data = json.loads(json_str)
        
        # 2. Write JSON to a temp file
        unique_id = uuid.uuid4().hex
        
        # Ensure temp directory exists
        temp_dir = PROJECT_ROOT / "temp"
        temp_dir.mkdir(exist_ok=True)
        
        temp_json = temp_dir / f"temp_{unique_id}.json"
        temp_docx = temp_dir / f"LessonPlan_{unique_id}.docx"
        
        with open(temp_json, "w") as f:
            f.write(json_str)
            
        # 3. Call the build script
        script_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "scripts" / "build_lesson_plan.py"
        subprocess.run(
            [sys.executable, str(script_path), str(temp_json), str(temp_docx)],
            check=True
        )
        
        if not temp_docx.exists():
            raise HTTPException(status_code=500, detail="Docx file was not created.")
            
        # 4. Return the data and the file ID
        return {
            "file_id": unique_id,
            "preview_data": lesson_data
        }
        
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Docx build script failed: {e}")
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"LLM produced invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

from fastapi.responses import StreamingResponse

@app.post("/api/generate_stream")
async def generate_lesson_plan_stream_endpoint(req: GenerateRequest):
    def event_stream():
        json_chunks = []
        try:
            for chunk in generate_module.generate_lesson_plan_stream(req.query, top_k=5):
                json_chunks.append(chunk)
                yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            
            full_json = "".join(json_chunks)
            if full_json.startswith("```json"):
                full_json = full_json[7:]
            if full_json.startswith("```"):
                full_json = full_json[3:]
            if full_json.endswith("```"):
                full_json = full_json[:-3]
            full_json = full_json.strip()
            
            lesson_data = json.loads(full_json)
            unique_id = uuid.uuid4().hex
            temp_dir = PROJECT_ROOT / "temp"
            temp_dir.mkdir(exist_ok=True)
            temp_json = temp_dir / f"temp_{unique_id}.json"
            temp_docx = temp_dir / f"LessonPlan_{unique_id}.docx"
            
            with open(temp_json, "w") as f:
                f.write(full_json)
                
            script_path = PROJECT_ROOT / ".agents" / "skills" / "lesson-plan-week" / "scripts" / "build_lesson_plan.py"
            subprocess.run(
                [sys.executable, str(script_path), str(temp_json), str(temp_docx)],
                check=True
            )
            
            yield f"data: {json.dumps({'done': True, 'file_id': unique_id})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
            
    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.post("/api/rewrite_day")
async def rewrite_day_endpoint(req: RewriteDayRequest):
    try:
        json_str = generate_module.rewrite_lesson_day(req.day_json, req.feedback, req.full_plan_context)
        
        # Clean up any potential markdown code blocks
        if json_str.startswith("```json"):
            json_str = json_str[7:]
        if json_str.startswith("```"):
            json_str = json_str[3:]
        if json_str.endswith("```"):
            json_str = json_str[:-3]
        json_str = json_str.strip()
        
        updated_day = json.loads(json_str)
        return updated_day
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"LLM produced invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/download/{file_id}")
async def download_lesson_plan(file_id: str):
    temp_docx = PROJECT_ROOT / "temp" / f"LessonPlan_{file_id}.docx"
    if not temp_docx.exists():
        raise HTTPException(status_code=404, detail="File not found or expired.")
        
    return FileResponse(
        path=str(temp_docx),
        filename="Lesson_Plan.docx",
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

@app.post("/api/extract_text")
async def extract_text(file: UploadFile = File(...)):
    temp_dir = PROJECT_ROOT / "temp"
    temp_dir.mkdir(exist_ok=True)
    
    unique_id = uuid.uuid4().hex
    temp_path = temp_dir / f"upload_{unique_id}_{file.filename}"
    
    try:
        with open(temp_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        ext = temp_path.suffix.lower()
        extracted_text = ""
        
        if ext == ".pdf":
            try:
                out = subprocess.run(["pdftotext", "-layout", str(temp_path), "-"], capture_output=True, check=True, text=True)
                extracted_text = out.stdout
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Failed to extract text from PDF. Is poppler installed? {e}")
        elif ext in [".txt", ".md", ".csv"]:
            with open(temp_path, "r", encoding="utf-8", errors="ignore") as f:
                extracted_text = f.read()
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")
            
        return {"filename": file.filename, "text": extracted_text}
    finally:
        if temp_path.exists():
            temp_path.unlink()
