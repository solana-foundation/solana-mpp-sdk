"""Tests for server/mpp module."""

from __future__ import annotations

import pytest

import solana_mpp.server.mpp as server_mpp
from solana_mpp._errors import ChallengeExpiredError, ChallengeMismatchError, PaymentError, ReplayError
from solana_mpp._types import ChallengeEcho, PaymentCredential
from solana_mpp.protocol.intents import ChargeRequest
from solana_mpp.protocol.solana import MethodDetails, Split
from solana_mpp.server.mpp import (
    ChargeOptions,
    Config,
    Mpp,
    _verify_parsed_sol_transfers,
    _verify_parsed_spl_transfers,
)

TEST_SECRET = "test-secret-key-that-is-long-enough-for-hmac-sha256"
TEST_RECIPIENT = "11111111111111111111111111111112"


class FakeResponse:
    def __init__(self, value):
        self.value = value


class FakeRPC:
    def __init__(self, tx=None, send_value="sig-123", statuses=None, token_accounts=None):
        self.tx = tx
        self.send_value = send_value
        self.statuses = statuses if statuses is not None else [{"err": None}]
        self.token_accounts = token_accounts or {}
        self.sent = []

    async def get_transaction(self, *_args, **_kwargs):
        return FakeResponse(self.tx)

    async def send_raw_transaction(self, raw: bytes):
        self.sent.append(raw)
        return FakeResponse(self.send_value)

    async def confirm_transaction(self, *_args, **_kwargs):
        return FakeResponse(self.statuses)

    def get_token_account(self, address: str):
        return self.token_accounts.get(address)


@pytest.fixture
def mpp() -> Mpp:
    rpc = FakeRPC(
        tx={
            "meta": {"err": None},
            "transaction": {
                "message": {
                    "instructions": [
                        {
                            "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                            "parsed": {
                                "type": "transferChecked",
                                "info": {
                                    "destination": "token-account-1",
                                    "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                                    "tokenAmount": {"amount": "1000000"},
                                },
                            },
                        }
                    ]
                }
            },
        },
        token_accounts={"token-account-1": {"owner": TEST_RECIPIENT, "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"}},
    )
    config = Config(
        recipient=TEST_RECIPIENT,
        currency="USDC",
        decimals=6,
        network="devnet",
        secret_key=TEST_SECRET,
        rpc=rpc,
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
            payload={"type": "signature", "signature": "1111111111111111111111111111111111111111111111111111111111111111"},
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

    async def test_signature_verification_fetches_and_checks_transaction(self):
        tx = {
            "meta": {"err": None},
            "transaction": {
                "message": {
                    "instructions": [
                        {
                            "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                            "parsed": {
                                "type": "transferChecked",
                                "info": {
                                    "destination": "token-account-1",
                                    "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
                                    "tokenAmount": {"amount": "1000000"},
                                },
                            },
                        }
                    ]
                }
            },
        }
        rpc = FakeRPC(tx=tx, token_accounts={"token-account-1": {"owner": TEST_RECIPIENT, "mint": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"}})
        mpp = Mpp(
            Config(
                recipient=TEST_RECIPIENT,
                currency="USDC",
                decimals=6,
                network="devnet",
                secret_key=TEST_SECRET,
                rpc=rpc,
            )
        )
        challenge = mpp.charge("1.00")
        credential = PaymentCredential(challenge=challenge.to_echo(), payload={"type": "signature", "signature": "1111111111111111111111111111111111111111111111111111111111111111"})

        receipt = await mpp.verify_credential(credential)
        assert receipt.is_success()
        assert receipt.reference == credential.payload["signature"]

    async def test_transaction_verification_broadcasts_and_checks_transaction(self, monkeypatch: pytest.MonkeyPatch):
        tx = {
            "meta": {"err": None},
            "transaction": {
                "message": {
                    "instructions": [
                        {
                            "program": "system",
                            "parsed": {"type": "transfer", "info": {"destination": TEST_RECIPIENT, "lamports": "1000"}},
                        }
                    ]
                }
            },
        }
        rpc = FakeRPC(tx=tx, send_value="1111111111111111111111111111111111111111111111111111111111111111")
        mpp = Mpp(
            Config(
                recipient=TEST_RECIPIENT,
                currency="SOL",
                decimals=9,
                network="mainnet-beta",
                secret_key=TEST_SECRET,
                rpc=rpc,
            )
        )
        challenge = mpp.charge_with_options("0.000001", ChargeOptions())
        monkeypatch.setattr(server_mpp, "_extract_recent_blockhash", lambda _tx: "4vJ9JU1bJJQpUgJ8V6hYz7xXKz4F2tN6aBrZEcD3xKhs")
        credential = PaymentCredential(
            challenge=challenge.to_echo(),
            payload={"type": "transaction", "transaction": "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="},
        )

        receipt = await mpp.verify_credential(credential)
        assert receipt.is_success()
        assert receipt.reference == "1111111111111111111111111111111111111111111111111111111111111111"
        assert rpc.sent


class TestParsedTransferVerification:
    def test_sol_verifier_rejects_duplicate_split_reuse(self):
        request = ChargeRequest(amount="1000", currency="sol", recipient="recipient-1")
        details = MethodDetails(
            splits=[
                Split(recipient="recipient-2", amount="100"),
                Split(recipient="recipient-2", amount="100"),
            ]
        )
        instructions = [
            {"program": "system", "parsed": {"type": "transfer", "info": {"destination": "recipient-1", "lamports": "800"}}},
            {"program": "system", "parsed": {"type": "transfer", "info": {"destination": "recipient-2", "lamports": "100"}}},
        ]

        with pytest.raises(PaymentError, match="no matching SOL transfer"):
            _verify_parsed_sol_transfers(instructions, request, details)

    def test_sol_verifier_matches_same_recipient_by_amount(self):
        request = ChargeRequest(amount="1000", currency="sol", recipient="recipient-1")
        details = MethodDetails(splits=[Split(recipient="recipient-1", amount="200")])
        instructions = [
            {"program": "system", "parsed": {"type": "transfer", "info": {"destination": "recipient-1", "lamports": "800"}}},
            {"program": "system", "parsed": {"type": "transfer", "info": {"destination": "recipient-1", "lamports": "200"}}},
        ]

        _verify_parsed_sol_transfers(instructions, request, details)

    def test_spl_verifier_rejects_wrong_mint(self):
        request = ChargeRequest(amount="1000", currency="mint-expected", recipient="recipient-1")
        details = MethodDetails(token_program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        instructions = [
            {
                "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "parsed": {
                    "type": "transferChecked",
                    "info": {
                        "destination": "token-account-1",
                        "mint": "mint-wrong",
                        "tokenAmount": {"amount": "1000"},
                    },
                },
            }
        ]

        with pytest.raises(PaymentError, match="no matching token transfer"):
            _verify_parsed_spl_transfers(
                instructions,
                request,
                details,
                lambda _: {"owner": "recipient-1", "mint": "mint-wrong"},
            )

    def test_spl_verifier_matches_same_recipient_by_amount(self):
        request = ChargeRequest(amount="1000", currency="mint-1", recipient="recipient-1")
        details = MethodDetails(
            token_program="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            splits=[Split(recipient="recipient-1", amount="200")],
        )
        instructions = [
            {
                "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "parsed": {
                    "type": "transferChecked",
                    "info": {
                        "destination": "token-account-primary",
                        "mint": "mint-1",
                        "tokenAmount": {"amount": "800"},
                    },
                },
            },
            {
                "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "parsed": {
                    "type": "transferChecked",
                    "info": {
                        "destination": "token-account-split",
                        "mint": "mint-1",
                        "tokenAmount": {"amount": "200"},
                    },
                },
            },
        ]

        def fetch_token_account(address: str):
            if address == "token-account-primary":
                return {"owner": "recipient-1", "mint": "mint-1"}
            if address == "token-account-split":
                return {"owner": "recipient-1", "mint": "mint-1"}
            return None

        _verify_parsed_spl_transfers(instructions, request, details, fetch_token_account)
