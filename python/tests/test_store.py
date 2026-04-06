"""Tests for store module."""

from __future__ import annotations

import pytest

from solana_mpp.store import MemoryStore, Store


class TestMemoryStore:
    @pytest.fixture
    def store(self) -> MemoryStore:
        return MemoryStore()

    async def test_get_missing(self, store: MemoryStore):
        assert await store.get("missing") is None

    async def test_put_and_get(self, store: MemoryStore):
        await store.put("key", "value")
        assert await store.get("key") == "value"

    async def test_put_overwrites(self, store: MemoryStore):
        await store.put("key", "v1")
        await store.put("key", "v2")
        assert await store.get("key") == "v2"

    async def test_delete(self, store: MemoryStore):
        await store.put("key", "value")
        await store.delete("key")
        assert await store.get("key") is None

    async def test_delete_missing(self, store: MemoryStore):
        # Should not raise
        await store.delete("missing")

    async def test_put_if_absent_new_key(self, store: MemoryStore):
        result = await store.put_if_absent("key", "value")
        assert result is True
        assert await store.get("key") == "value"

    async def test_put_if_absent_existing_key(self, store: MemoryStore):
        await store.put("key", "v1")
        result = await store.put_if_absent("key", "v2")
        assert result is False
        assert await store.get("key") == "v1"

    def test_implements_store_protocol(self, store: MemoryStore):
        assert isinstance(store, Store)
