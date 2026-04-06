"""Pluggable key-value store for replay protection."""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Store(Protocol):
    """Async key-value store interface."""

    async def get(self, key: str) -> Any | None: ...
    async def put(self, key: str, value: Any) -> None: ...
    async def delete(self, key: str) -> None: ...
    async def put_if_absent(self, key: str, value: Any) -> bool: ...


class MemoryStore:
    """Thread-safe in-memory store for development/testing."""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}

    async def get(self, key: str) -> Any | None:
        return self._data.get(key)

    async def put(self, key: str, value: Any) -> None:
        self._data[key] = value

    async def delete(self, key: str) -> None:
        self._data.pop(key, None)

    async def put_if_absent(self, key: str, value: Any) -> bool:
        if key in self._data:
            return False
        self._data[key] = value
        return True
