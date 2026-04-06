"""Cross-language interop test fixtures.

Run with: SERVER_URL=http://localhost:3001 pytest tests/interop/ -v
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re

import httpx
import pytest
from solders.keypair import Keypair  # type: ignore[import-untyped]


@pytest.fixture(scope="session")
def server_url() -> str:
    url = os.environ.get("SERVER_URL", "http://localhost:3001")
    return url.rstrip("/")


@pytest.fixture(scope="session")
def fortune_path() -> str:
    return os.environ.get("FORTUNE_PATH", "/fortune")


@pytest.fixture(scope="session")
def rpc_url() -> str:
    return os.environ.get("RPC_URL", "http://localhost:8899")


@pytest.fixture(scope="session")
def client(server_url: str) -> httpx.Client:
    return httpx.Client(base_url=server_url, timeout=30)


@pytest.fixture(scope="session")
def test_keypair() -> Keypair:
    return Keypair()


def base64url_decode(s: str) -> bytes:
    s = s.replace("-", "+").replace("_", "/")
    s += "=" * (4 - len(s) % 4)
    return base64.b64decode(s)


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def parse_www_authenticate(header: str) -> dict[str, str]:
    """Parse WWW-Authenticate: Payment key="value", ... into a dict."""
    # Strip "Payment " prefix
    params_str = re.sub(r"^Payment\s+", "", header, flags=re.IGNORECASE)
    result: dict[str, str] = {}
    for match in re.finditer(r'(\w+)="([^"]*)"', params_str):
        result[match.group(1)] = match.group(2)
    return result


def compute_challenge_id(
    secret_key: str,
    realm: str,
    method: str,
    intent: str,
    request: str,
    expires: str = "",
    digest: str = "",
    opaque: str = "",
) -> str:
    """Compute HMAC-SHA256 challenge ID matching all SDK implementations."""
    message = "|".join([realm, method, intent, request, expires, digest, opaque])
    mac = hmac.new(secret_key.encode(), message.encode(), hashlib.sha256).digest()
    return base64url_encode(mac)
