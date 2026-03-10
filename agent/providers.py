"""
AI Coding Agent — Provider Abstraction Layer

Supports OpenAI, Anthropic (Claude), and Google Gemini.
Auto-selects based on available API keys in .env.
"""

import os
from abc import ABC, abstractmethod


class BaseProvider(ABC):
    """Base class for LLM providers."""

    @abstractmethod
    async def chat(self, messages: list[dict], system: str = "") -> str:
        pass

    @abstractmethod
    def is_available(self) -> bool:
        pass


class OpenAIProvider(BaseProvider):
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY", "")

    def is_available(self) -> bool:
        return bool(self.api_key)

    async def chat(self, messages: list[dict], system: str = "") -> str:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self.api_key)
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.extend(messages)

        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=msgs,
            max_tokens=4096,
            temperature=0.3,
        )
        return response.choices[0].message.content


class AnthropicProvider(BaseProvider):
    def __init__(self):
        self.api_key = os.getenv("ANTHROPIC_API_KEY", "")

    def is_available(self) -> bool:
        return bool(self.api_key)

    async def chat(self, messages: list[dict], system: str = "") -> str:
        import anthropic

        client = anthropic.AsyncAnthropic(api_key=self.api_key)

        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=system or "You are a helpful coding assistant.",
            messages=messages,
        )
        return response.content[0].text


class GeminiProvider(BaseProvider):
    def __init__(self):
        self.api_key = os.getenv("GEMINI_API_KEY", "")

    def is_available(self) -> bool:
        return bool(self.api_key)

    async def chat(self, messages: list[dict], system: str = "") -> str:
        import google.generativeai as genai

        genai.configure(api_key=self.api_key)
        model = genai.GenerativeModel(
            "gemini-2.0-flash",
            system_instruction=system or "You are a helpful coding assistant.",
        )

        # Convert messages to Gemini format
        history = []
        for msg in messages[:-1]:
            role = "user" if msg["role"] == "user" else "model"
            history.append({"role": role, "parts": [msg["content"]]})

        chat = model.start_chat(history=history)
        last_msg = messages[-1]["content"] if messages else ""

        response = await chat.send_message_async(last_msg)
        return response.text


# Provider registry
PROVIDERS = {
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
    "gemini": GeminiProvider,
}


def get_provider(name: str) -> BaseProvider:
    """Get a provider by name."""
    cls = PROVIDERS.get(name)
    if not cls:
        raise ValueError(f"Unknown provider: {name}")
    provider = cls()
    if not provider.is_available():
        raise ValueError(f"Provider '{name}' is not configured (missing API key)")
    return provider


def get_available_providers() -> list[str]:
    """Return list of providers that have API keys configured."""
    available = []
    for name, cls in PROVIDERS.items():
        provider = cls()
        if provider.is_available():
            available.append(name)
    return available


def get_default_provider() -> str | None:
    """Get the first available provider."""
    available = get_available_providers()
    return available[0] if available else None
