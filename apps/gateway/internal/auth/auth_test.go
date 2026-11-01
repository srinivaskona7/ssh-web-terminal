package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func signHS256JWT(secret []byte, claims Claims) string {
	hdr, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	pld, _ := json.Marshal(claims)
	h64 := base64.RawURLEncoding.EncodeToString(hdr)
	p64 := base64.RawURLEncoding.EncodeToString(pld)
	input := h64 + "." + p64
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(input))
	s64 := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return input + "." + s64
}

func TestOriginValidator(t *testing.T) {
	ov := NewOriginValidator([]string{"https://ssh.example.com", "http://localhost:5173"})
	if err := ov.Check("https://ssh.example.com"); err != nil {
		t.Fatalf("expected allowed origin, got %v", err)
	}
	if err := ov.Check("https://evil.example.org"); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("expected ErrOriginNotAllowed, got %v", err)
	}
	if err := ov.Check(""); !errors.Is(err, ErrOriginNotAllowed) {
		t.Fatalf("expected ErrOriginNotAllowed for empty origin, got %v", err)
	}
}

func TestOIDCVerifier(t *testing.T) {
	secret := []byte("super-secret-test-key-32-bytes!!")
	v := &OIDCVerifier{
		Issuer:     "https://idp.example.com",
		ClientID:   "webssh-studio",
		HMACSecret: secret,
	}

	validTok := signHS256JWT(secret, Claims{
		Subject:  "user-123",
		Issuer:   "https://idp.example.com",
		Audience: "webssh-studio",
		Expires:  time.Now().Add(5 * time.Minute).Unix(),
	})
	claims, err := v.Verify(validTok)
	if err != nil {
		t.Fatalf("Verify valid token failed: %v", err)
	}
	if claims.Subject != "user-123" {
		t.Fatalf("unexpected subject: %s", claims.Subject)
	}

	expiredTok := signHS256JWT(secret, Claims{
		Subject:  "user-123",
		Issuer:   "https://idp.example.com",
		Audience: "webssh-studio",
		Expires:  time.Now().Add(-5 * time.Minute).Unix(),
	})
	if _, err := v.Verify(expiredTok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected expired token error, got %v", err)
	}

	wrongAudTok := signHS256JWT(secret, Claims{
		Subject:  "user-123",
		Issuer:   "https://idp.example.com",
		Audience: "other-app",
		Expires:  time.Now().Add(5 * time.Minute).Unix(),
	})
	if _, err := v.Verify(wrongAudTok); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected audience mismatch error, got %v", err)
	}
}

func TestRateLimiter(t *testing.T) {
	rl := NewRateLimiter(1, 2)
	if err := rl.Allow("alice"); err != nil {
		t.Fatalf("first request failed: %v", err)
	}
	if err := rl.Allow("alice"); err != nil {
		t.Fatalf("second request failed: %v", err)
	}
	if err := rl.Allow("alice"); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("third burst request should be rate limited, got %v", err)
	}
}
