"""Error types for the Solana MPP SDK."""

from __future__ import annotations


class PaymentError(Exception):
    """Base class for all payment-related errors."""

    def __init__(self, message: str, code: str = "", retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class VerificationError(PaymentError):
    """Payment verification failed."""


class ChallengeExpiredError(PaymentError):
    """Challenge has expired."""

    def __init__(self, message: str = "challenge expired", code: str = "challenge-expired") -> None:
        super().__init__(message, code=code)


class ChallengeMismatchError(PaymentError):
    """Challenge ID does not match the expected HMAC."""

    def __init__(self, message: str = "challenge ID mismatch", code: str = "challenge-mismatch") -> None:
        super().__init__(message, code=code)


class ReplayError(PaymentError):
    """Transaction signature has already been consumed."""

    def __init__(
        self, message: str = "transaction signature already consumed", code: str = "signature-consumed"
    ) -> None:
        super().__init__(message, code=code)
