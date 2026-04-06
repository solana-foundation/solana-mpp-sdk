// Canonical interop test client (Go).
//
// Tests the full payment cycle against any MPP server:
//
//	1. GET /health → 200
//	2. GET /fortune → 402 + WWW-Authenticate
//	3. Fund test keypair via surfpool
//	4. Build credential using solana-mpp Go client
//	5. GET /fortune with Authorization → 200 + fortune
//
// Usage: SERVER_URL=http://localhost:3001 RPC_URL=http://localhost:8899 go run .
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"

	mpp "github.com/solana-foundation/mpp-sdk/go"
	"github.com/solana-foundation/mpp-sdk/go/client"
)

func main() {
	serverURL := envOrDefault("SERVER_URL", "http://localhost:3001")
	fortunePath := envOrDefault("FORTUNE_PATH", "/fortune")
	rpcURL := envOrDefault("RPC_URL", "http://localhost:8899")

	fmt.Printf("Interop test: Go client → %s\n", serverURL)
	fmt.Printf("RPC: %s\n", rpcURL)

	ctx := context.Background()
	httpClient := &http.Client{}
	rpcClient := rpc.New(rpcURL)

	// ── Test 1: Health ──
	fmt.Print("  health ... ")
	resp := mustGet(httpClient, serverURL+"/health")
	mustClose(resp.Body)
	assert(resp.StatusCode == 200, "health should return 200, got %d", resp.StatusCode)
	fmt.Println("OK")

	// ── Test 2: Challenge ──
	fmt.Print("  challenge ... ")
	resp = mustGet(httpClient, serverURL+fortunePath)
	mustClose(resp.Body)
	assert(resp.StatusCode == 402, "fortune without auth should return 402, got %d", resp.StatusCode)
	wwwAuth := resp.Header.Get("WWW-Authenticate")
	assert(wwwAuth != "", "missing WWW-Authenticate header")
	assert(strings.HasPrefix(wwwAuth, "Payment "), "should use Payment scheme")
	challenge, err := mpp.ParseWWWAuthenticate(wwwAuth)
	mustOK(err, "parse challenge")
	assert(string(challenge.Method) == "solana", "method should be solana, got %s", challenge.Method)
	assert(string(challenge.Intent) == "charge", "intent should be charge, got %s", challenge.Intent)
	fmt.Printf("OK (id=%s…)\n", challenge.ID[:12])

	// ── Test 3: Fund test keypair via surfpool ──
	fmt.Print("  fund ... ")
	wallet := solana.NewWallet()
	signer := wallet.PrivateKey
	pubkey := signer.PublicKey()
	pubkeyStr := pubkey.String()

	// Decode request to get currency info
	var request map[string]any
	mustOK(challenge.Request.Decode(&request), "decode request")
	currency, _ := request["currency"].(string)
	if currency == "" {
		currency = "sol"
	}
	isNativeSOL := strings.EqualFold(currency, "sol")

	methodDetails, _ := request["methodDetails"].(map[string]any)
	tokenProgram := "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	if tp, ok := methodDetails["tokenProgram"].(string); ok && tp != "" {
		tokenProgram = tp
	}
	recipient, _ := request["recipient"].(string)

	// Fund SOL
	rpcCall(httpClient, rpcURL, "surfnet_setAccount", []any{
		pubkeyStr,
		map[string]any{
			"lamports":   2_000_000_000,
			"data":       "",
			"executable": false,
			"owner":      "11111111111111111111111111111111",
			"rentEpoch":  0,
		},
	})

	if !isNativeSOL {
		amountStr, _ := request["amount"].(string)
		if amountStr == "" {
			amountStr = "0"
		}
		// Fund payer token account
		rpcCall(httpClient, rpcURL, "surfnet_setTokenAccount", []any{
			pubkeyStr, currency,
			map[string]any{"amount": mustParseInt(amountStr), "state": "initialized"},
			tokenProgram,
		})
		// Ensure recipient has token account
		rpcCall(httpClient, rpcURL, "surfnet_setTokenAccount", []any{
			recipient, currency,
			map[string]any{"amount": 0, "state": "initialized"},
			tokenProgram,
		})
	}
	fmt.Printf("OK (pubkey=%s…)\n", pubkeyStr[:8])

	// ── Test 4: Build credential ──
	fmt.Print("  credential ... ")
	authHeader, err := client.BuildCredentialHeader(ctx, signer, rpcClient, challenge)
	mustOK(err, "build credential header")
	assert(strings.HasPrefix(authHeader, "Payment "), "credential should start with Payment")
	fmt.Println("OK")

	// ── Test 5: Submit and get fortune ──
	fmt.Print("  payment ... ")
	req, err := http.NewRequest("GET", serverURL+fortunePath, nil)
	mustOK(err, "create request")
	req.Header.Set("Authorization", authHeader)
	resp, err = httpClient.Do(req)
	mustOK(err, "payment request")
	body, _ := io.ReadAll(resp.Body)
	mustClose(resp.Body)
	assert(resp.StatusCode == 200, "payment should return 200, got %d: %s", resp.StatusCode, string(body))
	var data map[string]any
	mustOK(json.Unmarshal(body, &data), "parse response JSON")
	_, hasFortune := data["fortune"]
	assert(hasFortune, "response should contain fortune")
	fortune, _ := data["fortune"].(string)
	fmt.Printf("OK → %s\n", fortune)

	fmt.Println("\n  ✓ All interop tests passed")
}

// envOrDefault reads an env var with a fallback default.
func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// mustGet performs an HTTP GET and panics on error.
func mustGet(c *http.Client, url string) *http.Response {
	resp, err := c.Get(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL: GET %s: %v\n", url, err)
		os.Exit(1)
	}
	return resp
}

// mustClose closes a body, ignoring errors.
func mustClose(body io.ReadCloser) {
	if body != nil {
		_, _ = io.ReadAll(body)
		body.Close()
	}
}

// mustOK panics if err is non-nil.
func mustOK(err error, msg string) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL: %s: %v\n", msg, err)
		os.Exit(1)
	}
}

// assert panics when a condition is false.
func assert(condition bool, format string, args ...any) {
	if !condition {
		fmt.Fprintf(os.Stderr, "FAIL: "+format+"\n", args...)
		os.Exit(1)
	}
}

// rpcCall sends a JSON-RPC request to surfpool.
func rpcCall(c *http.Client, rpcURL, method string, params any) {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	})
	mustOK(err, "marshal RPC payload")
	resp, err := c.Post(rpcURL, "application/json", bytes.NewReader(payload))
	if err != nil {
		fmt.Fprintf(os.Stderr, "FAIL: RPC %s: %v\n", method, err)
		os.Exit(1)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var result map[string]any
	mustOK(json.Unmarshal(body, &result), "parse RPC response")
	if errField, ok := result["error"]; ok {
		fmt.Fprintf(os.Stderr, "FAIL: RPC %s error: %v\n", method, errField)
		os.Exit(1)
	}
}

func mustParseInt(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
