"""Gemini Batch API 어댑터."""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Dict, Optional, Sequence
from urllib.parse import quote

import requests

from api_clients import (
    APIClientError,
    ModelConfig,
    _build_google_request,
    _parse_google_response,
)
from batch_api import (
    BatchItemResult,
    BatchProvider,
    BatchRequest,
    BatchStatus,
    BatchSubmission,
)


GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
MAX_INLINE_REQUEST_BYTES = 20_000_000
RETRYABLE_HTTP_STATUSES = {408, 409, 429, 500, 502, 503, 504}

_STATE_NAMES = {
    "BATCH_STATE_UNSPECIFIED": "unknown",
    "BATCH_STATE_PENDING": "pending",
    "BATCH_STATE_RUNNING": "running",
    "BATCH_STATE_SUCCEEDED": "succeeded",
    "BATCH_STATE_FAILED": "failed",
    "BATCH_STATE_CANCELLED": "cancelled",
    "BATCH_STATE_EXPIRED": "expired",
    "JOB_STATE_UNSPECIFIED": "unknown",
    "JOB_STATE_PENDING": "pending",
    "JOB_STATE_RUNNING": "running",
    "JOB_STATE_SUCCEEDED": "succeeded",
    "JOB_STATE_FAILED": "failed",
    "JOB_STATE_CANCELLED": "cancelled",
    "JOB_STATE_EXPIRED": "expired",
}
_TERMINAL_RESULT_TYPES = {
    "failed": "errored",
    "cancelled": "canceled",
    "expired": "expired",
}
_TERMINAL_STATES = {*_TERMINAL_RESULT_TYPES, "succeeded"}


class GeminiBatchProvider(BatchProvider):
    provider = "google"

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
        return model.provider == cls.provider and model.model_id.startswith("gemini-")

    def build_request(
        self,
        model: ModelConfig,
        custom_id: str,
        prompt: str,
        image_path: str,
    ) -> BatchRequest:
        if not self.supports_model(model):
            raise ValueError(f"Gemini Batch does not support {model.name!r}")
        request = _build_google_request(model, prompt, image_path)
        request["model"] = f"models/{model.model_id}"
        return BatchRequest(
            custom_id=custom_id,
            payload={"request": request, "metadata": {"key": custom_id}},
        )

    def validate_requests(self, requests_to_submit: Sequence[BatchRequest]) -> None:
        self._prepare_submission(requests_to_submit)

    def submit(self, requests_to_submit: Sequence[BatchRequest]) -> BatchSubmission:
        model_id, body = self._prepare_submission(requests_to_submit)
        response = self._post(
            f"{GOOGLE_API_BASE}/models/{quote(model_id, safe='')}:batchGenerateContent",
            headers=self._headers(),
            data=body,
            timeout=(10, 120),
        )
        data = self._response_json(response)
        return self._submission_from_data(data)

    def retrieve(self, batch_id: str) -> BatchStatus:
        data = self._get_operation(batch_id)
        return self._status_from_data(data)

    def download_results(
        self,
        batch_id: str,
    ) -> tuple[str, Sequence[BatchItemResult]]:
        data = self._get_operation(batch_id)
        status = self._status_from_data(data)
        if status.status != "succeeded":
            raise APIClientError(
                status.error_message
                or f"Gemini batch is not successful: {status.status}"
            )

        operation_response = data.get("response")
        inlined_responses = (
            operation_response.get("inlinedResponses")
            if isinstance(operation_response, dict)
            else None
        )
        result_rows = (
            inlined_responses.get("inlinedResponses")
            if isinstance(inlined_responses, dict)
            else None
        )
        if not isinstance(result_rows, list):
            raise APIClientError("Gemini batch response is missing inlined responses")

        lines: list[str] = []
        items: list[BatchItemResult] = []
        for row in result_rows:
            if not isinstance(row, dict):
                raise APIClientError("Gemini inline result must be a JSON object")
            lines.append(json.dumps(row, ensure_ascii=False))
            items.append(self._parse_inline_result(row))
        return ("\n".join(lines) + ("\n" if lines else ""), items)

    def _prepare_submission(
        self,
        requests_to_submit: Sequence[BatchRequest],
    ) -> tuple[str, bytes]:
        if not requests_to_submit:
            raise ValueError("Cannot submit an empty batch")

        model_id: Optional[str] = None
        for batch_request in requests_to_submit:
            payload = batch_request.payload
            generation_request = payload.get("request")
            metadata = payload.get("metadata")
            if not isinstance(generation_request, dict) or not isinstance(
                metadata, dict
            ):
                raise ValueError(
                    "Gemini batch request must contain request and metadata"
                )
            request_model = generation_request.get("model")
            if not isinstance(request_model, str) or not request_model.startswith(
                "models/gemini-"
            ):
                raise ValueError("Gemini batch request must target a Gemini model")
            current_model_id = request_model.removeprefix("models/")
            if model_id is None:
                model_id = current_model_id
            elif current_model_id != model_id:
                raise ValueError("All requests in a Gemini batch must use one model")
            if metadata.get("key") != batch_request.custom_id:
                raise ValueError("Gemini batch metadata.key must match custom_id")

        body = json.dumps(
            {
                "batch": {
                    "displayName": "maze-bench-batch",
                    "inputConfig": {
                        "requests": {
                            "requests": [
                                batch_request.payload
                                for batch_request in requests_to_submit
                            ]
                        }
                    },
                }
            },
            ensure_ascii=False,
        ).encode("utf-8")
        if len(body) > MAX_INLINE_REQUEST_BYTES:
            raise ValueError(
                "Gemini inline batch body exceeds the 20,000,000-byte limit: "
                f"{len(body)} bytes"
            )
        assert model_id is not None
        return model_id, body

    def _headers(self) -> Dict[str, str]:
        return {
            "x-goog-api-key": self.api_key,
            "Content-Type": "application/json",
        }

    def _get_operation(self, batch_id: str) -> Dict[str, Any]:
        encoded_batch_id = quote(batch_id, safe="/")
        response = self._get_with_retry(f"{GOOGLE_API_BASE}/{encoded_batch_id}")
        return self._response_json(response)

    def _get_with_retry(self, url: str) -> Any:
        last_error: Optional[BaseException] = None
        for attempt in range(1, self.max_attempts + 1):
            try:
                response = self._get(
                    url,
                    headers=self._headers(),
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
        raise APIClientError(str(last_error or "Gemini GET failed"))

    def _response_json(self, response: Any) -> Dict[str, Any]:
        self._raise_for_status(response)
        try:
            data = response.json()
        except ValueError as error:
            raise APIClientError("Gemini returned invalid JSON") from error
        if not isinstance(data, dict):
            raise APIClientError("Gemini returned a non-object JSON response")
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
    def _request_counts(metadata: Dict[str, Any]) -> Dict[str, int]:
        stats = metadata.get("batchStats") or {}
        return {
            "processing": int(stats.get("pendingRequestCount", 0) or 0),
            "succeeded": int(stats.get("successfulRequestCount", 0) or 0),
            "errored": int(stats.get("failedRequestCount", 0) or 0),
            "canceled": 0,
            "expired": 0,
        }

    @staticmethod
    def _normalized_state(metadata: Dict[str, Any]) -> str:
        state = metadata.get("state")
        if not isinstance(state, str) or not state:
            return "unknown"
        return _STATE_NAMES.get(state, state.lower())

    @staticmethod
    def _operation_error(data: Dict[str, Any]) -> Optional[str]:
        error = data.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            return str(message) if message else json.dumps(error, ensure_ascii=False)
        return str(error) if error else None

    def _submission_from_data(self, data: Dict[str, Any]) -> BatchSubmission:
        batch_id = data.get("name")
        metadata = data.get("metadata")
        if not isinstance(batch_id, str) or not batch_id:
            raise APIClientError("Gemini batch response is missing name")
        if not isinstance(metadata, dict):
            raise APIClientError("Gemini batch response is missing metadata")
        return BatchSubmission(
            provider=self.provider,
            batch_id=batch_id,
            status=self._normalized_state(metadata),
            request_counts=self._request_counts(metadata),
            created_at=metadata.get("createTime"),
        )

    def _status_from_data(self, data: Dict[str, Any]) -> BatchStatus:
        submission = self._submission_from_data(data)
        terminal_result_type = _TERMINAL_RESULT_TYPES.get(submission.status)
        error_message = self._operation_error(data)
        if terminal_result_type and not error_message:
            error_message = str(
                data.get("metadata", {}).get("state") or submission.status
            )
        return BatchStatus(
            provider=self.provider,
            batch_id=submission.batch_id,
            status=submission.status,
            terminal=submission.status in _TERMINAL_STATES,
            request_counts=submission.request_counts,
            created_at=submission.created_at,
            ended_at=data.get("metadata", {}).get("endTime"),
            terminal_result_type=terminal_result_type,
            error_message=error_message if terminal_result_type else None,
        )

    @staticmethod
    def _parse_inline_result(data: Dict[str, Any]) -> BatchItemResult:
        metadata = data.get("metadata")
        custom_id = metadata.get("key") if isinstance(metadata, dict) else None
        if not isinstance(custom_id, str) or not custom_id:
            raise APIClientError("Gemini inline result is missing metadata.key")

        provider_error = data.get("error")
        if provider_error:
            if isinstance(provider_error, dict):
                message = provider_error.get("message")
                error_message = (
                    str(message)
                    if message
                    else json.dumps(provider_error, ensure_ascii=False)
                )
            else:
                error_message = str(provider_error)
            return BatchItemResult(
                custom_id=custom_id,
                result_type="errored",
                error_message=error_message,
                raw=data,
            )

        response_data = data.get("response")
        if not isinstance(response_data, dict):
            raise APIClientError(
                f"Gemini inline result {custom_id!r} is missing response or error"
            )
        try:
            response = _parse_google_response(response_data)
        except APIClientError as error:
            return BatchItemResult(
                custom_id=custom_id,
                result_type="errored",
                error_message=str(error),
                raw=data,
            )
        return BatchItemResult(
            custom_id=custom_id,
            result_type="succeeded",
            response=response,
            raw=data,
        )
