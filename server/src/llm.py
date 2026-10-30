"""Keep the original JSON parser; delegate model requests to the DSH host."""

from __future__ import annotations

import json
import logging
import re
from .tasks import model_request

logger = logging.getLogger("xagents.llm")


async def aclose() -> None:
    """No provider client lives in Python."""


async def complete_json(system: str, user: str) -> object:
    """调用模型并解析出JSON对象 失败（网络/鉴权/格式）时抛异常"""
    content = await model_request(system, user)
    return _extract_json(content)


def _extract_json(text: str) -> object:
    """容忍代码围栏和前后废话地解析第一个JSON对象"""
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass

    start = text.find("{")
    while start != -1:
        depth = 0
        for end in range(start, len(text)):
            char = text[end]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : end + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)

    raise RuntimeError("model did not return JSON")
