"""Tests for _errors module."""

from __future__ import annotations

from solana_mpp._errors import (
    ChallengeExpiredError,
    ChallengeMismatchError,
    PaymentError,
    ReplayError,
    VerificationError,
)


def test_payment_error():
    err = PaymentError("test error", code="test-code", retryable=True)
    assert str(err) == "test error"
    assert err.code == "test-code"
    assert err.retryable is True


def test_payment_error_defaults():
    err = PaymentError("msg")
    assert err.code == ""
    assert err.retryable is False


def test_verification_error_is_payment_error():
    err = VerificationError("bad signature")
    assert isinstance(err, PaymentError)
    assert str(err) == "bad signature"


def test_challenge_expired_error():
    err = ChallengeExpiredError()
    assert isinstance(err, PaymentError)
    assert err.code == "challenge-expired"
    assert "expired" in str(err)


def test_challenge_mismatch_error():
    err = ChallengeMismatchError()
    assert isinstance(err, PaymentError)
    assert err.code == "challenge-mismatch"
    assert "mismatch" in str(err)


def test_replay_error():
    err = ReplayError()
    assert isinstance(err, PaymentError)
    assert err.code == "signature-consumed"
    assert "consumed" in str(err)


def test_custom_replay_error():
    err = ReplayError("custom message", code="custom-code")
    assert str(err) == "custom message"
    assert err.code == "custom-code"
