package protocol

import "strings"

const (
	TokenProgram           = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	Token2022Program       = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
	AssociatedTokenProgram = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
	SystemProgram          = "11111111111111111111111111111111"
)

// DefaultRPCURL returns the default RPC endpoint for a Solana network.
func DefaultRPCURL(network string) string {
	switch network {
	case "devnet":
		return "https://api.devnet.solana.com"
	case "localnet":
		return "http://localhost:8899"
	default:
		return "https://api.mainnet-beta.solana.com"
	}
}

// ResolveMint converts a symbolic currency into a mint address.
// Returns an empty string for native SOL.
func ResolveMint(currency string, network string) string {
	switch strings.ToUpper(currency) {
	case "SOL":
		return ""
	case "USDC":
		if network == "devnet" {
			return "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
		}
		return "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
	case "PYUSD":
		if network == "devnet" {
			return "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM"
		}
		return "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"
	default:
		return currency
	}
}

// MethodDetails contains Solana-specific challenge fields.
type MethodDetails struct {
	Network         string  `json:"network,omitempty"`
	Decimals        *uint8  `json:"decimals,omitempty"`
	TokenProgram    string  `json:"tokenProgram,omitempty"`
	FeePayer        *bool   `json:"feePayer,omitempty"`
	FeePayerKey     string  `json:"feePayerKey,omitempty"`
	Splits          []Split `json:"splits,omitempty"`
	RecentBlockhash string  `json:"recentBlockhash,omitempty"`
}

// Split is an additional transfer in the same asset.
type Split struct {
	Recipient string `json:"recipient"`
	Amount    string `json:"amount"`
	Label     string `json:"label,omitempty"`
	Memo      string `json:"memo,omitempty"`
}

// CredentialPayload is sent by clients in the payment credential payload.
type CredentialPayload struct {
	Type        string `json:"type"`
	Transaction string `json:"transaction,omitempty"`
	Signature   string `json:"signature,omitempty"`
}
