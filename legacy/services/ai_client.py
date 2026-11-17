"""DeepSeek AI 客户端（OpenAI SDK 兼容）。

封装在独立 service 层：API Key 从环境变量读取，不硬编码；
调用失败抛出 AiUnavailableError，由上层降级提示，避免 500。
"""
from django.conf import settings
from openai import OpenAI


class AiUnavailableError(Exception):
    """AI 服务不可用（未配置 Key / 网络异常 / 超时）。"""


def _client():
    if not settings.DEEPSEEK_API_KEY:
        raise AiUnavailableError("未配置 DEEPSEEK_API_KEY")
    return OpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url=settings.DEEPSEEK_BASE_URL,
    )


def chat(messages, temperature=0.3, max_tokens=1000, timeout=30):
    """调用 DeepSeek 对话补全。

    messages 形如 [{"role": "user", "content": "..."}]，返回助手回复文本。
    """
    try:
        client = _client()
        resp = client.chat.completions.create(
            model=settings.DEEPSEEK_MODEL,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        return resp.choices[0].message.content
    except AiUnavailableError:
        raise
    except Exception as exc:
        raise AiUnavailableError(f"AI 调用失败：{exc}") from exc
