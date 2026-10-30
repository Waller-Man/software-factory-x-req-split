"""Private Python jobs; software factory Run owns durable task state and models."""
from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re
import threading
import uuid
from pathlib import Path
from typing import Any

CURRENT: contextvars.ContextVar[dict | None] = contextvars.ContextVar('req_split_job', default=None)


async def model_request(system: str, user: str) -> str:
    job = CURRENT.get()
    if job is None:
        raise RuntimeError('模型请求缺少 DSH 任务上下文')
    request_id = uuid.uuid4().hex
    future = asyncio.get_running_loop().create_future()
    request = {'id': request_id, 'messages': [
        {'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
    job['pending'][request_id] = (request, future)
    try:
        return await asyncio.wait_for(future, 3600)
    finally:
        job['pending'].pop(request_id, None)


async def retained_thread(function, *args, **kwargs):
    """Do not report cancellation while a conversion/script thread still writes."""
    task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


class JobFilter(logging.Filter):
    def __init__(self, job):
        super().__init__()
        self.job = job

    def filter(self, record):
        return CURRENT.get() is self.job


class JobLogHandler(logging.FileHandler):
    def __init__(self, job):
        super().__init__(job['directory'] / 'logs' / 'python.log', encoding='utf-8')
        self.job = job
        self.addFilter(JobFilter(job))
        self.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s %(message)s'))

    def emit(self, record):
        super().emit(record)
        # Full text remains in python.log; individual SDK log messages are bounded.
        self.job['events'].append({'type': 'log', 'stage': self.job['stage'],
                                   'level': record.levelname, 'message': record.getMessage()[:16000]})


def validate_run_directory(run_id: str, raw: str) -> Path:
    directory = Path(raw)
    if (not isinstance(run_id, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f-]{27}', run_id)
            or not directory.is_absolute() or directory.name != run_id
            or directory.parent.name != 'runs' or directory.parent.parent.name != 'outputs'):
        raise ValueError('仅允许 Run 提供的 outputs/runs/<runId> 目录')
    for part in (directory.parents[2], directory.parents[1], directory.parent, directory,
                 *(directory / name for name in ('input', 'intermediate', 'snapshots', 'final', 'logs'))):
        if part.is_symlink() or part.resolve() != part or not part.is_dir():
            raise ValueError('任务路径包含链接或无效目录')
    request = json.loads((directory / 'input' / 'request.json').read_text(encoding='utf-8'))
    if request.get('toolId') != 'split_requirement_document':
        raise ValueError('Run 入口不匹配')
    return directory


class TaskManager:
    def __init__(self, *, max_concurrency=2, max_jobs=100):
        self.semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self.jobs: dict[str, dict[str, Any]] = {}
        self.max_jobs = max_jobs

    async def submit(self, data: dict):
        run_id = data['runId']
        if run_id in self.jobs:
            raise ValueError('runId 已存在，不能覆盖')
        directory = validate_run_directory(run_id, data['runDirectory'])
        root = directory.parents[2]
        payload = data['input']
        if set(payload) - {'path', 'text', 'title', 'mode'}:
            raise ValueError('不允许 outputDir 或未知输入参数')
        if payload.get('mode', 'split') not in ('split', 'convert'):
            raise ValueError('mode 必须为 split 或 convert')
        if payload.get('path'):
            source = Path(payload['path'])
            if not source.is_absolute() or not source.resolve().is_relative_to(root.resolve()):
                raise ValueError('源文件不在当前工作区')
        job = {'taskId': run_id, 'status': 'queued', 'progress': 0, 'stage': 'queued',
               'result': None, 'diagnostic': None, 'pending': {}, 'directory': directory,
               'cancel_requested': threading.Event(), 'events': []}
        # Run owns persisted state; evict only completed worker memory entries.
        for key in list(self.jobs):
            if len(self.jobs) < self.max_jobs:
                break
            if self.jobs[key]['task'].done():
                self.jobs.pop(key)
        self.jobs[run_id] = job
        job['task'] = asyncio.create_task(self._run(job, dict(payload)))
        return self.snapshot(run_id)

    def snapshot(self, run_id):
        job = self.jobs.get(run_id)
        if job is None:
            return None
        return {**{key: job[key] for key in ['taskId', 'status', 'progress', 'stage', 'result', 'diagnostic']},
                'requests': [request for request, _ in job['pending'].values()], 'events': list(job['events'])}

    def respond(self, run_id, request_id, text):
        _, future = self.jobs[run_id]['pending'][request_id]
        if future.done():
            raise ValueError('模型请求已完成或取消')
        future.set_result(text)

    async def cancel(self, run_id):
        job = self.jobs[run_id]
        if not job['task'].done():
            job['cancel_requested'].set()
            job['task'].cancel()
            await asyncio.gather(job['task'], return_exceptions=True)
            if job['status'] == 'queued':
                job.update(status='cancelled', stage='cancelled')
        return self.snapshot(run_id)

    async def close(self):
        await asyncio.gather(*(self.cancel(key) for key in self.jobs))

    async def _run(self, job, payload):
        from .registry import run_agent
        directory = job['directory']
        token = CURRENT.set(job)
        handler = JobLogHandler(job)
        logging.getLogger('xagents').addHandler(handler)
        try:
            async with self.semaphore:
                job.update(status='running', stage='converting')
                payload['_run_directory'] = str(directory)
                payload['_progress'] = lambda progress, stage, message='': self._progress(job, progress, stage, message)
                result = await run_agent('requirements_split', payload)
                if result.get('splitStatus') == 'failed':
                    raise RuntimeError(result.get('splitError'))
                job.update(status='completed', progress=100, stage='completed', result=result)
        except asyncio.CancelledError:
            job.update(status='cancelled', stage='cancelled', diagnostic='DSH 取消任务')
            raise
        except Exception as exc:
            logging.getLogger('xagents.tasks').exception('任务失败')
            job.update(status='failed', stage='failed', diagnostic=f'{type(exc).__name__}: {exc}')
        finally:
            for _, future in job['pending'].values():
                if not future.done():
                    future.cancel()
            job['pending'].clear()
            (directory / 'intermediate' / 'backend-outcome.json').write_text(
                json.dumps(self.snapshot(job['taskId']), ensure_ascii=False, indent=2), encoding='utf-8')
            logging.getLogger('xagents').removeHandler(handler)
            handler.close()
            CURRENT.reset(token)

    def _progress(self, job, progress, stage, message):
        job.update(progress=progress, stage=stage)
        job['events'].append({'type': 'progress', 'stage': stage, 'message': message, 'progress': progress})
        logging.getLogger('xagents.tasks').info('%s%% %s %s', progress, stage, message)
        folder = job['directory'] / 'snapshots'
        folder.mkdir(exist_ok=True)
        (folder / f'{uuid.uuid4().hex}.json').write_text(json.dumps({
            'progress': progress, 'stage': stage, 'message': message,
        }, ensure_ascii=False), encoding='utf-8')
