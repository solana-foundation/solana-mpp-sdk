"""Test that the server issues valid 402 challenges."""
from __future__ import annotations

import json

import httpx

from conftest import base64url_decode, parse_www_authenticate


def test_fortune_returns_402(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    assert resp.status_code == 402


def test_fortune_has_www_authenticate(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    assert "www-authenticate" in resp.headers


def test_challenge_has_payment_scheme(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    www_auth = resp.headers["www-authenticate"]
    assert www_auth.startswith("Payment ")


def test_challenge_has_required_fields(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    assert "id" in challenge
    assert "realm" in challenge
    assert "method" in challenge
    assert "intent" in challenge
    assert "request" in challenge


def test_challenge_method_is_solana(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    assert challenge["method"] == "solana"


def test_challenge_intent_is_charge(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    assert challenge["intent"] == "charge"


def test_challenge_request_is_valid_base64url_json(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    decoded = json.loads(base64url_decode(challenge["request"]))
    assert "amount" in decoded
    assert "currency" in decoded
    assert "recipient" in decoded


def test_challenge_request_has_method_details(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    decoded = json.loads(base64url_decode(challenge["request"]))
    md = decoded.get("methodDetails", {})
    assert "network" in md


def test_challenge_has_cache_control(client: httpx.Client, fortune_path: str) -> None:
    resp = client.get(fortune_path)
    # cache-control: no-store is recommended but not all servers set it
    cc = resp.headers.get("cache-control", "")
    assert cc == "" or cc == "no-store"
