"""Provider-neutral contracts for asynchronous benchmark batches."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Mapping, Optional, Sequence

from api_clients import APIResult, ModelConfig


@dataclass(frozen=True)
class BatchRequest:
    custom_id: str
    payload: Dict[str, Any]


@dataclass(frozen=True)
class BatchSubmission:
    provider: str
    batch_id: str
    status: str
    request_counts: Dict[str, int] = field(default_factory=dict)
    created_at: Optional[str] = None
    expires_at: Optional[str] = None
    results_url: Optional[str] = None


@dataclass(frozen=True)
class BatchStatus:
    provider: str
    batch_id: str
    status: str
    terminal: bool
    request_counts: Dict[str, int] = field(default_factory=dict)
    created_at: Optional[str] = None
    ended_at: Optional[str] = None
    expires_at: Optional[str] = None
    results_url: Optional[str] = None


@dataclass(frozen=True)
class BatchItemResult:
    custom_id: str
    result_type: str
    response: Optional[APIResult] = None
    error_message: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None


class BatchProvider(ABC):
    provider: str

    @classmethod
    @abstractmethod
    def supports_model(cls, model: ModelConfig) -> bool:
        """Return whether this adapter can submit the configured model."""

    @abstractmethod
    def build_request(
        self,
        model: ModelConfig,
        custom_id: str,
        prompt: str,
        image_path: str,
    ) -> BatchRequest:
        """Build one provider request without sending it."""

    @abstractmethod
    def submit(self, requests: Sequence[BatchRequest]) -> BatchSubmission:
        """Create one provider batch."""

    @abstractmethod
    def retrieve(self, batch_id: str) -> BatchStatus:
        """Retrieve normalized batch status."""

    @abstractmethod
    def download_results(
        self,
        batch_id: str,
    ) -> tuple[str, Sequence[BatchItemResult]]:
        """Download raw results and return normalized items."""


BatchProviderFactory = Callable[[str, int], BatchProvider]
_PROVIDER_FACTORIES: Dict[str, BatchProviderFactory] = {}
_PROVIDER_TYPES: Dict[str, type[BatchProvider]] = {}


def register_batch_provider(
    provider: str,
    provider_type: type[BatchProvider],
    factory: BatchProviderFactory,
) -> None:
    if not provider or provider in _PROVIDER_FACTORIES:
        raise ValueError(f"Batch provider already registered or invalid: {provider}")
    _PROVIDER_TYPES[provider] = provider_type
    _PROVIDER_FACTORIES[provider] = factory


def registered_batch_providers() -> tuple[str, ...]:
    return tuple(sorted(_PROVIDER_FACTORIES))


def supports_batch_model(model: ModelConfig) -> bool:
    provider_type = _PROVIDER_TYPES.get(model.provider)
    return bool(provider_type and provider_type.supports_model(model))


def create_batch_provider(
    model: ModelConfig,
    api_key: str,
    max_attempts: int,
) -> BatchProvider:
    factory = _PROVIDER_FACTORIES.get(model.provider)
    if factory is None:
        available = ", ".join(registered_batch_providers()) or "(none)"
        raise ValueError(
            f"Provider {model.provider!r} has no Batch API adapter. "
            f"Registered providers: {available}"
        )
    provider = factory(api_key, max_attempts)
    if not provider.supports_model(model):
        raise ValueError(
            f"Batch provider {model.provider!r} does not support {model.name!r}"
        )
    return provider


def count_result_types(items: Iterable[BatchItemResult]) -> Mapping[str, int]:
    counts: Dict[str, int] = {}
    for item in items:
        counts[item.result_type] = counts.get(item.result_type, 0) + 1
    return counts
