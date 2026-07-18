"""Anthropic Message Batches adapter for Maze Bench."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Sequence

import requests

from api_clients import (
    APIClientError,
    APIResult,
    ModelConfig,
    _coerce_nonnegative_int,
    encode_image,
    normalize_usage,
)
from batch_api import (
    BatchItemResult,
    BatchProvider,
    BatchRequest,
    BatchStatus,
    BatchSubmission,
)


ANTHROPIC_API_BASE = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"
RETRYABLE_HTTP_STATUSES = {408, 409, 429, 500, 502, 503, 504}
CUSTOM_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AnthropicBatchProvider(BatchProvider):
    provider = "anthropic"

    def __init__(
        self,
        api_key: str,
        max_attempts: int = 3,
        *,
        post: Optional[Callable[..., Any]] = None,
        get: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        self.api_key = api_key
        self.max_attempts = max_attempts
        self._post = post or requests.post
        self._get = get or requests.get
        self._sleep = sleep

    @classmethod
    def supports_model(cls, model: ModelConfig) -> bool:
        return model.provider == cls.provider

    def build_request(
        self,
        model: ModelConfig,
        custom_id: str,
        prompt: str,
        image_path: str,
    ) -> BatchRequest:
        self._validate_model_settings(model)
        if not CUSTOM_ID_PATTERN.fullmatch(custom_id):
            raise ValueError(
                "Anthropic custom_id must match ^[A-Za-z0-9_-]{1,64}$: "
                f"{custom_id!r}"
            )
        mime_type, encoded = encode_image(Path(image_path))
        params: Dict[str, Any] = {
            "model": model.model_id,
            "max_tokens": model.max_output_tokens,
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
        }
        params.update(self._thinking_parameters(model))
        return BatchRequest(
            custom_id=custom_id,
            payload={"custom_id": custom_id, "params": params},
        )

    def submit(self, requests_to_submit: Sequence[BatchRequest]) -> BatchSubmission:
        if not requests_to_submit:
            raise ValueError("Cannot submit an empty batch")
        response = self._post(
            f"{ANTHROPIC_API_BASE}/messages/batches",
            headers=self._headers(),
            json={"requests": [request.payload for request in requests_to_submit]},
            timeout=(10, 120),
        )
        data = self._response_json(response)
        return self._submission_from_data(data)

    def retrieve(self, batch_id: str) -> BatchStatus:
        response = self._get_with_retry(
            f"{ANTHROPIC_API_BASE}/messages/batches/{batch_id}",
            stream=False,
        )
        return self._status_from_data(self._response_json(response))

    def download_results(
        self,
        batch_id: str,
    ) -> tuple[str, Sequence[BatchItemResult]]:
        response = self._get_with_retry(
            f"{ANTHROPIC_API_BASE}/messages/batches/{batch_id}/results",
            stream=True,
        )
        raw_lines: list[str] = []
        items: list[BatchItemResult] = []
        for raw_line in response.iter_lines():
            line = (
                raw_line.decode("utf-8", errors="replace")
                if isinstance(raw_line, bytes)
                else str(raw_line)
            ).strip()
            if not line:
                continue
            raw_lines.append(line)
            try:
                data = json.loads(line)
            except json.JSONDecodeError as error:
                raise APIClientError(
                    f"Anthropic batch returned invalid JSONL: {error}"
                ) from error
            if not isinstance(data, dict):
                raise APIClientError("Anthropic batch result must be a JSON object")
            items.append(self._parse_result(data))
        raw_text = "\n".join(raw_lines) + ("\n" if raw_lines else "")
        return raw_text, items

    def _headers(self) -> Dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }

    def _get_with_retry(self, url: str, *, stream: bool) -> Any:
        last_error: Optional[BaseException] = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                response = self._get(
                    url,
                    headers=self._headers(),
                    stream=stream,
                    timeout=(10, 120),
                )
            except requests.RequestException as error:
                last_error = error
                if attempt >= self.max_attempts:
                    raise
                self._sleep(2 ** (attempt - 1))
                continue

            status = int(getattr(response, "status_code", 0) or 0)
            if status not in RETRYABLE_HTTP_STATUSES:
                self._raise_for_status(response)
                return response

            last_error = APIClientError(self._http_error(response))
            if attempt >= self.max_attempts:
                raise last_error
            self._sleep(2 ** (attempt - 1))
        raise APIClientError(str(last_error or "Anthropic GET failed"))

    def _response_json(self, response: Any) -> Dict[str, Any]:
        self._raise_for_status(response)
        try:
            data = response.json()
        except (ValueError, json.JSONDecodeError) as error:
            raise APIClientError("Anthropic returned invalid JSON") from error
        if not isinstance(data, dict):
            raise APIClientError("Anthropic returned a non-object JSON response")
        return data

    def _raise_for_status(self, response: Any) -> None:
        status = int(getattr(response, "status_code", 0) or 0)
        if 200 <= status < 300:
            return
        raise APIClientError(self._http_error(response))

    @staticmethod
    def _http_error(response: Any) -> str:
        status = int(getattr(response, "status_code", 0) or 0)
        text = str(getattr(response, "text", "") or "").strip()
        if len(text) > 2000:
            text = text[:2000] + "..."
        return f"HTTP {status}" + (f": {text}" if text else "")

    @staticmethod
    def _request_counts(data: Dict[str, Any]) -> Dict[str, int]:
        counts = data.get("request_counts") or {}
        return {
            key: int(counts.get(key, 0) or 0)
            for key in ("processing", "succeeded", "errored", "canceled", "expired")
        }

    def _submission_from_data(self, data: Dict[str, Any]) -> BatchSubmission:
        batch_id = data.get("id")
        if not isinstance(batch_id, str) or not batch_id:
            raise APIClientError("Anthropic batch response is missing id")
        return BatchSubmission(
            provider=self.provider,
            batch_id=batch_id,
            status=str(data.get("processing_status") or "unknown"),
            request_counts=self._request_counts(data),
            created_at=data.get("created_at"),
            expires_at=data.get("expires_at"),
            results_url=data.get("results_url"),
        )

    def _status_from_data(self, data: Dict[str, Any]) -> BatchStatus:
        submission = self._submission_from_data(data)
        return BatchStatus(
            provider=self.provider,
            batch_id=submission.batch_id,
            status=submission.status,
            terminal=submission.status == "ended",
            request_counts=submission.request_counts,
            created_at=submission.created_at,
            ended_at=data.get("ended_at"),
            expires_at=submission.expires_at,
            results_url=submission.results_url,
        )

    @staticmethod
    def _thinking_parameters(model: ModelConfig) -> Dict[str, Any]:
        parameters: Dict[str, Any] = {}
        if model.thinking_enabled:
            if model.thinking_budget_tokens is not None:
                parameters["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": model.thinking_budget_tokens,
                }
            else:
                parameters["thinking"] = {"type": "adaptive"}
        if model.reasoning_effort:
            parameters["output_config"] = {"effort": model.reasoning_effort}
        return parameters

    @staticmethod
    def _validate_model_settings(model: ModelConfig) -> None:
        model_id = model.model_id
        budget = model.thinking_budget_tokens
        if model_id.startswith("claude-fable-5"):
            if model.thinking_enabled or budget is not None:
                raise ValueError(
                    "Claude Fable 5 has always-on adaptive thinking; omit thinking"
                )
        elif model_id.startswith("claude-opus-4-8"):
            if not model.thinking_enabled or budget is not None:
                raise ValueError(
                    "Claude Opus 4.8 requires adaptive thinking without a token budget"
                )
        elif model_id.startswith("claude-sonnet-5"):
            if model.thinking_enabled or budget is not None:
                raise ValueError(
                    "Claude Sonnet 5 uses default adaptive thinking; omit thinking"
                )
        elif model_id.startswith("claude-haiku-4-5"):
            if not model.thinking_enabled or budget is None:
                raise ValueError(
                    "Claude Haiku 4.5 requires manual thinking with a token budget"
                )
            if model.reasoning_effort:
                raise ValueError("Claude Haiku 4.5 does not support effort")

        if budget is not None and budget >= model.max_output_tokens:
            raise ValueError(
                f"thinking_budget_tokens must be below max_output_tokens: {model.name}"
            )

    @staticmethod
    def _parse_result(data: Dict[str, Any]) -> BatchItemResult:
        custom_id = data.get("custom_id")
        result = data.get("result")
        if not isinstance(custom_id, str) or not custom_id:
            raise APIClientError("Anthropic batch result is missing custom_id")
        if not isinstance(result, dict):
            raise APIClientError(
                f"Anthropic batch result {custom_id!r} is missing result"
            )

        result_type = str(result.get("type") or "unknown")
        if result_type != "succeeded":
            error = result.get("error")
            if isinstance(error, dict):
                nested = error.get("error")
                if isinstance(nested, dict):
                    error = nested
                message = (
                    error.get("message")
                    if isinstance(error, dict)
                    else str(error)
                )
            else:
                message = None
            return BatchItemResult(
                custom_id=custom_id,
                result_type=result_type,
                error_message=str(message or result_type),
                raw=data,
            )

        message = result.get("message")
        if not isinstance(message, dict):
            raise APIClientError(
                f"Anthropic succeeded result {custom_id!r} is missing message"
            )
        text = "".join(
            str(block.get("text") or "")
            for block in message.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        )
        usage = message.get("usage") or {}
        thinking_tokens = (usage.get("output_tokens_details") or {}).get(
            "thinking_tokens"
        )
        input_tokens, output_tokens, total_tokens = normalize_usage(
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            None,
        )
        response = APIResult(
            success=True,
            raw_response=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            reasoning_tokens=_coerce_nonnegative_int(thinking_tokens),
            total_tokens=total_tokens,
            stop_reason=message.get("stop_reason"),
            response_id=message.get("id"),
            model_version=message.get("model"),
        )
        return BatchItemResult(
            custom_id=custom_id,
            result_type=result_type,
            response=response,
            raw=data,
        )
