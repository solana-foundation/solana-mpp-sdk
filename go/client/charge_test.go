package client

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"

	"github.com/solana-foundation/mpp-sdk/go"
	"github.com/solana-foundation/mpp-sdk/go/internal/solanautil"
	"github.com/solana-foundation/mpp-sdk/go/internal/testutil"
	"github.com/solana-foundation/mpp-sdk/go/protocol"
)

func TestBuildChargeTransactionSOLPull(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "transaction" || payload.Transaction == "" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(tx.Message.Instructions) != 3 {
		t.Fatalf("expected 3 instructions, got %d", len(tx.Message.Instructions))
	}
	if tx.Signatures[0].IsZero() {
		t.Fatal("expected signer signature to be populated")
	}
}

func TestBuildChargeTransactionSOLPush(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{}, BuildOptions{Broadcast: true})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "signature" || payload.Signature == "" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestBuildChargeTransactionWithFeePayer(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	feePayer := testutil.NewPrivateKey().PublicKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	enabled := true

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{
		FeePayer:    &enabled,
		FeePayerKey: feePayer.String(),
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if tx.Message.AccountKeys[0] != feePayer {
		t.Fatalf("expected fee payer to be first account, got %s", tx.Message.AccountKeys[0])
	}
	if len(tx.Signatures) != 2 {
		t.Fatalf("expected partial signatures for fee payer flow, got %d", len(tx.Signatures))
	}
}

func TestBuildChargeTransactionTokenPull(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	mint := testutil.NewPrivateKey().PublicKey()
	rpcClient.MintOwners[mint.String()] = solana.TokenProgramID
	decimals := uint8(6)

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", mint.String(), recipient, protocol.MethodDetails{
		Decimals: &decimals,
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(tx.Message.Instructions) != 4 {
		t.Fatalf("expected 4 instructions, got %d", len(tx.Message.Instructions))
	}
}

func TestBuildChargeTransactionSOLWithSplits(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	split1 := testutil.NewPrivateKey().PublicKey().String()
	split2 := testutil.NewPrivateKey().PublicKey().String()

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{
		Splits: []protocol.Split{
			{Recipient: split1, Amount: "100"},
			{Recipient: split2, Amount: "200"},
		},
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	// 2 compute budget + 1 primary + 2 splits = 5
	if len(tx.Message.Instructions) != 5 {
		t.Fatalf("expected 5 instructions, got %d", len(tx.Message.Instructions))
	}
}

func TestBuildChargeTransactionToken2022(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	mint := testutil.NewPrivateKey().PublicKey()
	rpcClient.MintOwners[mint.String()] = solana.MustPublicKeyFromBase58(protocol.Token2022Program)
	decimals := uint8(6)

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", mint.String(), recipient, protocol.MethodDetails{
		Decimals: &decimals,
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "transaction" || payload.Transaction == "" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestBuildChargeTransactionInvalidRecipient(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	if _, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", "not-a-key", protocol.MethodDetails{}, BuildOptions{}); err == nil {
		t.Fatal("expected error for invalid recipient")
	}
}

func TestBuildChargeTransactionInvalidAmount(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	if _, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "not-a-number", "sol", recipient, protocol.MethodDetails{}, BuildOptions{}); err == nil {
		t.Fatal("expected error for invalid amount")
	}
}

func TestBuildChargeTransactionWithCustomComputeUnits(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{}, BuildOptions{
		ComputeUnitLimit: 400_000,
		ComputeUnitPrice: 100,
	})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "transaction" || payload.Transaction == "" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestBuildChargeTransactionBroadcastWithFeePayer(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	enabled := true
	feePayer := testutil.NewPrivateKey().PublicKey()

	// Broadcast mode with feePayer should error
	_, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{
		FeePayer:    &enabled,
		FeePayerKey: feePayer.String(),
	}, BuildOptions{Broadcast: true})
	if err == nil {
		t.Fatal("expected error for broadcast + fee payer")
	}
}

func TestBuildChargeTransactionTokenWithSplits(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	splitRecipient := testutil.NewPrivateKey().PublicKey().String()
	mint := testutil.NewPrivateKey().PublicKey()
	rpcClient.MintOwners[mint.String()] = solana.TokenProgramID
	decimals := uint8(6)

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", mint.String(), recipient, protocol.MethodDetails{
		Decimals: &decimals,
		Splits:   []protocol.Split{{Recipient: splitRecipient, Amount: "200"}},
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	// 2 compute budget + 2 (create ATA + transfer) for primary + 2 for split = 6
	if len(tx.Message.Instructions) != 6 {
		t.Fatalf("expected 6 instructions, got %d", len(tx.Message.Instructions))
	}
}

func TestBuildChargeTransactionTokenWithFeePayer(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	feePayer := testutil.NewPrivateKey().PublicKey()
	mint := testutil.NewPrivateKey().PublicKey()
	rpcClient.MintOwners[mint.String()] = solana.TokenProgramID
	decimals := uint8(6)
	enabled := true

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", mint.String(), recipient, protocol.MethodDetails{
		Decimals:    &decimals,
		FeePayer:    &enabled,
		FeePayerKey: feePayer.String(),
	}, BuildOptions{})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	// Fee payer should be first account key
	if tx.Message.AccountKeys[0] != feePayer {
		t.Fatalf("expected fee payer as first account, got %s", tx.Message.AccountKeys[0])
	}
}

func TestBuildChargeTransactionSOLBroadcast(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{}, BuildOptions{Broadcast: true})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "signature" {
		t.Fatalf("expected signature type, got %q", payload.Type)
	}
	if payload.Signature == "" {
		t.Fatal("expected non-empty signature")
	}
}

func TestBuildChargeTransactionInvalidSplitRecipient(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	if _, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{
		Splits: []protocol.Split{{Recipient: "bad-key", Amount: "100"}},
	}, BuildOptions{}); err == nil {
		t.Fatal("expected error for invalid split recipient")
	}
}

func TestBuildChargeTransactionInvalidSplitAmount(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	if _, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", "sol", recipient, protocol.MethodDetails{
		Splits: []protocol.Split{{Recipient: testutil.NewPrivateKey().PublicKey().String(), Amount: "abc"}},
	}, BuildOptions{}); err == nil {
		t.Fatal("expected error for invalid split amount")
	}
}

func TestBuildCredentialHeaderRoundTrip(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	challengeRequest, _ := mpp.NewBase64URLJSONValue(map[string]any{
		"amount":        "1000",
		"currency":      "sol",
		"recipient":     testutil.NewPrivateKey().PublicKey().String(),
		"methodDetails": map[string]any{"network": "localnet"},
	})
	challenge := mpp.NewChallengeWithSecret("secret", "realm", "solana", "charge", challengeRequest)

	header, err := BuildCredentialHeader(context.Background(), signer, rpcClient, challenge)
	if err != nil {
		t.Fatalf("header failed: %v", err)
	}
	credential, err := mpp.ParseAuthorization(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if credential.Challenge.ID != challenge.ID {
		t.Fatalf("unexpected credential: %#v", credential)
	}
}

func TestBuildCredentialHeaderInvalidRequest(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	// Create a challenge with invalid request JSON
	badRequest := mpp.NewBase64URLJSONRaw("!!!invalid!!!")
	challenge := mpp.PaymentChallenge{
		ID:      "test-id",
		Realm:   "realm",
		Method:  "solana",
		Intent:  "charge",
		Request: badRequest,
	}
	if _, err := BuildCredentialHeader(context.Background(), signer, rpcClient, challenge); err == nil {
		t.Fatal("expected error for invalid request")
	}
}

func TestBuildChargeTransactionTokenBroadcast(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	recipient := testutil.NewPrivateKey().PublicKey().String()
	mint := testutil.NewPrivateKey().PublicKey()
	rpcClient.MintOwners[mint.String()] = solana.TokenProgramID
	decimals := uint8(6)

	payload, err := BuildChargeTransaction(context.Background(), signer, rpcClient, "1000", mint.String(), recipient, protocol.MethodDetails{
		Decimals: &decimals,
	}, BuildOptions{Broadcast: true})
	if err != nil {
		t.Fatalf("build failed: %v", err)
	}
	if payload.Type != "signature" {
		t.Fatalf("expected signature type, got %q", payload.Type)
	}
}

func TestBuildCredentialHeaderWithOptions(t *testing.T) {
	rpcClient := testutil.NewFakeRPC()
	signer := testutil.NewPrivateKey()
	challengeRequest, _ := mpp.NewBase64URLJSONValue(map[string]any{
		"amount":        "1000",
		"currency":      "sol",
		"recipient":     testutil.NewPrivateKey().PublicKey().String(),
		"methodDetails": map[string]any{"network": "localnet"},
	})
	challenge := mpp.NewChallengeWithSecret("secret", "realm", "solana", "charge", challengeRequest)

	header, err := BuildCredentialHeaderWithOptions(context.Background(), signer, rpcClient, challenge, BuildOptions{
		ComputeUnitLimit: 300_000,
		ComputeUnitPrice: 50,
	})
	if err != nil {
		t.Fatalf("header failed: %v", err)
	}
	if header == "" {
		t.Fatal("expected non-empty header")
	}
}
