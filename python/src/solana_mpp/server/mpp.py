"""Main server-side Solana charge handler."""

from __future__ import annotations

import logging
import base64
import json
from dataclasses import dataclass, field
from typing import Any

from solana_mpp._base64url import encode_json
from solana_mpp._errors import (
    ChallengeExpiredError,
    ChallengeMismatchError,
    PaymentError,
    ReplayError,
)
from solana_mpp._types import PaymentChallenge, PaymentCredential, Receipt
from solana_mpp.protocol.intents import ChargeRequest, parse_units
from solana_mpp.protocol.solana import CredentialPayload, MethodDetails, default_rpc_url, is_native_sol, resolve_mint
from solana_mpp.server.network_check import check_network_blockhash
from solana_mpp.store import MemoryStore, Store

logger = logging.getLogger(__name__)

_DEFAULT_REALM = "MPP Payment"
_SECRET_KEY_ENV_VAR = "MPP_SECRET_KEY"
_CONSUMED_PREFIX = "solana-charge:consumed:"


def _build_expected_transfers(request: ChargeRequest, details: MethodDetails) -> list[tuple[str, int]]:
    total_amount = int(request.amount)
    split_total = sum(int(split.amount) for split in details.splits)
    primary_amount = total_amount - split_total
    if primary_amount <= 0:
        raise PaymentError(
            "splits consume the entire amount — primary recipient must receive a positive amount",
            code="splits-exceed-amount",
        )

    expected = [(request.recipient, primary_amount)]
    for split in details.splits:
        expected.append((split.recipient, int(split.amount)))
    return expected


def _verify_parsed_sol_transfers(instructions: list[dict[str, Any]], request: ChargeRequest, details: MethodDetails) -> None:
    expected = _build_expected_transfers(request, details)
    transfers = [
        instruction
        for instruction in instructions
        if instruction.get("program") == "system" and (instruction.get("parsed") or {}).get("type") == "transfer"
    ]

    for recipient, amount in expected:
        match_index = next(
            (
                index
                for index, transfer in enumerate(transfers)
                if ((transfer.get("parsed") or {}).get("info") or {}).get("destination") == recipient
                and str(((transfer.get("parsed") or {}).get("info") or {}).get("lamports")) == str(amount)
            ),
            -1,
        )
        if match_index == -1:
            raise PaymentError(f"no matching SOL transfer for {recipient}", code="no-transfer")
        transfers.pop(match_index)


def _verify_parsed_spl_transfers(
    instructions: list[dict[str, Any]],
    request: ChargeRequest,
    details: MethodDetails,
    fetch_token_account,
) -> None:
    if fetch_token_account is None:
        raise PaymentError("fetch_token_account callback is required", code="invalid-payload-type")

    expected = _build_expected_transfers(request, details)
    program_id = details.token_program or "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    mint = resolve_mint(request.currency, details.network)
    transfers = [
        instruction
        for instruction in instructions
        if instruction.get("programId") == program_id
        and (instruction.get("parsed") or {}).get("type") == "transferChecked"
    ]

    for recipient, amount in expected:
        match_index = next(
            (
                index
                for index, transfer in enumerate(transfers)
                if ((transfer.get("parsed") or {}).get("info") or {}).get("mint") == mint
                and str((((transfer.get("parsed") or {}).get("info") or {}).get("tokenAmount") or {}).get("amount"))
                == str(amount)
                and _token_account_matches(
                    fetch_token_account(((transfer.get("parsed") or {}).get("info") or {}).get("destination")),
                    recipient,
                    mint,
                )
            ),
            -1,
        )
        if match_index == -1:
            raise PaymentError(f"no matching token transfer for {recipient}", code="no-transfer")
        transfers.pop(match_index)


def _token_account_matches(account: Any, recipient: str, mint: str) -> bool:
    if not account:
        return False
    owner = account.get("owner") if isinstance(account, dict) else getattr(account, "owner", None)
    account_mint = account.get("mint") if isinstance(account, dict) else getattr(account, "mint", None)
    return owner == recipient and account_mint == mint


def _rpc_value(response: Any) -> Any:
    if response is None:
        return None
    if isinstance(response, dict):
        return response.get("value", response)
    return getattr(response, "value", response)


def _json_like(value: Any) -> Any:
    if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "to_json"):
        return json.loads(value.to_json())
    if hasattr(value, "__dict__"):
        return {key: _json_like(val) for key, val in vars(value).items()}
    return value


def _transaction_dict(response: Any) -> dict[str, Any] | None:
    value = _rpc_value(response)
    if value is None:
        return None
    data = _json_like(value)
    if isinstance(data, dict) and "transaction" in data:
        return data
    return None


def _status_ok(response: Any) -> bool:
    value = _rpc_value(response)
    data = _json_like(value)
    if isinstance(data, list):
        for entry in data:
            if entry and entry.get("err") is None:
                return True
        return False
    return data is not None


def _extract_recent_blockhash(transaction_b64: str) -> str:
    """Decode a base64 transaction and return its recent blockhash (base58).

    Tries the legacy ``Transaction`` first (the most common shape from our
    SDK clients) and falls back to ``VersionedTransaction``. Kept thin so
    the surrounding network check can be exercised by tests without a full
    verification pipeline in place.
    """
    import base64

    from solders.transaction import Transaction, VersionedTransaction

    raw = base64.b64decode(transaction_b64)
    try:
        tx = Transaction.from_bytes(raw)
        return str(tx.message.recent_blockhash)
    except Exception:
        vtx = VersionedTransaction.from_bytes(raw)
        return str(vtx.message.recent_blockhash)


@dataclass
class ChargeOptions:
    """Options for charge challenge generation."""

    description: str = ""
    external_id: str = ""
    expires: str = ""
    fee_payer: bool = False
    splits: list[dict] = field(default_factory=list)


@dataclass
class Config:
    """Server-side configuration."""

    recipient: str = ""
    currency: str = "USDC"
    decimals: int = 6
    network: str = "mainnet-beta"
    rpc_url: str = ""
    secret_key: str = ""
    realm: str = ""
    html: bool = False
    fee_payer_signer: Any = None
    store: Store | None = None
    rpc: Any = None  # solana.rpc.async_api.AsyncClient


class Mpp:
    """Server-side Solana charge handler.

    Follows the same logic as the Go server.go implementation.
    """

    def __init__(self, config: Config) -> None:
        if not config.recipient or not config.recipient.strip():
            raise PaymentError("recipient is required", code="invalid-config")

        import os

        secret_key = config.secret_key or os.environ.get(_SECRET_KEY_ENV_VAR, "")
        if not secret_key:
            raise PaymentError("missing secret key", code="invalid-config")

        self._secret_key = secret_key
        self._realm = config.realm or _DEFAULT_REALM
        self._recipient = config.recipient
        self._currency = config.currency or "USDC"
        self._decimals = config.decimals or 6
        self._network = config.network or "mainnet-beta"
        self._rpc_url = config.rpc_url or default_rpc_url(self._network)
        self._html = config.html
        self._fee_payer_signer = config.fee_payer_signer
        self._store: Store = config.store or MemoryStore()
        self._rpc = config.rpc

    @property
    def realm(self) -> str:
        return self._realm

    @property
    def rpc_url(self) -> str:
        return self._rpc_url

    @property
    def html_enabled(self) -> bool:
        return self._html

    def charge(self, amount: str) -> PaymentChallenge:
        """Create a charge challenge from a human-readable amount."""
        return self.charge_with_options(amount, ChargeOptions())

    def charge_with_options(self, amount: str, options: ChargeOptions) -> PaymentChallenge:
        """Create a charge challenge with optional fields."""
        base_units = parse_units(amount, self._decimals)

        details: dict[str, Any] = {"network": self._network}
        if not is_native_sol(self._currency):
            details["decimals"] = self._decimals
        if options.fee_payer or self._fee_payer_signer is not None:
            details["feePayer"] = True
            if self._fee_payer_signer is not None:
                details["feePayerKey"] = str(self._fee_payer_signer.pubkey())
        if options.splits:
            details["splits"] = options.splits

        request_obj: dict[str, Any] = {
            "amount": base_units,
            "currency": self._currency,
            "recipient": self._recipient,
        }
        if options.description:
            request_obj["description"] = options.description
        if options.external_id:
            request_obj["externalId"] = options.external_id
        if details:
            request_obj["methodDetails"] = details

        request_b64 = encode_json(request_obj)

        from solana_mpp._expires import minutes

        default_expires = minutes(5)
        return PaymentChallenge.with_secret_key(
            secret_key=self._secret_key,
            realm=self._realm,
            method="solana",
            intent="charge",
            request=request_b64,
            expires=options.expires or default_expires,
            description=options.description,
        )

    async def verify_credential(self, credential: PaymentCredential) -> Receipt:
        """Verify either a transaction or signature credential payload."""
        # Reconstruct challenge from echo
        challenge = PaymentChallenge(
            id=credential.challenge.id,
            realm=credential.challenge.realm,
            method=credential.challenge.method,
            intent=credential.challenge.intent,
            request=credential.challenge.request,
            expires=credential.challenge.expires,
            digest=credential.challenge.digest,
            opaque=credential.challenge.opaque,
        )

        if not challenge.verify(self._secret_key):
            raise ChallengeMismatchError()

        if challenge.is_expired():
            raise ChallengeExpiredError(f"challenge expired at {challenge.expires}")

        # Decode the request
        request = ChargeRequest.from_dict(challenge.decode_request())

        # Parse method details
        details = MethodDetails()
        if request.method_details:
            details = MethodDetails.from_dict(request.method_details)

        # Parse credential payload
        payload = CredentialPayload.from_dict(credential.payload)

        if payload.type == "transaction":
            return await self._verify_transaction(credential, request, details, payload)
        elif payload.type == "signature":
            if details.fee_payer:
                raise PaymentError(
                    'type="signature" credentials cannot be used with fee sponsorship',
                    code="invalid-payload-type",
                )
            return await self._verify_signature(credential, request, details, payload)
        else:
            raise PaymentError("missing or invalid payload type", code="invalid-payload-type")

    async def _verify_transaction(
        self,
        credential: PaymentCredential,
        request: ChargeRequest,
        details: MethodDetails,
        payload: CredentialPayload,
    ) -> Receipt:
        """Verify a pull-mode transaction credential."""
        if not payload.transaction:
            raise PaymentError("missing transaction data in credential payload", code="missing-transaction")
        if self._rpc is None:
            raise PaymentError("rpc client is required for transaction verification", code="invalid-config")
        if details.fee_payer:
            raise PaymentError(
                'type="transaction" with fee sponsorship is not yet supported in python',
                code="invalid-payload-type",
            )

        # Reject up-front if the client signed against the wrong network
        # (e.g. mainnet keypair pointed at a sandbox-configured server, or
        # vice versa). Cheaper and clearer than letting the broadcast fail.
        # Done here in the entry path so it runs even while the rest of the
        # pipeline below is still a stub.
        try:
            blockhash_b58 = _extract_recent_blockhash(payload.transaction)
        except Exception as exc:  # noqa: BLE001 — propagate decode failures as invalid payload
            raise PaymentError(
                f"could not decode transaction to read blockhash: {exc}",
                code="invalid-payload-type",
            ) from exc
        check_network_blockhash(self._network, blockhash_b58)

        # Decode and process the transaction
        # In a real implementation, this would use solders to deserialize,
        # optionally co-sign, simulate, send, confirm, and verify on-chain.
        # For now we provide the verification skeleton.

        # Replay protection
        consumed_key = _CONSUMED_PREFIX + payload.transaction[:64]
        inserted = await self._store.put_if_absent(consumed_key, True)
        if not inserted:
            raise ReplayError()

        try:
            raw_tx = base64.b64decode(payload.transaction)
            send_resp = await self._rpc.send_raw_transaction(raw_tx)
            signature = str(_rpc_value(send_resp))
            from solders.signature import Signature

            sig = Signature.from_string(signature)
            status_resp = await self._rpc.confirm_transaction(sig)
            if not _status_ok(status_resp):
                raise PaymentError("transaction not confirmed", code="transaction-not-found")

            tx_resp = await self._rpc.get_transaction(sig, encoding="jsonParsed", max_supported_transaction_version=0)
            tx = _transaction_dict(tx_resp)
            if tx is None:
                raise PaymentError("transaction not found or not yet confirmed", code="transaction-not-found")
            self._verify_confirmed_transaction(tx, request, details)
            return Receipt.success(
                method="solana",
                reference=signature,
                challenge_id=credential.challenge.id,
                external_id=request.external_id,
            )
        except Exception:
            await self._store.delete(consumed_key)
            raise

    async def _verify_signature(
        self,
        credential: PaymentCredential,
        request: ChargeRequest,
        details: MethodDetails,
        payload: CredentialPayload,
    ) -> Receipt:
        """Verify a push-mode signature credential."""
        if not payload.signature:
            raise PaymentError("missing signature in credential payload", code="missing-signature")
        if self._rpc is None:
            raise PaymentError("rpc client is required for signature verification", code="invalid-config")

        consumed_key = _CONSUMED_PREFIX + payload.signature
        inserted = await self._store.put_if_absent(consumed_key, True)
        if not inserted:
            raise ReplayError()

        try:
            from solders.signature import Signature

            sig = Signature.from_string(payload.signature)
            tx_resp = await self._rpc.get_transaction(sig, encoding="jsonParsed", max_supported_transaction_version=0)
            tx = _transaction_dict(tx_resp)
            if tx is None:
                raise PaymentError("transaction not found or not yet confirmed", code="transaction-not-found")
            self._verify_confirmed_transaction(tx, request, details)

            return Receipt.success(
                method="solana",
                reference=payload.signature,
                challenge_id=credential.challenge.id,
                external_id=request.external_id,
            )
        except Exception:
            await self._store.delete(consumed_key)
            raise

    def _verify_confirmed_transaction(self, tx: dict[str, Any], request: ChargeRequest, details: MethodDetails) -> None:
        meta = tx.get("meta") or {}
        if meta.get("err") is not None:
            raise PaymentError(f"transaction failed on-chain: {meta['err']}", code="transaction-failed")

        instructions = ((tx.get("transaction") or {}).get("message") or {}).get("instructions") or []
        if is_native_sol(request.currency):
            _verify_parsed_sol_transfers(instructions, request, details)
        else:
            _verify_parsed_spl_transfers(
                instructions,
                request,
                details,
                getattr(self._rpc, "get_token_account", None),
            )
