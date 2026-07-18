from __future__ import annotations

import argparse
import base64
import json
import math
import mimetypes
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

import requests


SUPPORTED_PROVIDERS = {
    "openai_responses",
    "openai_chat",
    "google",
    "anthropic",
}
SUPPORTED_IMAGE_URL_MODES = {"data_url", "raw_base64"}


class APIClientError(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelPricing:
    input_per_million: Optional[float] = None
    output_per_million: Optional[float] = None

    @classmethod
    def from_dict(cls, data: Any) -> "ModelPricing":
        if data is None:
            return cls()
        if not isinstance(data, dict):
            raise ValueError("pricing must be an object")

        allowed = set(cls.__dataclass_fields__)
        unknown = sorted(set(data) - allowed)
        if unknown:
            raise ValueError(f"Unknown pricing fields: {', '.join(unknown)}")

        values: Dict[str, Optional[float]] = {}
        for key in allowed:
            value = data.get(key)
            if value is None:
                values[key] = None
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"pricing.{key} must be a non-negative number or null")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"pricing.{key} must be non-negative")
            values[key] = float(value)
        return cls(**values)

    def to_jsonable(self) -> Dict[str, Optional[float]]:
        return asdict(self)


@dataclass(frozen=True)
class ModelConfig:
    name: str
    provider: str
    model_id: str
    api_key_env: str
    max_output_tokens: int = 4096
    rate_limit_rpm: int = 10
    timeout_seconds: float = 1800.0
    base_url: Optional[str] = None
    reasoning_effort: Optional[str] = None
    reasoning_mode: Optional[str] = None
    thinking_level: Optional[str] = None
    thinking_budget: Optional[int] = None
    thinking_enabled: bool = False
    thinking_budget_tokens: Optional[int] = None
    extra_body: Optional[Dict[str, Any]] = None
    image_url_mode: str = "data_url"
    pricing: ModelPricing = field(default_factory=ModelPricing)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ModelConfig":
        if not isinstance(data, dict):
            raise ValueError("Model config must be an object")
        allowed = set(cls.__dataclass_fields__)
        unknown = sorted(set(data) - allowed)
        if unknown:
            raise ValueError(f"Unknown model config fields: {', '.join(unknown)}")
        values = dict(data)
        values["pricing"] = ModelPricing.from_dict(data.get("pricing"))
        try:
            config = cls(**values)
        except TypeError as error:
            raise ValueError(f"Invalid model config: {error}") from error
        config.validate()
        return config

    def validate(self) -> None:
        required_strings = {
            "name": self.name,
            "provider": self.provider,
            "model_id": self.model_id,
            "api_key_env": self.api_key_env,
            "image_url_mode": self.image_url_mode,
        }
        for field_name, value in required_strings.items():
            if not isinstance(value, str):
                raise ValueError(f"{field_name} must be a string")

        optional_strings = {
            "base_url": self.base_url,
            "reasoning_effort": self.reasoning_effort,
            "reasoning_mode": self.reasoning_mode,
            "thinking_level": self.thinking_level,
        }
        for field_name, value in optional_strings.items():
            if value is not None and not isinstance(value, str):
                raise ValueError(f"{field_name} must be a string or null")

        positive_ints = {
            "max_output_tokens": self.max_output_tokens,
            "rate_limit_rpm": self.rate_limit_rpm,
        }
        optional_positive_ints = {
            "thinking_budget": self.thinking_budget,
            "thinking_budget_tokens": self.thinking_budget_tokens,
        }
        for field_name, value in positive_ints.items():
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")
        for field_name, value in optional_positive_ints.items():
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 1
            ):
                raise ValueError(f"{field_name} must be a positive integer or null")

        if (
            isinstance(self.timeout_seconds, bool)
            or not isinstance(self.timeout_seconds, (int, float))
            or not math.isfinite(self.timeout_seconds)
            or self.timeout_seconds <= 0
        ):
            raise ValueError("timeout_seconds must be a finite positive number")
        if not isinstance(self.thinking_enabled, bool):
            raise ValueError("thinking_enabled must be a boolean")
        if self.extra_body is not None and not isinstance(self.extra_body, dict):
            raise ValueError("extra_body must be an object or null")

        if not self.name.strip():
            raise ValueError("Model name must not be empty")
        if self.provider not in SUPPORTED_PROVIDERS:
            raise ValueError(f"Unsupported provider: {self.provider}")
        if not self.model_id.strip():
            raise ValueError(f"model_id must not be empty for {self.name}")
        if not self.api_key_env.strip():
            raise ValueError(f"api_key_env must not be empty for {self.name}")
        if self.provider != "openai_chat" and self.base_url:
            raise ValueError(f"base_url is only supported by openai_chat: {self.name}")
        if self.image_url_mode not in SUPPORTED_IMAGE_URL_MODES:
            raise ValueError(
                f"Unsupported image_url_mode for {self.name}: {self.image_url_mode}"
            )
        if self.provider != "openai_chat" and self.image_url_mode != "data_url":
            raise ValueError(
                f"image_url_mode is only supported by openai_chat: {self.name}"
            )
        if self.thinking_level and self.thinking_budget is not None:
            raise ValueError(
                f"thinking_level and thinking_budget cannot both be set: {self.name}"
            )

    def public_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data.pop("pricing")
        return data

    def pricing_dict(self) -> Dict[str, Optional[float]]:
        return self.pricing.to_jsonable()


@dataclass
class APIResult:
    success: bool
    raw_response: str
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    reasoning_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    stop_reason: Optional[str] = None
    response_id: Optional[str] = None
    model_version: Optional[str] = None
    error_message: Optional[str] = None
    provider_metadata: Optional[Dict[str, Any]] = None

    def to_jsonable(self) -> Dict[str, Any]:
        return asdict(self)


PostFunction = Callable[..., Any]


def merge_stream_text(current_text: str, incoming_chunk: str) -> str:
    return current_text + incoming_chunk


def encode_image(image_path: str | Path) -> Tuple[str, str]:
    path = Path(image_path)
    if not path.is_file():
        raise APIClientError(f"Image file not found: {path}")

    mime_type = mimetypes.guess_type(path.name)[0]
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
    if not mime_type or not mime_type.startswith("image/"):
        raise APIClientError(f"Unsupported image type: {path.suffix or path.name}")

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return mime_type, encoded


def image_data_url(mime_type: str, encoded_image: str) -> str:
    return f"data:{mime_type};base64,{encoded_image}"


def normalize_usage(
    input_tokens: Any,
    visible_output_tokens: Any,
    total_tokens: Any,
    reasoning_tokens: Any = None,
) -> Tuple[Optional[int], Optional[int], Optional[int]]:
    input_value = _coerce_nonnegative_int(input_tokens)
    visible_output = _coerce_nonnegative_int(visible_output_tokens)
    total_value = _coerce_nonnegative_int(total_tokens)
    reasoning_value = _coerce_nonnegative_int(reasoning_tokens) or 0

    output_value: Optional[int]
    if input_value is not None and total_value is not None:
        derived = total_value - input_value
        output_value = derived if derived >= 0 else visible_output
    elif visible_output is not None:
        output_value = visible_output + reasoning_value
    elif reasoning_value:
        output_value = reasoning_value
    else:
        output_value = None

    if total_value is None and input_value is not None and output_value is not None:
        total_value = input_value + output_value
    return input_value, output_value, total_value


def reasoning_label(config: ModelConfig) -> str:
    parts: List[str] = []
    if config.reasoning_mode:
        parts.append(f"mode-{config.reasoning_mode}")
    if config.reasoning_effort:
        parts.append(f"effort-{config.reasoning_effort}")
    if config.thinking_level:
        parts.append(f"level-{config.thinking_level}")
    if config.thinking_budget is not None:
        parts.append(f"budget-{config.thinking_budget}")
    if config.thinking_enabled:
        if config.thinking_budget_tokens is not None:
            parts.append(f"thinking-{config.thinking_budget_tokens}")
        else:
            parts.append("thinking-adaptive")
    extra_reasoning = (
        config.extra_body.get("reasoning")
        if isinstance(config.extra_body, dict)
        else None
    )
    if isinstance(extra_reasoning, dict):
        if isinstance(extra_reasoning.get("enabled"), bool):
            parts.append(
                "thinking" if extra_reasoning["enabled"] else "non-thinking"
            )
        elif (
            not config.reasoning_effort
            and isinstance(extra_reasoning.get("effort"), str)
        ):
            parts.append(f"effort-{extra_reasoning['effort']}")
    return "_".join(parts).lower() or "default"


def _coerce_nonnegative_int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _json_from_sse_line(raw_line: bytes | str) -> Optional[Dict[str, Any]]:
    try:
        line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
    except UnicodeDecodeError as error:
        raise APIClientError("SSE data is not valid UTF-8") from error
    line = line.strip()
    if not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as error:
        raise APIClientError("SSE data payload is not valid JSON") from error
    if not isinstance(data, dict):
        raise APIClientError("SSE data payload must be a JSON object")
    return data


def _error_text(response: Any) -> str:
    text = getattr(response, "text", "") or ""
    if len(text) > 2000:
        text = text[:2000] + "..."
    return text.strip()


def _raise_for_status(response: Any) -> None:
    status = int(getattr(response, "status_code", 0) or 0)
    if 200 <= status < 300:
        return
    body = _error_text(response)
    detail = f": {body}" if body else ""
    raise APIClientError(f"HTTP {status}{detail}")


def _join_url(base_url: str, suffix: str) -> str:
    return f"{base_url.rstrip('/')}/{suffix.lstrip('/')}"


class BaseAPIClient:
    def __init__(
        self,
        config: ModelConfig,
        api_key: str,
        post: Optional[PostFunction] = None,
    ) -> None:
        self.config = config
        self.api_key = api_key
        self._post = post or requests.post
        self._rate_lock = threading.Lock()
        self._last_request_time = 0.0

    def _rate_limit(self) -> None:
        with self._rate_lock:
            minimum_interval = 60.0 / self.config.rate_limit_rpm
            remaining = minimum_interval - (time.monotonic() - self._last_request_time)
            if remaining > 0:
                time.sleep(remaining)
            self._last_request_time = time.monotonic()

    def send(self, prompt: str, image_path: str | Path) -> APIResult:
        raise NotImplementedError


class OpenAIResponsesClient(BaseAPIClient):
    def send(self, prompt: str, image_path: str | Path) -> APIResult:
        self._rate_limit()
        mime_type, encoded = encode_image(image_path)
        body: Dict[str, Any] = {
            "model": self.config.model_id,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_image",
                            "image_url": image_data_url(mime_type, encoded),
                        },
                        {"type": "input_text", "text": prompt},
                    ],
                }
            ],
            "max_output_tokens": self.config.max_output_tokens,
            "stream": True,
        }
        reasoning: Dict[str, Any] = {}
        if self.config.reasoning_effort:
            reasoning["effort"] = self.config.reasoning_effort
        if self.config.reasoning_mode:
            reasoning["mode"] = self.config.reasoning_mode
        if reasoning:
            body["reasoning"] = reasoning

        response = self._post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            stream=True,
            timeout=(10, self.config.timeout_seconds),
        )
        _raise_for_status(response)

        text = ""
        final_response: Dict[str, Any] = {}
        terminal_status = None
        for raw_line in response.iter_lines():
            event = _json_from_sse_line(raw_line)
            if not event:
                continue
            event_type = event.get("type")
            if event_type in {"response.output_text.delta", "response.refusal.delta"}:
                text = merge_stream_text(text, str(event.get("delta") or ""))
            response_data = event.get("response")
            if isinstance(response_data, dict):
                final_response = response_data
            if event_type == "response.completed":
                terminal_status = "completed"
                break
            if event_type == "response.incomplete":
                terminal_status = "incomplete"
                break
            if event_type in {"response.failed", "response.cancelled"}:
                status = str(event_type).removeprefix("response.")
                error = (response_data or {}).get("error") or event.get("error")
                detail = (
                    error.get("message")
                    if isinstance(error, dict)
                    else str(error or status)
                )
                raise APIClientError(f"OpenAI response {status}: {detail}")
            if event_type in {"error", "response.error"}:
                error = event.get("error")
                detail = (
                    error.get("message")
                    if isinstance(error, dict)
                    else event.get("message") or str(error or "unknown error")
                )
                raise APIClientError(f"OpenAI response error: {detail}")

        if terminal_status is None:
            status = final_response.get("status")
            if status in {"completed", "incomplete"}:
                terminal_status = status
            else:
                raise APIClientError(
                    "OpenAI response stream ended before a terminal event"
                )

        if not text:
            text = _extract_openai_response_text(final_response)
        usage = final_response.get("usage") or {}
        reasoning_tokens = (usage.get("output_tokens_details") or {}).get(
            "reasoning_tokens"
        )
        input_tokens, output_tokens, total_tokens = normalize_usage(
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            usage.get("total_tokens"),
            reasoning_tokens,
        )
        incomplete = final_response.get("incomplete_details")
        stop_reason = final_response.get("status")
        if isinstance(incomplete, dict) and incomplete.get("reason"):
            stop_reason = str(incomplete["reason"])

        return APIResult(
            success=True,
            raw_response=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=_coerce_nonnegative_int(reasoning_tokens),
            total_tokens=total_tokens,
            stop_reason=stop_reason,
            response_id=final_response.get("id"),
            provider_metadata={"incomplete_details": incomplete} if incomplete else None,
        )


def _extract_openai_response_text(response: Dict[str, Any]) -> str:
    parts: List[str] = []
    for item in response.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if not isinstance(content, dict):
                continue
            if content.get("type") in {"output_text", "refusal"}:
                value = content.get("text") or content.get("refusal")
                if value:
                    parts.append(str(value))
    return "".join(parts)


class OpenAIChatClient(BaseAPIClient):
    def send(self, prompt: str, image_path: str | Path) -> APIResult:
        self._rate_limit()
        mime_type, encoded = encode_image(image_path)
        image_url = (
            encoded
            if self.config.image_url_mode == "raw_base64"
            else image_data_url(mime_type, encoded)
        )
        body: Dict[str, Any] = {
            "model": self.config.model_id,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": image_url},
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        token_limit_field = "max_tokens" if self.config.base_url else "max_completion_tokens"
        body[token_limit_field] = self.config.max_output_tokens
        if self.config.reasoning_effort:
            body["reasoning_effort"] = self.config.reasoning_effort
        if self.config.extra_body:
            body.update(self.config.extra_body)

        base_url = self.config.base_url or "https://api.openai.com/v1"
        response = self._post(
            _join_url(base_url, "chat/completions"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            stream=True,
            timeout=(10, self.config.timeout_seconds),
        )
        _raise_for_status(response)

        text = ""
        usage: Dict[str, Any] = {}
        stop_reason = None
        response_id = None
        for raw_line in response.iter_lines():
            chunk = _json_from_sse_line(raw_line)
            if not chunk:
                continue
            if "error" in chunk:
                error = chunk.get("error")
                detail = (
                    error.get("message")
                    if isinstance(error, dict)
                    else str(error or "unknown error")
                )
                raise APIClientError(f"OpenAI chat stream error: {detail}")
            response_id = response_id or chunk.get("id")
            if isinstance(chunk.get("usage"), dict):
                usage = chunk["usage"]
            for choice in chunk.get("choices") or []:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str):
                    text = merge_stream_text(text, content)
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("text"):
                            text = merge_stream_text(text, str(part["text"]))
                if choice.get("finish_reason"):
                    stop_reason = str(choice["finish_reason"])

        if stop_reason is None:
            raise APIClientError(
                "OpenAI chat stream ended before a terminal finish_reason"
            )
        if stop_reason == "error":
            raise APIClientError("OpenAI chat stream ended with a provider error")

        details = usage.get("completion_tokens_details") or {}
        reasoning_tokens = details.get("reasoning_tokens")
        input_tokens, output_tokens, total_tokens = normalize_usage(
            usage.get("prompt_tokens") or usage.get("input_tokens"),
            usage.get("completion_tokens") or usage.get("output_tokens"),
            usage.get("total_tokens"),
            reasoning_tokens,
        )
        return APIResult(
            success=True,
            raw_response=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=_coerce_nonnegative_int(reasoning_tokens),
            total_tokens=total_tokens,
            stop_reason=stop_reason,
            response_id=response_id,
        )


class GoogleClient(BaseAPIClient):
    def send(self, prompt: str, image_path: str | Path) -> APIResult:
        self._rate_limit()
        mime_type, encoded = encode_image(image_path)
        body: Dict[str, Any] = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": mime_type,
                                "data": encoded,
                            }
                        },
                        {"text": prompt},
                    ],
                }
            ],
            "service_tier": "flex",
            "generationConfig": {
                "maxOutputTokens": self.config.max_output_tokens,
            },
        }
        thinking_config: Dict[str, Any] = {}
        if self.config.thinking_level:
            thinking_config["thinkingLevel"] = self.config.thinking_level
        if self.config.thinking_budget is not None:
            thinking_config["thinkingBudget"] = self.config.thinking_budget
        if thinking_config:
            body["generationConfig"]["thinkingConfig"] = thinking_config

        endpoint = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{quote(self.config.model_id, safe='')}:generateContent"
        )
        response = self._post(
            endpoint,
            headers={
                "x-goog-api-key": self.api_key,
                "Content-Type": "application/json",
            },
            json=body,
            timeout=(10, self.config.timeout_seconds),
        )
        _raise_for_status(response)
        data = response.json()
        if not isinstance(data, dict):
            raise APIClientError("Gemini returned a non-object JSON response")

        prompt_feedback = data.get("promptFeedback") or {}
        candidates = data.get("candidates") or []
        if not candidates:
            block_reason = prompt_feedback.get("blockReason") or "NO_CANDIDATES"
            raise APIClientError(f"Gemini returned no candidates: {block_reason}")

        first_candidate = candidates[0] if isinstance(candidates[0], dict) else {}
        text_parts: List[str] = []
        for part in (first_candidate.get("content") or {}).get("parts") or []:
            if isinstance(part, dict) and part.get("text") and not part.get("thought"):
                text_parts.append(str(part["text"]))

        finish_reason = first_candidate.get("finishReason")
        if finish_reason in {
            "SAFETY",
            "RECITATION",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "IMAGE_SAFETY",
        } and not text_parts:
            raise APIClientError(f"Gemini candidate blocked: {finish_reason}")

        usage = data.get("usageMetadata") or {}
        reasoning_tokens = usage.get("thoughtsTokenCount")
        input_tokens, output_tokens, total_tokens = normalize_usage(
            usage.get("promptTokenCount"),
            usage.get("candidatesTokenCount"),
            usage.get("totalTokenCount"),
            reasoning_tokens,
        )
        return APIResult(
            success=True,
            raw_response="".join(text_parts),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=_coerce_nonnegative_int(reasoning_tokens),
            total_tokens=total_tokens,
            stop_reason=str(finish_reason) if finish_reason else None,
            response_id=data.get("responseId"),
            model_version=data.get("modelVersion"),
            provider_metadata={
                "prompt_feedback": prompt_feedback,
                "safety_ratings": first_candidate.get("safetyRatings"),
            },
        )


class AnthropicClient(BaseAPIClient):
    def send(self, prompt: str, image_path: str | Path) -> APIResult:
        self._rate_limit()
        mime_type, encoded = encode_image(image_path)
        body: Dict[str, Any] = {
            "model": self.config.model_id,
            "max_tokens": self.config.max_output_tokens,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime_type,
                                "data": encoded,
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "stream": True,
        }
        if self.config.thinking_enabled:
            if self.config.thinking_budget_tokens is not None:
                body["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": self.config.thinking_budget_tokens,
                }
            else:
                body["thinking"] = {"type": "adaptive"}
        if self.config.reasoning_effort:
            body["output_config"] = {"effort": self.config.reasoning_effort}

        response = self._post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=body,
            stream=True,
            timeout=(10, self.config.timeout_seconds),
        )
        _raise_for_status(response)

        text = ""
        input_tokens = None
        output_tokens = None
        stop_reason = None
        response_id = None
        model_version = None
        message_stopped = False
        for raw_line in response.iter_lines():
            event = _json_from_sse_line(raw_line)
            if not event:
                continue
            event_type = event.get("type")
            if event_type == "message_start":
                message = event.get("message") or {}
                response_id = message.get("id")
                model_version = message.get("model")
                input_tokens = (message.get("usage") or {}).get("input_tokens")
            elif event_type == "content_block_delta":
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta":
                    text = merge_stream_text(text, str(delta.get("text") or ""))
            elif event_type == "message_delta":
                output_tokens = (event.get("usage") or {}).get("output_tokens")
                stop_reason = (event.get("delta") or {}).get("stop_reason")
            elif event_type == "message_stop":
                message_stopped = True
                break
            elif event_type == "error":
                error = event.get("error")
                detail = (
                    error.get("message")
                    if isinstance(error, dict)
                    else str(error or "unknown error")
                )
                raise APIClientError(f"Anthropic stream error: {detail}")

        if not message_stopped:
            raise APIClientError(
                "Anthropic stream ended before a message_stop event"
            )

        normalized_input, normalized_output, total_tokens = normalize_usage(
            input_tokens,
            output_tokens,
            None,
        )
        return APIResult(
            success=True,
            raw_response=text,
            input_tokens=normalized_input,
            output_tokens=normalized_output,
            total_tokens=total_tokens,
            stop_reason=str(stop_reason) if stop_reason else None,
            response_id=response_id,
            model_version=model_version,
        )


def create_client(
    config: ModelConfig,
    api_key: str,
    post: Optional[PostFunction] = None,
) -> BaseAPIClient:
    client_classes = {
        "openai_responses": OpenAIResponsesClient,
        "openai_chat": OpenAIChatClient,
        "google": GoogleClient,
        "anthropic": AnthropicClient,
    }
    return client_classes[config.provider](config, api_key, post=post)


def create_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Validate Maze Bench API model configuration.\n"
            "Use run_api_benchmark.py to run the benchmark."
        ),
        epilog="""\
Examples (from the repository root):
  python scripts/api_clients.py --validate-config scripts/models.examples.json
  python scripts/run_api_benchmark.py --all-models --dry-run
  python scripts/run_api_benchmark.py --all-models
  python scripts/run_api_benchmark.py --all-models --resume

Config example: scripts/models.examples.json
API keys:       .env
""",
    )
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument(
        "--list-providers",
        action="store_true",
        help="list supported provider identifiers and exit",
    )
    actions.add_argument(
        "--validate-config",
        metavar="PATH",
        type=Path,
        help="validate a models JSON file without making API requests",
    )
    return parser


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    return create_argument_parser().parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = create_argument_parser()
    args = parser.parse_args(argv)
    if args.list_providers:
        print("\n".join(sorted(SUPPORTED_PROVIDERS)))
        return 0
    if args.validate_config:
        try:
            data = json.loads(args.validate_config.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("models"), list):
                raise ValueError("Config must contain a top-level models array")
            models = [ModelConfig.from_dict(item) for item in data["models"]]
        except (OSError, TypeError, ValueError) as error:
            parser.error(str(error))
        print(f"Valid configuration: {len(models)} model(s)")
        for model in models:
            print(f"- {model.provider}: {model.name} ({model.model_id})")
        return 0
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
