"""
AI Coding Agent — FastAPI Service

Runs on port 8001. The Go backend proxies /agent/* to this service.
Provides AI-powered code assistance with file reading, editing, and command execution.
"""

import os
import json
import httpx
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

from providers import get_provider, get_available_providers, get_default_provider

# Load .env from parent directory (sandbox-runner root)
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(env_path)

app = FastAPI(title="Sandbox AI Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Go backend URL for file operations
GO_BACKEND = os.getenv("GO_BACKEND_URL", "http://127.0.0.1:9000")

SYSTEM_PROMPT = """You are an AI coding assistant embedded in a cloud IDE. You help developers understand, modify, and improve their code.

Your capabilities:
- Read and understand project files
- Suggest code edits and improvements
- Explain code and architecture
- Help debug issues
- Create new files
- Recommend terminal commands

When suggesting code changes, format them clearly with the file path and the new content.
If you suggest creating or modifying files, include the COMPLETE file content in a code block preceded by the file path.

Be concise, practical, and helpful. Prefer showing code over lengthy explanations."""


class ChatRequest(BaseModel):
    message: str
    provider: Optional[str] = None
    container: Optional[str] = None
    current_file: Optional[dict] = None  # {path, content}


class ChatResponse(BaseModel):
    response: str
    provider: str
    file_changes: list = []  # [{path, content}]


class SuggestRequest(BaseModel):
    file_path: str
    file_content: str
    provider: Optional[str] = None
    instruction: Optional[str] = "Improve this code"


async def get_project_context(container: str) -> str:
    """Fetch the file tree from Go backend to give the agent project context."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            res = await client.get(f"{GO_BACKEND}/files", params={"container": container})
            if res.status_code == 200:
                tree = res.json()
                return format_file_tree(tree)
    except Exception:
        pass
    return "(could not load project structure)"


def format_file_tree(nodes, prefix="", depth=0) -> str:
    """Format file tree nodes into a readable string."""
    if depth > 3:
        return prefix + "...\n"
    lines = []
    for node in nodes:
        indent = "  " * depth
        if node.get("isDir"):
            lines.append(f"{indent}📁 {node['name']}/")
            if node.get("children"):
                lines.append(format_file_tree(node["children"], prefix, depth + 1))
        else:
            lines.append(f"{indent}📄 {node['name']}")
    return "\n".join(lines)


def extract_file_changes(response_text: str) -> list[dict]:
    """Extract file changes from the AI response (files written in code blocks)."""
    changes = []
    lines = response_text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # Look for patterns like "File: path/to/file" or "### path/to/file" followed by code block
        if (line.startswith("File:") or line.startswith("###")) and i + 1 < len(lines):
            path = line.replace("File:", "").replace("###", "").strip().strip("`")
            if path and i + 1 < len(lines) and lines[i + 1].strip().startswith("```"):
                # Extract code block content
                i += 2  # Skip the ``` line
                code_lines = []
                while i < len(lines) and not lines[i].strip().startswith("```"):
                    code_lines.append(lines[i])
                    i += 1
                if code_lines:
                    changes.append({"path": path, "content": "\n".join(code_lines)})
        i += 1
    return changes


@app.post("/agent/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """Chat with the AI coding agent."""
    provider_name = req.provider or get_default_provider()
    if not provider_name:
        raise HTTPException(
            status_code=503,
            detail="No AI provider configured. Add API keys to .env file."
        )

    try:
        provider = get_provider(provider_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Build context
    context_parts = []

    if req.container:
        project_tree = await get_project_context(req.container)
        context_parts.append(f"## Project Structure\n{project_tree}")

    if req.current_file:
        context_parts.append(
            f"## Currently Open File: {req.current_file.get('path', 'unknown')}\n"
            f"```\n{req.current_file.get('content', '')}\n```"
        )

    context = "\n\n".join(context_parts)
    user_message = req.message
    if context:
        user_message = f"{context}\n\n## User Request\n{user_message}"

    messages = [{"role": "user", "content": user_message}]

    try:
        response_text = await provider.chat(messages, system=SYSTEM_PROMPT)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI provider error: {str(e)}")

    # Extract any file changes suggested
    file_changes = extract_file_changes(response_text)

    return ChatResponse(
        response=response_text,
        provider=provider_name,
        file_changes=file_changes,
    )


@app.post("/agent/suggest")
async def suggest(req: SuggestRequest):
    """Get code suggestions for a specific file."""
    provider_name = req.provider or get_default_provider()
    if not provider_name:
        raise HTTPException(
            status_code=503,
            detail="No AI provider configured."
        )

    provider = get_provider(provider_name)

    prompt = (
        f"File: {req.file_path}\n"
        f"```\n{req.file_content}\n```\n\n"
        f"Instruction: {req.instruction}\n\n"
        f"Provide the improved COMPLETE file content in a code block."
    )

    messages = [{"role": "user", "content": prompt}]
    response_text = await provider.chat(messages, system=SYSTEM_PROMPT)

    return {
        "response": response_text,
        "provider": provider_name,
        "file_changes": extract_file_changes(response_text),
    }


@app.get("/agent/providers")
async def list_providers():
    """List available AI providers."""
    return {
        "available": get_available_providers(),
        "default": get_default_provider(),
    }


@app.get("/agent/health")
async def health():
    return {"status": "ok", "providers": get_available_providers()}


if __name__ == "__main__":
    import uvicorn
    print("🤖 AI Agent starting on http://localhost:8001")
    print(f"   Available providers: {get_available_providers() or ['none — add API keys to .env']}")
    uvicorn.run(app, host="0.0.0.0", port=8001)
