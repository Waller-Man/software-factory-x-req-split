"""Loopback-only authenticated HTTP adapter, owned by the DSH plugin."""
from __future__ import annotations
import hmac
import importlib
import os
from zipfile import BadZipFile
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from .tasks import TaskManager, retained_thread
from .archives import build_archive
from .registry import REGISTRY

TOKEN = os.environ.get('X_REQ_SPLIT_TOKEN', '')
INSTANCE = os.environ.get('X_REQ_SPLIT_INSTANCE', '')
TASKS = TaskManager()


@asynccontextmanager
async def lifespan(app):
    if not TOKEN or not INSTANCE:
        raise RuntimeError('必须由 DSH 子进程管理机制启动，缺少实例认证信息')
    for module in ('httpx', 'pymupdf', 'pymupdf4llm', 'docx', 'openpyxl', 'PIL'):
        importlib.import_module(module)
    if os.environ.get('XAGENTS_OCR_ENABLED', 'true').lower() == 'true':
        importlib.import_module('rapidocr_onnxruntime')
    try:
        yield
    finally:
        await TASKS.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def authenticate(request: Request, call_next):
    if not TOKEN or not hmac.compare_digest(request.headers.get('authorization', ''), f'Bearer {TOKEN}'):
        return JSONResponse(status_code=401, content={'error': 'Unauthorized backend request'})
    return await call_next(request)


@app.get('/health')
@app.get('/ready')
async def ready():
    return {'ok': 'requirements_split' in REGISTRY, 'instance': INSTANCE}


@app.post('/tasks')
async def submit(data: dict):
    try:
        return await TASKS.submit(data)
    except (KeyError, ValueError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post('/archives')
async def archive(data: dict):
    try:
        return await retained_thread(build_archive, data)
    except (KeyError, ValueError, OSError, BadZipFile) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get('/tasks/{run_id}')
async def snapshot(run_id: str):
    result = TASKS.snapshot(run_id)
    if result is None:
        raise HTTPException(404, 'Unknown task')
    return result


@app.post('/tasks/{run_id}/model/{request_id}')
async def respond(run_id: str, request_id: str, data: dict):
    try:
        if not isinstance(data.get('text'), str):
            raise ValueError('模型响应必须为文本')
        TASKS.respond(run_id, request_id, data['text'])
        return {'ok': True}
    except (KeyError, ValueError) as exc:
        raise HTTPException(409, str(exc)) from exc


@app.post('/tasks/{run_id}/cancel')
async def cancel(run_id: str):
    if run_id not in TASKS.jobs:
        raise HTTPException(404, 'Unknown task')
    return await TASKS.cancel(run_id)
