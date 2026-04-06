package protocol

import "testing"

func TestDefaultRPCURL(t *testing.T) {
	if DefaultRPCURL("devnet") != "https://api.devnet.solana.com" {
		t.Fatal("unexpected devnet rpc url")
	}
	if DefaultRPCURL("localnet") != "http://localhost:8899" {
		t.Fatal("unexpected localnet rpc url")
	}
	if DefaultRPCURL("unknown") != "https://api.mainnet-beta.solana.com" {
		t.Fatal("unexpected default rpc url")
	}
}

func TestResolveMint(t *testing.T) {
	if ResolveMint("sol", "localnet") != "" {
		t.Fatal("expected SOL to resolve to native asset")
	}
	if ResolveMint("USDC", "localnet") != "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" {
		t.Fatal("unexpected localnet usdc mint")
	}
	if ResolveMint("USDC", "devnet") != "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" {
		t.Fatal("unexpected devnet usdc mint")
	}
	if ResolveMint("PYUSD", "localnet") != "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo" {
		t.Fatal("unexpected localnet pyusd mint")
	}
	if ResolveMint("SomeMint1111111111111111111111111111111111", "localnet") != "SomeMint1111111111111111111111111111111111" {
		t.Fatal("unexpected passthrough mint")
	}
}
