"""Tests for protocol/solana module."""

from __future__ import annotations

from solana_mpp.protocol.solana import (
    ASSOCIATED_TOKEN_PROGRAM,
    SYSTEM_PROGRAM,
    TOKEN_2022_PROGRAM,
    TOKEN_PROGRAM,
    CredentialPayload,
    MethodDetails,
    Split,
    default_rpc_url,
    is_native_sol,
    resolve_mint,
)


class TestDefaultRpcUrl:
    def test_mainnet(self):
        url = default_rpc_url("mainnet-beta")
        assert "mainnet" in url

    def test_devnet(self):
        url = default_rpc_url("devnet")
        assert "devnet" in url

    def test_localnet(self):
        url = default_rpc_url("localnet")
        assert "localhost" in url

    def test_unknown_defaults_to_mainnet(self):
        url = default_rpc_url("unknown")
        assert "mainnet" in url


class TestResolveMint:
    def test_sol_returns_empty(self):
        assert resolve_mint("SOL", "mainnet-beta") == ""
        assert resolve_mint("sol", "mainnet-beta") == ""

    def test_usdc_mainnet(self):
        mint = resolve_mint("USDC", "mainnet-beta")
        assert mint.startswith("EPjFWdd5")

    def test_usdc_devnet(self):
        mint = resolve_mint("USDC", "devnet")
        assert mint.startswith("4zMMC9")

    def test_pyusd_mainnet(self):
        mint = resolve_mint("PYUSD", "mainnet-beta")
        assert mint.startswith("2b1kV6")

    def test_unknown_returns_raw(self):
        assert resolve_mint("SomeCustomMint123", "mainnet-beta") == "SomeCustomMint123"


class TestIsNativeSol:
    def test_sol_variants(self):
        assert is_native_sol("SOL")
        assert is_native_sol("sol")
        assert is_native_sol("Sol")

    def test_non_sol(self):
        assert not is_native_sol("USDC")
        assert not is_native_sol("")


class TestMethodDetails:
    def test_to_dict_minimal(self):
        d = MethodDetails().to_dict()
        assert d["network"] == "mainnet-beta"

    def test_to_dict_full(self):
        details = MethodDetails(
            network="devnet",
            decimals=6,
            token_program=TOKEN_PROGRAM,
            fee_payer=True,
            fee_payer_key="abc",
            recent_blockhash="hash123",
            splits=[Split(recipient="addr", amount="100")],
        )
        d = details.to_dict()
        assert d["network"] == "devnet"
        assert d["decimals"] == 6
        assert d["feePayer"] is True
        assert len(d["splits"]) == 1

    def test_from_dict(self):
        d = {
            "network": "devnet",
            "decimals": 9,
            "feePayer": True,
            "splits": [{"recipient": "addr", "amount": "100"}],
        }
        details = MethodDetails.from_dict(d)
        assert details.network == "devnet"
        assert details.decimals == 9
        assert details.fee_payer is True
        assert len(details.splits) == 1
        assert details.splits[0].recipient == "addr"


class TestCredentialPayload:
    def test_transaction_payload(self):
        p = CredentialPayload(type="transaction", transaction="base64tx")
        d = p.to_dict()
        assert d["type"] == "transaction"
        assert d["transaction"] == "base64tx"
        assert "signature" not in d

    def test_signature_payload(self):
        p = CredentialPayload(type="signature", signature="sig123")
        d = p.to_dict()
        assert d["type"] == "signature"
        assert d["signature"] == "sig123"
        assert "transaction" not in d

    def test_from_dict(self):
        p = CredentialPayload.from_dict({"type": "signature", "signature": "abc"})
        assert p.type == "signature"
        assert p.signature == "abc"


class TestConstants:
    def test_system_program(self):
        assert len(SYSTEM_PROGRAM) == 32

    def test_token_program(self):
        assert TOKEN_PROGRAM.startswith("Token")

    def test_token_2022_program(self):
        assert TOKEN_2022_PROGRAM.startswith("Token")

    def test_associated_token_program(self):
        assert ASSOCIATED_TOKEN_PROGRAM.startswith("AToken")
