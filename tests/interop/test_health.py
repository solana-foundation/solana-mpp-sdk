"""Test that the server health endpoint works."""
from __future__ import annotations

import httpx


def test_health_returns_200(client: httpx.Client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200


def test_health_returns_json(client: httpx.Client) -> None:
    resp = client.get("/health")
    data = resp.json()
    assert data.get("ok") is True
