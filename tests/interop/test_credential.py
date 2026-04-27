"""Test full payment cycle: challenge → build credential → submit → get fortune.

This is the core interop test. A Python client builds a Solana transaction
and submits it to a server that may be written in any language (Rust, Go,
Python, TypeScript, Lua). If this test passes, the protocol is interoperable.

Requires Surfpool running on localhost:8899.
"""
from __future__ import annotations

import base64
import json
import struct

import httpx
import pytest
from solders.hash import Hash as SolanaHash  # type: ignore[import-untyped]
from solders.instruction import AccountMeta, Instruction  # type: ignore[import-untyped]
from solders.keypair import Keypair  # type: ignore[import-untyped]
from solders.message import Message  # type: ignore[import-untyped]
from solders.pubkey import Pubkey  # type: ignore[import-untyped]
from solders.system_program import ID as SYSTEM_PROGRAM_ID  # type: ignore[import-untyped]
from solders.transaction import Transaction  # type: ignore[import-untyped]

from conftest import base64url_decode, base64url_encode, parse_www_authenticate

SYSTEM_PROGRAM = "11111111111111111111111111111111"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
COMPUTE_BUDGET = Pubkey.from_string("ComputeBudget111111111111111111111111111111")


def build_compute_budget_instructions() -> list[Instruction]:
    """Build SetComputeUnitPrice + SetComputeUnitLimit instructions."""
    # SetComputeUnitPrice (discriminator 3, value 1 as u64 LE)
    price_data = bytes([3]) + (1).to_bytes(8, "little")
    price_ix = Instruction(COMPUTE_BUDGET, bytes(price_data), [])

    # SetComputeUnitLimit (discriminator 2, value 200000 as u32 LE)
    limit_data = bytes([2]) + (200_000).to_bytes(4, "little")
    limit_ix = Instruction(COMPUTE_BUDGET, bytes(limit_data), [])

    return [price_ix, limit_ix]


def rpc_call(rpc_url: str, method: str, params: list) -> dict:
    resp = httpx.post(rpc_url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    data = resp.json()
    if "error" in data:
        raise RuntimeError(f"{method}: {data['error']}")
    return data.get("result", {})


def fund_account(rpc_url: str, address: str, lamports: int = 1_000_000_000) -> None:
    """Fund an account via surfpool cheatcode."""
    rpc_call(rpc_url, "surfnet_setAccount", [
        address,
        {"lamports": lamports, "data": "", "executable": False, "owner": SYSTEM_PROGRAM, "rentEpoch": 0},
    ])


def fund_token_account(rpc_url: str, owner: str, mint: str, amount: int, token_program: str = TOKEN_PROGRAM) -> None:
    """Create/fund a token account via surfpool cheatcode."""
    rpc_call(rpc_url, "surfnet_setTokenAccount", [owner, mint, {"amount": amount, "state": "initialized"}, token_program])


def get_ata(owner: Pubkey, mint: Pubkey, token_program: Pubkey) -> Pubkey:
    """Derive the associated token address."""
    ata_program = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    seeds = [bytes(owner), bytes(token_program), bytes(mint)]
    ata, _bump = Pubkey.find_program_address(seeds, ata_program)
    return ata


def build_sol_transfer(from_key: Pubkey, to_key: Pubkey, lamports: int) -> Instruction:
    """Build a System Program transfer instruction."""
    data = struct.pack("<I", 2) + struct.pack("<Q", lamports)  # instruction 2 = Transfer
    return Instruction(
        SYSTEM_PROGRAM_ID,
        bytes(data),
        [AccountMeta(from_key, True, True), AccountMeta(to_key, False, True)],
    )


def build_token_transfer_checked(
    source_ata: Pubkey, mint: Pubkey, dest_ata: Pubkey, authority: Pubkey,
    amount: int, decimals: int, token_program: Pubkey,
) -> Instruction:
    """Build an SPL Token transferChecked instruction."""
    data = bytes([12]) + struct.pack("<Q", amount) + bytes([decimals])
    return Instruction(
        token_program,
        bytes(data),
        [
            AccountMeta(source_ata, False, True),
            AccountMeta(mint, False, False),
            AccountMeta(dest_ata, False, True),
            AccountMeta(authority, True, False),
        ],
    )


def test_full_payment_cycle_sol(client: httpx.Client, fortune_path: str, rpc_url: str, test_keypair: Keypair) -> None:
    """Test full SOL payment: get challenge, build tx, submit credential, get fortune."""
    # 1. Get challenge
    resp = client.get(fortune_path)
    assert resp.status_code == 402
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    request_data = json.loads(base64url_decode(challenge["request"]))

    # Skip if not SOL (some servers charge USDC)
    currency = request_data.get("currency", "sol")
    md = request_data.get("methodDetails", {})
    is_sol = currency.lower() == "sol"

    if not is_sol:
        pytest.skip("Server charges token, not SOL — covered by test_full_payment_cycle_token")

    amount = int(request_data["amount"])
    recipient = request_data["recipient"]

    # 2. Fund test keypair
    fund_account(rpc_url, str(test_keypair.pubkey()), amount + 100_000_000)

    # 3. Build transaction
    blockhash_str = md.get("recentBlockhash")
    if not blockhash_str:
        bh_result = rpc_call(rpc_url, "getLatestBlockhash", [{"commitment": "confirmed"}])
        blockhash_str = bh_result["value"]["blockhash"]
    blockhash = SolanaHash.from_string(blockhash_str)

    recipient_key = Pubkey.from_string(recipient)
    transfer_ix = build_sol_transfer(test_keypair.pubkey(), recipient_key, amount)

    instructions = build_compute_budget_instructions() + [transfer_ix]

    has_fee_payer = md.get("feePayer") is True and md.get("feePayerKey")
    if has_fee_payer:
        fee_payer_key = Pubkey.from_string(md["feePayerKey"])
        msg = Message.new_with_blockhash(instructions, fee_payer_key, blockhash)
    else:
        msg = Message.new_with_blockhash(instructions, test_keypair.pubkey(), blockhash)

    tx = Transaction.new_unsigned(msg)
    if has_fee_payer:
        tx.partial_sign([test_keypair], blockhash)
    else:
        tx.sign([test_keypair], blockhash)

    tx_bytes = bytes(tx)
    tx_b64 = base64.b64encode(tx_bytes).decode()

    # 4. Build credential
    credential = {
        "challenge": {
            "id": challenge["id"],
            "realm": challenge["realm"],
            "method": challenge["method"],
            "intent": challenge["intent"],
            "request": challenge["request"],
        },
        "payload": {"type": "transaction", "transaction": tx_b64},
    }
    if "expires" in challenge:
        credential["challenge"]["expires"] = challenge["expires"]
    if "description" in challenge:
        credential["challenge"]["description"] = challenge["description"]

    auth_header = f"Payment {base64url_encode(json.dumps(credential).encode())}"

    # 5. Submit
    resp = client.get(fortune_path, headers={"Authorization": auth_header})
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text[:200]}"

    # 6. Verify fortune response
    data = resp.json()
    assert "fortune" in data


def test_full_payment_cycle_token(client: httpx.Client, fortune_path: str, rpc_url: str, test_keypair: Keypair) -> None:
    """Test full USDC payment: get challenge, fund token account, build tx, submit, get fortune."""
    # 1. Get challenge
    resp = client.get(fortune_path)
    assert resp.status_code == 402
    challenge = parse_www_authenticate(resp.headers["www-authenticate"])
    request_data = json.loads(base64url_decode(challenge["request"]))

    currency = request_data.get("currency", "sol")
    if currency.lower() == "sol":
        pytest.skip("Server charges SOL — covered by test_full_payment_cycle_sol")

    md = request_data.get("methodDetails", {})
    amount = int(request_data["amount"])
    recipient = request_data["recipient"]
    decimals = md.get("decimals", 6)
    token_prog_str = md.get("tokenProgram", TOKEN_PROGRAM)
    token_prog = Pubkey.from_string(token_prog_str)
    mint = Pubkey.from_string(currency)

    # 2. Fund test keypair with SOL (for fees) + token
    fund_account(rpc_url, str(test_keypair.pubkey()))
    fund_token_account(rpc_url, str(test_keypair.pubkey()), currency, amount, token_prog_str)
    # Ensure recipient has a token account
    fund_token_account(rpc_url, recipient, currency, 0, token_prog_str)

    # 3. Build transaction
    blockhash_str = md.get("recentBlockhash")
    if not blockhash_str:
        bh_result = rpc_call(rpc_url, "getLatestBlockhash", [{"commitment": "confirmed"}])
        blockhash_str = bh_result["value"]["blockhash"]
    blockhash = SolanaHash.from_string(blockhash_str)

    has_fee_payer = md.get("feePayer") is True and md.get("feePayerKey")
    if has_fee_payer:
        fee_payer_key = Pubkey.from_string(md["feePayerKey"])
    else:
        fee_payer_key = None

    source_ata = get_ata(test_keypair.pubkey(), mint, token_prog)
    recipient_key = Pubkey.from_string(recipient)
    dest_ata = get_ata(recipient_key, mint, token_prog)

    # Build instruction list: compute budget, then transferChecked.
    instructions = build_compute_budget_instructions()

    instructions.append(
        build_token_transfer_checked(source_ata, mint, dest_ata, test_keypair.pubkey(), amount, decimals, token_prog)
    )

    if has_fee_payer:
        msg = Message.new_with_blockhash(instructions, fee_payer_key, blockhash)
    else:
        msg = Message.new_with_blockhash(instructions, test_keypair.pubkey(), blockhash)

    tx = Transaction.new_unsigned(msg)
    if has_fee_payer:
        tx.partial_sign([test_keypair], blockhash)
    else:
        tx.sign([test_keypair], blockhash)

    tx_bytes = bytes(tx)
    tx_b64 = base64.b64encode(tx_bytes).decode()

    # 4. Build credential
    credential = {
        "challenge": {
            "id": challenge["id"],
            "realm": challenge["realm"],
            "method": challenge["method"],
            "intent": challenge["intent"],
            "request": challenge["request"],
        },
        "payload": {"type": "transaction", "transaction": tx_b64},
    }
    if "expires" in challenge:
        credential["challenge"]["expires"] = challenge["expires"]
    if "description" in challenge:
        credential["challenge"]["description"] = challenge["description"]

    auth_header = f"Payment {base64url_encode(json.dumps(credential).encode())}"

    # 5. Submit
    resp = client.get(fortune_path, headers={"Authorization": auth_header})
    assert resp.status_code == 200, f"Expected 200, got {resp.status_code}: {resp.text[:200]}"

    # 6. Verify fortune and receipt
    data = resp.json()
    assert "fortune" in data
