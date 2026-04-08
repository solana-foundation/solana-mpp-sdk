"""Tests for server/mpp module."""

from __future__ import annotations

import pytest

from solana_mpp._errors import ChallengeExpiredError, ChallengeMismatchError, PaymentError, ReplayError
from solana_mpp._types import ChallengeEcho, PaymentCredential
from solana_mpp.server.mpp import ChargeOptions, Config, Mpp

TEST_SECRET = "test-secret-key-that-is-long-enough-for-hmac-sha256"
TEST_RECIPIENT = "11111111111111111111111111111112"


@pytest.fixture
def mpp() -> Mpp:
    config = Config(
        recipient=TEST_RECIPIENT,
        currency="USDC",
        decimals=6,
        network="devnet",
        secret_key=TEST_SECRET,
    )
    return Mpp(config)


class TestConfig:
    def test_missing_recipient_raises(self):
        with pytest.raises(PaymentError, match="recipient"):
            Mpp(Config(recipient="", secret_key=TEST_SECRET))

    def test_missing_secret_key_raises(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv("MPP_SECRET_KEY", raising=False)
        with pytest.raises(PaymentError, match="secret key"):
            Mpp(Config(recipient=TEST_RECIPIENT, secret_key=""))

    def test_defaults(self, mpp: Mpp):
        assert mpp.realm == "MPP Payment"
        assert "devnet" in mpp.rpc_url


class TestCharge:
    def test_charge_creates_challenge(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        assert challenge.id != ""
        assert challenge.method == "solana"
        assert challenge.intent == "charge"
        assert challenge.verify(TEST_SECRET)

    def test_charge_with_options(self, mpp: Mpp):
        options = ChargeOptions(
            description="Test payment",
            external_id="ext-1",
            expires="2099-01-01T00:00:00Z",
        )
        challenge = mpp.charge_with_options("0.50", options)
        assert challenge.description == "Test payment"
        assert challenge.expires == "2099-01-01T00:00:00Z"

    def test_charge_converts_units(self, mpp: Mpp):
        challenge = mpp.charge("1.50")
        request = challenge.decode_request()
        assert request["amount"] == "1500000"

    def test_charge_includes_recipient(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        request = challenge.decode_request()
        assert request["recipient"] == TEST_RECIPIENT
        assert request["currency"] == "USDC"

    def test_charge_with_splits(self, mpp: Mpp):
        options = ChargeOptions(
            splits=[
                {"recipient": "VendorPayoutsWaLLetxxxxxxxxxxxxxxxxxxxxxx1111", "amount": "500000", "memo": "Vendor payout"},
                {"recipient": "ProcessorFeeWaLLetxxxxxxxxxxxxxxxxxxxxxxx1111", "amount": "29000"},
            ],
        )
        challenge = mpp.charge_with_options("1.00", options)
        request = challenge.decode_request()
        md = request["methodDetails"]
        assert "splits" in md
        assert len(md["splits"]) == 2
        assert md["splits"][0]["amount"] == "500000"
        assert md["splits"][0]["memo"] == "Vendor payout"

    def test_charge_without_splits_omitted(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        request = challenge.decode_request()
        md = request["methodDetails"]
        assert "splits" not in md


class TestVerifyCredential:
    async def test_challenge_mismatch(self, mpp: Mpp):
        echo = ChallengeEcho(id="bad-id", realm="r", method="solana", intent="charge", request="e30")
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "transaction", "transaction": "abc"},
        )
        with pytest.raises(ChallengeMismatchError):
            await mpp.verify_credential(credential)

    async def test_challenge_expired(self, mpp: Mpp):
        challenge = mpp.charge_with_options("1.00", ChargeOptions(expires="2020-01-01T00:00:00Z"))
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "transaction", "transaction": "abc"},
        )
        with pytest.raises(ChallengeExpiredError):
            await mpp.verify_credential(credential)

    async def test_invalid_payload_type(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "unknown"},
        )
        with pytest.raises(PaymentError, match="invalid payload type"):
            await mpp.verify_credential(credential)

    async def test_replay_protection(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "signature", "signature": "sig123"},
        )
        # First call succeeds
        receipt = await mpp.verify_credential(credential)
        assert receipt.is_success()

        # Second call with same signature fails
        with pytest.raises(ReplayError):
            await mpp.verify_credential(credential)

    async def test_missing_transaction(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "transaction", "transaction": ""},
        )
        with pytest.raises(PaymentError, match="missing transaction"):
            await mpp.verify_credential(credential)

    async def test_missing_signature(self, mpp: Mpp):
        challenge = mpp.charge("1.00")
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "signature", "signature": ""},
        )
        with pytest.raises(PaymentError, match="missing signature"):
            await mpp.verify_credential(credential)

    async def test_signature_fee_payer_rejected(self, mpp: Mpp):
        options = ChargeOptions(fee_payer=True)
        challenge = mpp.charge_with_options("1.00", options)
        echo = challenge.to_echo()
        credential = PaymentCredential(
            challenge=echo,
            payload={"type": "signature", "signature": "sig456"},
        )
        with pytest.raises(PaymentError, match="fee sponsorship"):
            await mpp.verify_credential(credential)
