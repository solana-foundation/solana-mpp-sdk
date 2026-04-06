"""Core protocol types."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from solana_mpp._base64url import decode_json, encode_json
from solana_mpp._challenge import compute_challenge_id, constant_time_equal


@dataclass
class PaymentChallenge:
    """Payment challenge from server (parsed from WWW-Authenticate header)."""

    id: str
    realm: str
    method: str  # e.g. "solana"
    intent: str  # e.g. "charge"
    request: str  # base64url-encoded JSON
    expires: str = ""
    description: str = ""
    digest: str = ""
    opaque: str | None = None

    @staticmethod
    def with_secret_key(
        secret_key: str,
        realm: str,
        method: str,
        intent: str,
        request: str,
        expires: str = "",
        digest: str = "",
        description: str = "",
        opaque: str | None = None,
    ) -> PaymentChallenge:
        """Create a challenge with an HMAC-bound ID."""
        challenge_id = compute_challenge_id(
            secret_key=secret_key,
            realm=realm,
            method=method,
            intent=intent,
            request=request,
            expires=expires,
            digest=digest,
            opaque=opaque,
        )
        return PaymentChallenge(
            id=challenge_id,
            realm=realm,
            method=method,
            intent=intent,
            request=request,
            expires=expires,
            description=description,
            digest=digest,
            opaque=opaque,
        )

    def verify(self, secret_key: str) -> bool:
        """Verify that this challenge's ID matches the expected HMAC."""
        expected_id = compute_challenge_id(
            secret_key=secret_key,
            realm=self.realm,
            method=self.method,
            intent=self.intent,
            request=self.request,
            expires=self.expires,
            digest=self.digest,
            opaque=self.opaque,
        )
        return constant_time_equal(self.id, expected_id)

    def is_expired(self, now: datetime | None = None) -> bool:
        """Return True if the challenge has expired."""
        if not self.expires:
            return False
        try:
            ts_str = self.expires.replace("Z", "+00:00")
            expires_at = datetime.fromisoformat(ts_str)
            ref = now if now is not None else datetime.now(UTC)
            return expires_at <= ref
        except (ValueError, TypeError):
            return True  # fail-closed

    def to_echo(self) -> ChallengeEcho:
        """Create a challenge echo for use in credentials."""
        return ChallengeEcho(
            id=self.id,
            realm=self.realm,
            method=self.method,
            intent=self.intent,
            request=self.request,
            expires=self.expires,
            digest=self.digest,
            opaque=self.opaque,
        )

    def decode_request(self) -> dict[str, Any]:
        """Decode the base64url request field into a dict."""
        return decode_json(self.request)

    @staticmethod
    def encode_request(obj: dict[str, Any]) -> str:
        """Encode a dict into a base64url request string."""
        return encode_json(obj)


@dataclass
class ChallengeEcho:
    """Challenge echo in credential (echoes server challenge parameters)."""

    id: str
    realm: str
    method: str
    intent: str
    request: str  # raw base64url string
    expires: str = ""
    digest: str = ""
    opaque: str | None = None


@dataclass
class PaymentCredential:
    """Payment credential from client (sent in Authorization header)."""

    challenge: ChallengeEcho
    payload: dict[str, Any] = field(default_factory=dict)
    source: str | None = None


@dataclass
class Receipt:
    """Payment receipt from server (parsed from Payment-Receipt header)."""

    status: str  # "success"
    method: str
    timestamp: str
    reference: str
    challenge_id: str = ""
    external_id: str = ""

    def is_success(self) -> bool:
        """Return True if the receipt indicates success."""
        return self.status == "success"

    @staticmethod
    def success(
        method: str,
        reference: str,
        challenge_id: str = "",
        external_id: str = "",
    ) -> Receipt:
        """Create a successful payment receipt with current timestamp."""
        return Receipt(
            status="success",
            method=method,
            timestamp=datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            reference=reference,
            challenge_id=challenge_id,
            external_id=external_id,
        )
