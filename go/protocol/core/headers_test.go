package core

import (
	"fmt"
	"testing"
)

func TestWWWAuthenticateRoundTrip(t *testing.T) {
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "1000", "currency": "sol"})
	challenge := NewChallengeWithSecretFull("secret", "realm", NewMethodName("solana"), NewIntentName("charge"), request, "2030-01-01T00:00:00Z", "", "desc", nil)
	header, err := FormatWWWAuthenticate(challenge)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	parsed, err := ParseWWWAuthenticate(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.ID != challenge.ID || parsed.Realm != challenge.Realm || parsed.Request.Raw() != challenge.Request.Raw() {
		t.Fatalf("unexpected parsed challenge: %#v", parsed)
	}
}

func TestAuthorizationRoundTrip(t *testing.T) {
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "1000"})
	challenge := NewChallengeWithSecret("secret", "realm", NewMethodName("solana"), NewIntentName("charge"), request)
	credential, err := NewPaymentCredential(challenge.ToEcho(), map[string]string{"type": "transaction", "transaction": "abc"})
	if err != nil {
		t.Fatalf("credential failed: %v", err)
	}
	header, err := FormatAuthorization(credential)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	parsed, err := ParseAuthorization(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.Challenge.ID != challenge.ID {
		t.Fatalf("unexpected parsed credential: %#v", parsed)
	}
}

func TestReceiptRoundTrip(t *testing.T) {
	header, err := FormatReceipt(Receipt{Status: ReceiptStatusSuccess, Method: "solana", Timestamp: "2026-01-01T00:00:00Z", Reference: "sig", ChallengeID: "id"})
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	receipt, err := ParseReceipt(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if receipt.Reference != "sig" {
		t.Fatalf("unexpected receipt: %#v", receipt)
	}
}

func TestSortedHeaderParams(t *testing.T) {
	params := SortedHeaderParams(map[string]string{"b": "2", "a": "1"})
	if len(params) != 2 || params[0] != "a=1" || params[1] != "b=2" {
		t.Fatalf("unexpected params %#v", params)
	}
}

func TestParseWWWAuthenticateMissingRequiredFields(t *testing.T) {
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "1000"})
	tests := []struct {
		name   string
		header string
	}{
		{"missing id", `Payment realm="r", method="solana", intent="charge", request="` + request.Raw() + `"`},
		{"missing realm", `Payment id="abc", method="solana", intent="charge", request="` + request.Raw() + `"`},
		{"missing intent", `Payment id="abc", realm="r", method="solana", request="` + request.Raw() + `"`},
		{"missing request", `Payment id="abc", realm="r", method="solana", intent="charge"`},
		{"wrong scheme", `Bearer id="abc", realm="r", method="solana", intent="charge", request="` + request.Raw() + `"`},
		{"invalid method", `Payment id="abc", realm="r", method="123", intent="charge", request="` + request.Raw() + `"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseWWWAuthenticate(tc.header); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestParseWWWAuthenticateWithOpaqueAndDigest(t *testing.T) {
	opaque, _ := NewBase64URLJSONValue(map[string]string{"session": "xyz"})
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "1000"})
	challenge := NewChallengeWithSecretFull("secret", "realm", NewMethodName("solana"), NewIntentName("charge"), request, "2030-01-01T00:00:00Z", "sha256=abc", "description", &opaque)
	header, err := FormatWWWAuthenticate(challenge)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	parsed, err := ParseWWWAuthenticate(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.Digest != "sha256=abc" {
		t.Fatalf("expected digest, got %q", parsed.Digest)
	}
	if parsed.Opaque == nil {
		t.Fatal("expected opaque to be set")
	}
	if parsed.Opaque.Raw() != opaque.Raw() {
		t.Fatalf("opaque mismatch: got %q, want %q", parsed.Opaque.Raw(), opaque.Raw())
	}
	if parsed.Description != "description" {
		t.Fatalf("expected description, got %q", parsed.Description)
	}
}

func TestFormatWWWAuthenticateAllOptionalFields(t *testing.T) {
	opaque, _ := NewBase64URLJSONValue(map[string]string{"k": "v"})
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "1"})
	challenge := PaymentChallenge{
		ID:          "test-id",
		Realm:       "test-realm",
		Method:      NewMethodName("solana"),
		Intent:      NewIntentName("charge"),
		Request:     request,
		Expires:     "2030-01-01T00:00:00Z",
		Description: "buy coffee",
		Digest:      "sha256=abc",
		Opaque:      &opaque,
	}
	header, err := FormatWWWAuthenticate(challenge)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	for _, needle := range []string{`expires="`, `description="`, `digest="`, `opaque="`} {
		if !contains(header, needle) {
			t.Fatalf("header missing %q: %s", needle, header)
		}
	}
}

func TestParseAuthorizationWrongScheme(t *testing.T) {
	if _, err := ParseAuthorization("Bearer abc123"); err == nil {
		t.Fatal("expected error for non-Payment scheme")
	}
}

func TestParseAuthorizationOversizedToken(t *testing.T) {
	// Build a header with a token > 16KB
	huge := "Payment " + string(make([]byte, 17*1024))
	if _, err := ParseAuthorization(huge); err == nil {
		t.Fatal("expected error for oversized token")
	}
}

func TestParseAuthorizationInvalidBase64(t *testing.T) {
	if _, err := ParseAuthorization("Payment !!!invalid-base64!!!"); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestFormatAuthorizationRoundTrip(t *testing.T) {
	request, _ := NewBase64URLJSONValue(map[string]string{"amount": "500"})
	challenge := NewChallengeWithSecret("secret", "realm", NewMethodName("solana"), NewIntentName("charge"), request)
	original, _ := NewPaymentCredential(challenge.ToEcho(), map[string]string{"type": "transaction", "transaction": "data"})
	header, err := FormatAuthorization(original)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	parsed, err := ParseAuthorization(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.Challenge.ID != original.Challenge.ID {
		t.Fatalf("round-trip mismatch: %q != %q", parsed.Challenge.ID, original.Challenge.ID)
	}
	var payload map[string]string
	if err := parsed.PayloadAs(&payload); err != nil {
		t.Fatalf("payload decode failed: %v", err)
	}
	if payload["type"] != "transaction" {
		t.Fatalf("unexpected payload type: %q", payload["type"])
	}
}

func TestParseReceiptFormatReceiptRoundTrip(t *testing.T) {
	original := Receipt{
		Status:      ReceiptStatusSuccess,
		Method:      "solana",
		Timestamp:   "2026-01-01T00:00:00Z",
		Reference:   "sig123",
		ChallengeID: "cid",
		ExternalID:  "ext-1",
	}
	header, err := FormatReceipt(original)
	if err != nil {
		t.Fatalf("format failed: %v", err)
	}
	parsed, err := ParseReceipt(header)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.Reference != "sig123" || parsed.ExternalID != "ext-1" || parsed.ChallengeID != "cid" {
		t.Fatalf("round-trip mismatch: %+v", parsed)
	}
}

func TestExtractPaymentSchemeMultipleSchemes(t *testing.T) {
	header := "Bearer token123, Payment abc456"
	scheme, ok := ExtractPaymentScheme(header)
	if !ok {
		t.Fatal("expected Payment scheme to be found")
	}
	if scheme != "Payment abc456" {
		t.Fatalf("unexpected scheme: %q", scheme)
	}
}

func TestExtractPaymentSchemeNotPresent(t *testing.T) {
	if _, ok := ExtractPaymentScheme("Bearer token123"); ok {
		t.Fatal("expected no Payment scheme")
	}
}

func TestParseWWWAuthenticateInvalidRequestBase64(t *testing.T) {
	header := `Payment id="abc", realm="r", method="solana", intent="charge", request="!!!invalid"`
	if _, err := ParseWWWAuthenticate(header); err == nil {
		t.Fatal("expected error for invalid base64 in request")
	}
}

func TestParseWWWAuthenticateInvalidRequestJSON(t *testing.T) {
	// Valid base64 but not valid JSON
	notJSON := Base64URLEncode([]byte("not json"))
	header := fmt.Sprintf(`Payment id="abc", realm="r", method="solana", intent="charge", request="%s"`, notJSON)
	if _, err := ParseWWWAuthenticate(header); err == nil {
		t.Fatal("expected error for invalid JSON in request")
	}
}

func TestParseAuthParamsDuplicateKey(t *testing.T) {
	// This exercises the duplicate parameter error in parseAuthParams
	header := `Payment id="abc", id="def", realm="r", method="solana", intent="charge", request="dGVzdA"`
	if _, err := ParseWWWAuthenticate(header); err == nil {
		t.Fatal("expected error for duplicate parameter")
	}
}

func TestParseReceiptOversized(t *testing.T) {
	huge := string(make([]byte, 17*1024))
	if _, err := ParseReceipt(huge); err == nil {
		t.Fatal("expected error for oversized receipt")
	}
}

func TestParseReceiptInvalidBase64(t *testing.T) {
	if _, err := ParseReceipt("!!!invalid!!!"); err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestParseReceiptInvalidJSON(t *testing.T) {
	notJSON := Base64URLEncode([]byte("not json"))
	if _, err := ParseReceipt(notJSON); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsInner(s, substr))
}

func containsInner(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
