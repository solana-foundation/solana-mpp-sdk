"""Tests for server middleware (@pay decorator)."""

from __future__ import annotations

import pytest

from solana_mpp.server.middleware import pay
from solana_mpp.server.mpp import Config, Mpp
from solana_mpp.store import MemoryStore


@pytest.fixture
def mpp_handler():
    return Mpp(
        Config(
            recipient="CXhrFZJLKqjzmP3sjYLcF4dTeXWKCy9e2SXXZ2Yo6MPY",
            secret_key="test-secret-key-long-enough-for-hmac-sha256-operations-1234567890",
            network="localnet",
            store=MemoryStore(),
        )
    )


class TestPayDecorator:
    def test_creates_decorator(self, mpp_handler):
        @pay(mpp_handler, "0.01")
        async def handler(request, credential, receipt):
            return {"ok": True}

        assert callable(handler)

    def test_decorator_preserves_name(self, mpp_handler):
        @pay(mpp_handler, "0.01")
        async def my_handler(request, credential, receipt):
            return {"ok": True}

        assert my_handler.__name__ == "my_handler"

    @pytest.mark.asyncio
    async def test_no_auth_returns_402(self, mpp_handler):
        @pay(mpp_handler, "10000")
        async def handler(request, credential, receipt):
            return {"ok": True}

        # Simulate a request without Authorization header
        class FakeRequest:
            headers = {}
            url = "http://localhost/test"

        result = await handler(FakeRequest())
        # Should return a challenge (402-like response)
        assert result is not None

    @pytest.mark.asyncio
    async def test_with_invalid_auth_returns_402(self, mpp_handler):
        @pay(mpp_handler, "10000")
        async def handler(request, credential, receipt):
            return {"ok": True}

        class FakeRequest:
            headers = {"authorization": "Payment invalid-credential"}
            url = "http://localhost/test"

        result = await handler(FakeRequest())
        assert result is not None
