package auth

import (
	"crypto"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var (
	ErrOriginNotAllowed = errors.New("auth: origin not allowed")
	ErrInvalidToken     = errors.New("auth: invalid or expired OIDC token")
	ErrRateLimited      = errors.New("auth: rate limit exceeded")
)

type OriginValidator struct {
	allowAll bool
	allowed  map[string]struct{}
}

func NewOriginValidator(origins []string) *OriginValidator {
	ov := &OriginValidator{
		allowed: make(map[string]struct{}),
	}
	for _, raw := range origins {
		o := strings.TrimSpace(strings.ToLower(raw))
		if o == "" {
			continue
		}
		if o == "*" {
			ov.allowAll = true
		}
		ov.allowed[o] = struct{}{}
	}
	return ov
}

func (ov *OriginValidator) Check(origin string) error {
	if ov.allowAll {
		return nil
	}
	clean := strings.TrimSpace(strings.ToLower(origin))
	if clean == "" {
		return ErrOriginNotAllowed
	}
	if _, ok := ov.allowed[clean]; !ok {
		return fmt.Errorf("%w: %q", ErrOriginNotAllowed, origin)
	}
	return nil
}

type Claims struct {
	Subject  string `json:"sub"`
	Issuer   string `json:"iss"`
	Audience any    `json:"aud"`
	Expires  int64  `json:"exp"`
	Email    string `json:"email,omitempty"`
}

type OIDCVerifier struct {
	Issuer     string
	ClientID   string
	RSAPublic  *rsa.PublicKey
	HMACSecret []byte
	AllowDev   bool
}

func (v *OIDCVerifier) Verify(token string) (Claims, error) {
	if v.AllowDev && token == "" {
		return Claims{Subject: "anonymous-dev"}, nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, ErrInvalidToken
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var hdr struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(headerBytes, &hdr); err != nil {
		return Claims{}, ErrInvalidToken
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}

	signingInput := []byte(parts[0] + "." + parts[1])
	digest := sha256.Sum256(signingInput)

	switch hdr.Alg {
	case "RS256":
		if v.RSAPublic == nil {
			return Claims{}, fmt.Errorf("%w: RS256 key not configured", ErrInvalidToken)
		}
		if err := rsa.VerifyPKCS1v15(v.RSAPublic, crypto.SHA256, digest[:], sigBytes); err != nil {
			return Claims{}, fmt.Errorf("%w: RSA signature mismatch", ErrInvalidToken)
		}
	case "HS256":
		if len(v.HMACSecret) == 0 {
			return Claims{}, fmt.Errorf("%w: HMAC secret not configured", ErrInvalidToken)
		}
		mac := hmac.New(sha256.New, v.HMACSecret)
		mac.Write(signingInput)
		if !hmac.Equal(mac.Sum(nil), sigBytes) {
			return Claims{}, fmt.Errorf("%w: HMAC signature mismatch", ErrInvalidToken)
		}
	default:
		return Claims{}, fmt.Errorf("%w: unsupported JWT alg %q", ErrInvalidToken, hdr.Alg)
	}

	var claims Claims
	if err := json.Unmarshal(payloadBytes, &claims); err != nil {
		return Claims{}, ErrInvalidToken
	}

	if v.Issuer != "" && claims.Issuer != v.Issuer {
		return Claims{}, fmt.Errorf("%w: issuer mismatch", ErrInvalidToken)
	}
	if v.ClientID != "" && !audienceMatches(claims.Audience, v.ClientID) {
		return Claims{}, fmt.Errorf("%w: audience mismatch", ErrInvalidToken)
	}
	if claims.Expires > 0 && time.Now().Unix() > claims.Expires {
		return Claims{}, fmt.Errorf("%w: token expired", ErrInvalidToken)
	}
	if claims.Subject == "" {
		return Claims{}, fmt.Errorf("%w: missing sub claim", ErrInvalidToken)
	}
	return claims, nil
}

func audienceMatches(aud any, want string) bool {
	switch v := aud.(type) {
	case string:
		return v == want
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s == want {
				return true
			}
		}
	}
	return false
}

type bucket struct {
	tokens float64
	last   time.Time
}

type RateLimiter struct {
	mu      sync.Mutex
	rate    float64
	burst   float64
	buckets map[string]*bucket
}

func NewRateLimiter(ratePerSec float64, burst int) *RateLimiter {
	if ratePerSec <= 0 {
		ratePerSec = 10
	}
	if burst <= 0 {
		burst = 20
	}
	return &RateLimiter{
		rate:    ratePerSec,
		burst:   float64(burst),
		buckets: make(map[string]*bucket),
	}
}

func (rl *RateLimiter) Allow(key string) error {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	b, ok := rl.buckets[key]
	if !ok {
		rl.buckets[key] = &bucket{
			tokens: rl.burst - 1,
			last:   now,
		}
		return nil
	}

	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * rl.rate
	if b.tokens > rl.burst {
		b.tokens = rl.burst
	}
	if b.tokens < 1 {
		return ErrRateLimited
	}
	b.tokens -= 1
	return nil
}
