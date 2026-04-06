"""Tests for _expires module."""

from __future__ import annotations

from datetime import UTC, datetime

from solana_mpp._expires import days, hours, minutes, seconds, weeks


def _parse_timestamp(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def test_seconds():
    ts = seconds(60)
    dt = _parse_timestamp(ts)
    now = datetime.now(UTC)
    # Should be about 60 seconds from now (+/- 2 seconds for test execution)
    diff = (dt - now).total_seconds()
    assert 58 < diff < 62


def test_minutes():
    ts = minutes(5)
    dt = _parse_timestamp(ts)
    now = datetime.now(UTC)
    diff = (dt - now).total_seconds()
    assert 298 < diff < 302


def test_hours():
    ts = hours(1)
    dt = _parse_timestamp(ts)
    now = datetime.now(UTC)
    diff = (dt - now).total_seconds()
    assert 3598 < diff < 3602


def test_days():
    ts = days(1)
    dt = _parse_timestamp(ts)
    now = datetime.now(UTC)
    diff = (dt - now).total_seconds()
    assert 86398 < diff < 86402


def test_weeks():
    ts = weeks(1)
    dt = _parse_timestamp(ts)
    now = datetime.now(UTC)
    diff = (dt - now).total_seconds()
    assert 604798 < diff < 604802


def test_format_ends_with_z():
    ts = seconds(10)
    assert ts.endswith("Z")


def test_format_has_milliseconds():
    ts = seconds(10)
    # Should have millisecond precision: ...T12:34:56.789Z
    parts = ts.split(".")
    assert len(parts) == 2
    assert parts[1].endswith("Z")
    assert len(parts[1]) == 4  # "789Z"
