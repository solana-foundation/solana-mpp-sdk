package server

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/programs/system"
	"github.com/gagliardetto/solana-go/programs/token"
	token2022 "github.com/gagliardetto/solana-go/programs/token-2022"
	"github.com/gagliardetto/solana-go/rpc"

	"github.com/solana-foundation/mpp-sdk/go"
	"github.com/solana-foundation/mpp-sdk/go/internal/solanautil"
	"github.com/solana-foundation/mpp-sdk/go/protocol"
	"github.com/solana-foundation/mpp-sdk/go/protocol/intents"
)

const (
	defaultRealm    = "MPP Payment"
	secretKeyEnvVar = "MPP_SECRET_KEY"
	consumedPrefix  = "solana-charge:consumed:"
)

// Config controls server-side challenge generation and credential verification.
type Config struct {
	Recipient      string
	Currency       string
	Decimals       uint8
	Network        string
	RPCURL         string
	SecretKey      string
	Realm          string
	HTML           bool
	FeePayerSigner solanautil.Signer
	Store          mpp.Store
	RPC            solanautil.RPCClient
}

// ChargeOptions customize challenge generation.
type ChargeOptions struct {
	Description string
	ExternalID  string
	Expires     string
	FeePayer    bool
	// Splits are additional payment transfers embedded in methodDetails.
	Splits []protocol.Split
}

// Mpp is the server-side Solana charge handler.
type Mpp struct {
	rpc            solanautil.RPCClient
	secretKey      string
	realm          string
	recipient      solana.PublicKey
	currency       string
	decimals       uint8
	network        string
	rpcURL         string
	html           bool
	feePayerSigner solanautil.Signer
	store          mpp.Store
}

// New creates a new server-side handler.
func New(config Config) (*Mpp, error) {
	if strings.TrimSpace(config.Recipient) == "" {
		return nil, mpp.NewError(mpp.ErrCodeInvalidConfig, "recipient is required")
	}
	recipient, err := solana.PublicKeyFromBase58(config.Recipient)
	if err != nil {
		return nil, mpp.WrapError(mpp.ErrCodeInvalidConfig, "invalid recipient pubkey", err)
	}
	if config.SecretKey == "" {
		config.SecretKey = os.Getenv(secretKeyEnvVar)
	}
	if config.SecretKey == "" {
		return nil, mpp.NewError(mpp.ErrCodeInvalidConfig, "missing secret key")
	}
	if config.Currency == "" {
		config.Currency = "USDC"
	}
	if config.Decimals == 0 {
		config.Decimals = 6
	}
	if config.Network == "" {
		config.Network = "mainnet-beta"
	}
	if config.Realm == "" {
		config.Realm = DetectRealm()
	}
	rpcURL := config.RPCURL
	if rpcURL == "" {
		rpcURL = protocol.DefaultRPCURL(config.Network)
	}
	if config.RPC == nil {
		config.RPC = rpc.New(rpcURL)
	}
	if config.Store == nil {
		config.Store = mpp.NewMemoryStore()
	}
	return &Mpp{
		rpc:            config.RPC,
		secretKey:      config.SecretKey,
		realm:          config.Realm,
		recipient:      recipient,
		currency:       config.Currency,
		decimals:       config.Decimals,
		network:        config.Network,
		rpcURL:         rpcURL,
		html:           config.HTML,
		feePayerSigner: config.FeePayerSigner,
		store:          config.Store,
	}, nil
}

// Charge creates a charge challenge from a human-readable amount.
func (m *Mpp) Charge(ctx context.Context, amount string) (mpp.PaymentChallenge, error) {
	return m.ChargeWithOptions(ctx, amount, ChargeOptions{})
}

// ChargeWithOptions creates a challenge with optional fields.
func (m *Mpp) ChargeWithOptions(ctx context.Context, amount string, options ChargeOptions) (mpp.PaymentChallenge, error) {
	baseUnits, err := intents.ParseUnits(amount, m.decimals)
	if err != nil {
		return mpp.PaymentChallenge{}, err
	}
	details := protocol.MethodDetails{
		Network: m.network,
	}
	if !isNativeSOL(m.currency) {
		details.Decimals = &m.decimals
		if protocol.StablecoinSymbol(m.currency) != "" {
			details.TokenProgram = protocol.DefaultTokenProgramForCurrency(m.currency, m.network)
		}
	}
	if options.FeePayer || m.feePayerSigner != nil {
		enabled := true
		details.FeePayer = &enabled
		if m.feePayerSigner != nil {
			details.FeePayerKey = m.feePayerSigner.PublicKey().String()
		}
	}
	if len(options.Splits) > 0 {
		details.Splits = options.Splits
	}
	if out, err := m.rpc.GetLatestBlockhash(ctx, rpc.CommitmentConfirmed); err == nil && out != nil && out.Value != nil {
		details.RecentBlockhash = out.Value.Blockhash.String()
	}
	request, err := mpp.NewBase64URLJSONValue(intents.ChargeRequest{
		Amount:        baseUnits,
		Currency:      m.currency,
		Recipient:     m.recipient.String(),
		Description:   options.Description,
		ExternalID:    options.ExternalID,
		MethodDetails: details,
	})
	if err != nil {
		return mpp.PaymentChallenge{}, err
	}
	expires := options.Expires
	if expires == "" {
		expires = mpp.Minutes(5)
	}
	return mpp.NewChallengeWithSecretFull(
		m.secretKey,
		m.realm,
		mpp.NewMethodName("solana"),
		mpp.NewIntentName("charge"),
		request,
		expires,
		"",
		options.Description,
		nil,
	), nil
}

// VerifyCredential verifies either a transaction payload or a signature payload.
func (m *Mpp) VerifyCredential(ctx context.Context, credential mpp.PaymentCredential) (mpp.Receipt, error) {
	challenge := mpp.PaymentChallenge{
		ID:      credential.Challenge.ID,
		Realm:   credential.Challenge.Realm,
		Method:  credential.Challenge.Method,
		Intent:  credential.Challenge.Intent,
		Request: credential.Challenge.Request,
		Expires: credential.Challenge.Expires,
		Digest:  credential.Challenge.Digest,
		Opaque:  credential.Challenge.Opaque,
	}
	if !challenge.Verify(m.secretKey) {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeChallengeMismatch, "challenge ID mismatch")
	}
	if challenge.IsExpired(time.Now()) {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeChallengeExpired, fmt.Sprintf("challenge expired at %s", challenge.Expires))
	}
	var request intents.ChargeRequest
	if err := challenge.Request.Decode(&request); err != nil {
		return mpp.Receipt{}, err
	}
	var details protocol.MethodDetails
	if request.MethodDetails != nil {
		raw, err := json.Marshal(request.MethodDetails)
		if err != nil {
			return mpp.Receipt{}, err
		}
		if err := json.Unmarshal(raw, &details); err != nil {
			return mpp.Receipt{}, err
		}
	}
	var payload protocol.CredentialPayload
	if err := credential.PayloadAs(&payload); err != nil {
		return mpp.Receipt{}, err
	}
	switch payload.Type {
	case "transaction":
		return m.verifyTransaction(ctx, credential, request, details, payload)
	case "signature":
		if details.FeePayer != nil && *details.FeePayer {
			return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeInvalidPayload, `type="signature" credentials cannot be used with fee sponsorship`)
		}
		return m.verifySignature(ctx, credential, request, details, payload)
	default:
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeInvalidPayload, "missing or invalid payload type")
	}
}

func (m *Mpp) verifyTransaction(
	ctx context.Context,
	credential mpp.PaymentCredential,
	request intents.ChargeRequest,
	details protocol.MethodDetails,
	payload protocol.CredentialPayload,
) (mpp.Receipt, error) {
	if payload.Transaction == "" {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeMissingTransaction, "missing transaction data in credential payload")
	}
	tx, err := solanautil.DecodeTransactionBase64(payload.Transaction)
	if err != nil {
		return mpp.Receipt{}, err
	}
	// Reject up-front if the client signed against the wrong network
	// (e.g. mainnet keypair pointed at a sandbox-configured server, or
	// vice versa). Cheaper and clearer than letting the broadcast fail
	// with a confusing "transaction not found" error from the verifier.
	if err := CheckNetworkBlockhash(m.network, tx.Message.RecentBlockhash.String()); err != nil {
		return mpp.Receipt{}, err
	}
	if m.feePayerSigner != nil {
		if err := solanautil.SignTransaction(tx, m.feePayerSigner); err != nil {
			return mpp.Receipt{}, err
		}
	}
	if len(tx.Signatures) == 0 || tx.Signatures[0].IsZero() {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeMissingSignature, "transaction is missing a primary signature")
	}
	consumedKey := consumedPrefix + tx.Signatures[0].String()
	inserted, err := m.store.PutIfAbsent(ctx, consumedKey, true)
	if err != nil {
		return mpp.Receipt{}, err
	}
	if !inserted {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeSignatureConsumed, "transaction signature already consumed")
	}
	cleanupConsumed := true
	defer func() {
		if cleanupConsumed {
			_ = m.store.Delete(context.Background(), consumedKey)
		}
	}()
	if err := solanautil.SimulateTransaction(ctx, m.rpc, tx); err != nil {
		return mpp.Receipt{}, mpp.WrapError(mpp.ErrCodeSimulationFailed, "simulate transaction", err)
	}
	signature, err := solanautil.SendTransaction(ctx, m.rpc, tx)
	if err != nil {
		return mpp.Receipt{}, mpp.WrapError(mpp.ErrCodeRPC, "send transaction", err)
	}
	if err := solanautil.WaitForConfirmation(ctx, m.rpc, signature); err != nil {
		return mpp.Receipt{}, mpp.WrapError(mpp.ErrCodeTransactionFailed, "confirm transaction", err)
	}
	if err := m.verifyOnChain(ctx, signature, request, details); err != nil {
		return mpp.Receipt{}, err
	}
	cleanupConsumed = false
	return successReceipt(signature.String(), credential.Challenge.ID, request.ExternalID), nil
}

func (m *Mpp) verifySignature(
	ctx context.Context,
	credential mpp.PaymentCredential,
	request intents.ChargeRequest,
	details protocol.MethodDetails,
	payload protocol.CredentialPayload,
) (mpp.Receipt, error) {
	if payload.Signature == "" {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeMissingSignature, "missing signature in credential payload")
	}
	inserted, err := m.store.PutIfAbsent(ctx, consumedPrefix+payload.Signature, true)
	if err != nil {
		return mpp.Receipt{}, err
	}
	if !inserted {
		return mpp.Receipt{}, mpp.NewError(mpp.ErrCodeSignatureConsumed, "transaction signature already consumed")
	}
	signature, err := solana.SignatureFromBase58(payload.Signature)
	if err != nil {
		_ = m.store.Delete(context.Background(), consumedPrefix+payload.Signature)
		return mpp.Receipt{}, err
	}
	if err := m.verifyOnChain(ctx, signature, request, details); err != nil {
		_ = m.store.Delete(context.Background(), consumedPrefix+payload.Signature)
		return mpp.Receipt{}, err
	}
	return successReceipt(payload.Signature, credential.Challenge.ID, request.ExternalID), nil
}

func (m *Mpp) verifyOnChain(ctx context.Context, signature solana.Signature, request intents.ChargeRequest, details protocol.MethodDetails) error {
	tx, meta, err := solanautil.FetchTransaction(ctx, m.rpc, signature)
	if err != nil {
		return mpp.WrapError(mpp.ErrCodeTransactionNotFound, "transaction not found or not yet confirmed", err)
	}
	if meta != nil && meta.Err != nil {
		return mpp.NewError(mpp.ErrCodeTransactionFailed, fmt.Sprintf("transaction failed on-chain: %v", meta.Err))
	}
	amount, err := request.ParseAmount()
	if err != nil {
		return err
	}
	return verifyTransfersAgainstChallenge(tx, amount, request.Currency, m.recipient, request.ExternalID, details)
}

func verifyTransfersAgainstChallenge(tx *solana.Transaction, amount uint64, currency string, recipient solana.PublicKey, externalID string, details protocol.MethodDetails) error {
	expected, err := buildExpectedTransfers(amount, recipient, details)
	if err != nil {
		return err
	}
	matched := make([]bool, len(tx.Message.Instructions))
	if isNativeSOL(currency) {
		for _, want := range expected {
			found := false
			for index, compiled := range tx.Message.Instructions {
				if matched[index] {
					continue
				}
				programID := tx.Message.AccountKeys[compiled.ProgramIDIndex]
				if !programID.Equals(solana.SystemProgramID) {
					continue
				}
				accounts, err := compiled.ResolveInstructionAccounts(&tx.Message)
				if err != nil {
					return err
				}
				decoded, err := system.DecodeInstruction(accounts, []byte(compiled.Data))
				if err != nil {
					continue
				}
				transfer, ok := decoded.Impl.(*system.Transfer)
				if !ok || transfer.Lamports == nil {
					continue
				}
				if transfer.GetRecipientAccount().PublicKey.Equals(want.recipient) && *transfer.Lamports == want.amount {
					matched[index] = true
					found = true
					break
				}
			}
			if !found {
				return mpp.NewError(mpp.ErrCodeNoTransfer, fmt.Sprintf("no matching SOL transfer for %s", want.recipient))
			}
		}
		return verifyMemoInstructions(tx, matched, externalID, details.Splits)
	}
	resolvedMint := protocol.ResolveMint(currency, details.Network)
	mint := solana.MustPublicKeyFromBase58(resolvedMint)
	expectedProgram := solana.TokenProgramID
	tokenProgram := details.TokenProgram
	if tokenProgram == "" && protocol.StablecoinSymbol(currency) != "" {
		tokenProgram = protocol.DefaultTokenProgramForCurrency(currency, details.Network)
	}
	if tokenProgram == protocol.Token2022Program {
		expectedProgram = solana.MustPublicKeyFromBase58(protocol.Token2022Program)
	}
	type tokenExpectation struct {
		recipient solana.PublicKey
		ata       solana.PublicKey
		amount    uint64
	}
	tokenExpected := make([]tokenExpectation, 0, len(expected))
	for _, want := range expected {
		ata, err := solanautil.FindAssociatedTokenAddressWithProgram(want.recipient, mint, expectedProgram)
		if err != nil {
			return err
		}
		tokenExpected = append(tokenExpected, tokenExpectation{
			recipient: want.recipient,
			ata:       ata,
			amount:    want.amount,
		})
	}
	for _, want := range tokenExpected {
		found := false
		for index, compiled := range tx.Message.Instructions {
			if matched[index] {
				continue
			}
			programID := tx.Message.AccountKeys[compiled.ProgramIDIndex]
			if !programID.Equals(expectedProgram) {
				continue
			}
			accounts, err := compiled.ResolveInstructionAccounts(&tx.Message)
			if err != nil {
				return err
			}
			if expectedProgram.Equals(solana.TokenProgramID) {
				decoded, err := token.DecodeInstruction(accounts, []byte(compiled.Data))
				if err != nil {
					continue
				}
				transfer, ok := decoded.Impl.(*token.TransferChecked)
				if !ok || transfer.Amount == nil {
					continue
				}
				if !transfer.GetMintAccount().PublicKey.Equals(mint) {
					continue
				}
				if transfer.GetDestinationAccount().PublicKey.Equals(want.ata) && *transfer.Amount == want.amount {
					matched[index] = true
					found = true
					break
				}
				continue
			}
			decoded, err := token2022.DecodeInstruction(accounts, []byte(compiled.Data))
			if err != nil {
				continue
			}
			transfer, ok := decoded.Impl.(*token2022.TransferChecked)
			if !ok || transfer.Amount == nil {
				continue
			}
			if !transfer.GetMintAccount().PublicKey.Equals(mint) {
				continue
			}
			if transfer.GetDestinationAccount().PublicKey.Equals(want.ata) && *transfer.Amount == want.amount {
				matched[index] = true
				found = true
				break
			}
		}
		if !found {
			return mpp.NewError(mpp.ErrCodeNoTransfer, fmt.Sprintf("no matching token transfer for %s", want.recipient))
		}
	}
	return verifyMemoInstructions(tx, matched, externalID, details.Splits)
}

type expectedMemo struct {
	label string
	value string
}

func buildExpectedMemos(externalID string, splits []protocol.Split) []expectedMemo {
	expected := make([]expectedMemo, 0, 1+len(splits))
	if externalID != "" {
		expected = append(expected, expectedMemo{label: "externalId", value: externalID})
	}
	for _, split := range splits {
		if split.Memo != "" {
			expected = append(expected, expectedMemo{label: "split", value: split.Memo})
		}
	}
	return expected
}

func verifyMemoInstructions(tx *solana.Transaction, matched []bool, externalID string, splits []protocol.Split) error {
	memoProgram := solana.MustPublicKeyFromBase58(protocol.MemoProgram)
	for _, want := range buildExpectedMemos(externalID, splits) {
		if len([]byte(want.value)) > 566 {
			return mpp.NewError(mpp.ErrCodeInvalidPayload, "memo cannot exceed 566 bytes")
		}
		found := false
		for index, compiled := range tx.Message.Instructions {
			if matched[index] {
				continue
			}
			programID := tx.Message.AccountKeys[compiled.ProgramIDIndex]
			if !programID.Equals(memoProgram) {
				continue
			}
			if string(compiled.Data) == want.value {
				matched[index] = true
				found = true
				break
			}
		}
		if !found {
			return mpp.NewError(mpp.ErrCodeInvalidPayload, fmt.Sprintf("no memo instruction found for %s memo %q", want.label, want.value))
		}
	}

	for index, compiled := range tx.Message.Instructions {
		if matched[index] {
			continue
		}
		programID := tx.Message.AccountKeys[compiled.ProgramIDIndex]
		if programID.Equals(memoProgram) {
			return mpp.NewError(mpp.ErrCodeInvalidPayload, "unexpected Memo Program instruction in payment transaction")
		}
	}
	return nil
}

type expectedTransfer struct {
	recipient solana.PublicKey
	amount    uint64
}

func buildExpectedTransfers(amount uint64, recipient solana.PublicKey, details protocol.MethodDetails) ([]expectedTransfer, error) {
	primaryAmount, err := solanautil.SplitAmounts(amount, details.Splits)
	if err != nil {
		return nil, err
	}
	expected := []expectedTransfer{{recipient: recipient, amount: primaryAmount}}
	for _, split := range details.Splits {
		splitAmount, err := intents.ChargeRequest{Amount: split.Amount}.ParseAmount()
		if err != nil {
			return nil, err
		}
		splitRecipient, err := solana.PublicKeyFromBase58(split.Recipient)
		if err != nil {
			return nil, err
		}
		expected = append(expected, expectedTransfer{
			recipient: splitRecipient,
			amount:    splitAmount,
		})
	}
	return expected, nil
}

func successReceipt(reference, challengeID, externalID string) mpp.Receipt {
	return mpp.Receipt{
		Status:      mpp.ReceiptStatusSuccess,
		Method:      mpp.NewMethodName("solana"),
		Timestamp:   time.Now().UTC().Format(time.RFC3339),
		Reference:   reference,
		ChallengeID: challengeID,
		ExternalID:  externalID,
	}
}

func isNativeSOL(currency string) bool {
	return strings.EqualFold(currency, "sol")
}
