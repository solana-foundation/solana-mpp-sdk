"""Solana-specific protocol types and helpers."""

from __future__ import annotations

from dataclasses import dataclass, field

SYSTEM_PROGRAM = "11111111111111111111111111111111"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"


# Mint addresses keyed by currency symbol, then by network.
KNOWN_MINTS: dict[str, dict[str, str]] = {
    "USDC": {
        "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    },
    "PYUSD": {
        "mainnet-beta": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        "devnet": "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
    },
}


def default_rpc_url(network: str) -> str:
    """Return the default RPC endpoint for a Solana network."""
    if network == "devnet":
        return "https://api.devnet.solana.com"
    if network == "localnet":
        return "http://localhost:8899"
    return "https://api.mainnet-beta.solana.com"


def resolve_mint(currency: str, network: str) -> str:
    """Convert a symbolic currency into a mint address.

    Returns empty string for native SOL. Falls back to treating currency
    as a raw mint address if not found in KNOWN_MINTS.
    """
    upper = currency.upper()
    if upper == "SOL":
        return ""
    if upper in KNOWN_MINTS:
        networks = KNOWN_MINTS[upper]
        return networks.get(network, networks.get("mainnet-beta", currency))
    return currency


def is_native_sol(currency: str) -> bool:
    """Return True if the currency represents native SOL."""
    return currency.upper() == "SOL"


@dataclass
class MethodDetails:
    """Solana-specific challenge method details."""

    network: str = "mainnet-beta"
    decimals: int | None = None
    token_program: str | None = None
    fee_payer: bool = False
    fee_payer_key: str = ""
    recent_blockhash: str = ""
    splits: list[Split] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize to a JSON-compatible dict, omitting empty fields."""
        d: dict = {}
        if self.network:
            d["network"] = self.network
        if self.decimals is not None:
            d["decimals"] = self.decimals
        if self.token_program:
            d["tokenProgram"] = self.token_program
        if self.fee_payer:
            d["feePayer"] = self.fee_payer
        if self.fee_payer_key:
            d["feePayerKey"] = self.fee_payer_key
        if self.recent_blockhash:
            d["recentBlockhash"] = self.recent_blockhash
        if self.splits:
            d["splits"] = [s.to_dict() for s in self.splits]
        return d

    @classmethod
    def from_dict(cls, data: dict) -> MethodDetails:
        """Deserialize from a JSON-compatible dict."""
        splits = [Split.from_dict(s) for s in data.get("splits", [])]
        return cls(
            network=data.get("network", "mainnet-beta"),
            decimals=data.get("decimals"),
            token_program=data.get("tokenProgram"),
            fee_payer=data.get("feePayer", False),
            fee_payer_key=data.get("feePayerKey", ""),
            recent_blockhash=data.get("recentBlockhash", ""),
            splits=splits,
        )


@dataclass
class Split:
    """An additional transfer in the same asset."""

    recipient: str
    amount: str
    memo: str = ""

    def to_dict(self) -> dict:
        d: dict = {"recipient": self.recipient, "amount": self.amount}
        if self.memo:
            d["memo"] = self.memo
        return d

    @classmethod
    def from_dict(cls, data: dict) -> Split:
        return cls(
            recipient=data["recipient"],
            amount=data["amount"],
            memo=data.get("memo", ""),
        )


@dataclass
class CredentialPayload:
    """Credential payload sent by clients."""

    type: str  # "transaction" or "signature"
    transaction: str = ""
    signature: str = ""

    def to_dict(self) -> dict:
        d: dict = {"type": self.type}
        if self.transaction:
            d["transaction"] = self.transaction
        if self.signature:
            d["signature"] = self.signature
        return d

    @classmethod
    def from_dict(cls, data: dict) -> CredentialPayload:
        return cls(
            type=data.get("type", ""),
            transaction=data.get("transaction", ""),
            signature=data.get("signature", ""),
        )
