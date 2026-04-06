package mpp

import (
	"errors"
	"testing"
)

func TestNewError(t *testing.T) {
	err := NewError(ErrCodeInvalidConfig, "bad config")
	if err.Error() != "bad config" {
		t.Fatalf("unexpected message %q", err.Error())
	}
}

func TestWrapError(t *testing.T) {
	cause := errors.New("boom")
	err := WrapError(ErrCodeRPC, "rpc failed", cause)
	if err.Unwrap() != cause {
		t.Fatal("expected wrapped cause")
	}
}
