package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/webssh-studio/gateway/internal/audit"
	"github.com/webssh-studio/gateway/internal/auth"
	"github.com/webssh-studio/gateway/internal/policy"
	"github.com/webssh-studio/gateway/internal/session"
)

type ServerConfig struct {
	ListenAddr         string
	AllowedOrigins     []string
	OIDCIssuer         string
	OIDCClientID       string
	DestAllowlist      []string
	DestDenylist       []string
	SessionGrace       time.Duration
	RingBufferBytes    int
	MaxSessionsPerUser int
	RateLimitPerSec    float64
}

func loadConfigFromEnv() ServerConfig {
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	origins := strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",")
	if len(origins) == 1 && origins[0] == "" {
		origins = []string{"http://localhost:5173", "http://127.0.0.1:4173"}
	}
	allowlist := strings.Split(os.Getenv("DEST_ALLOWLIST"), ",")
	denylist := strings.Split(os.Getenv("DEST_DENYLIST"), ",")

	grace := 15 * time.Minute
	if d, err := time.ParseDuration(os.Getenv("SESSION_GRACE")); err == nil && d > 0 {
		grace = d
	}
	ringBytes := 4 * 1024 * 1024
	if b, err := strconv.Atoi(os.Getenv("RING_BUFFER_BYTES")); err == nil && b > 0 {
		ringBytes = b
	}
	maxSess := 10
	if m, err := strconv.Atoi(os.Getenv("MAX_SESSIONS_PER_USER")); err == nil && m > 0 {
		maxSess = m
	}
	rate := 20.0
	if r, err := strconv.ParseFloat(os.Getenv("RATE_LIMITS"), 64); err == nil && r > 0 {
		rate = r
	}

	return ServerConfig{
		ListenAddr:         addr,
		AllowedOrigins:     origins,
		OIDCIssuer:         os.Getenv("OIDC_ISSUER"),
		OIDCClientID:       os.Getenv("OIDC_CLIENT_ID"),
		DestAllowlist:      allowlist,
		DestDenylist:       denylist,
		SessionGrace:       grace,
		RingBufferBytes:    ringBytes,
		MaxSessionsPerUser: maxSess,
		RateLimitPerSec:    rate,
	}
}

func NewMux(cfg ServerConfig) (http.Handler, error) {
	guard, err := policy.NewGuard(policy.Config{
		Allowlist: cfg.DestAllowlist,
		Denylist:  cfg.DestDenylist,
	})
	if err != nil {
		return nil, err
	}
	origins := auth.NewOriginValidator(cfg.AllowedOrigins)
	limiter := auth.NewRateLimiter(cfg.RateLimitPerSec, int(cfg.RateLimitPerSec*2))
	sessions := session.NewManager(cfg.RingBufferBytes, cfg.SessionGrace, cfg.MaxSessionsPerUser)
	auditor := audit.NewLogger(os.Stdout, 1000)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":         "ok",
			"activeSessions": sessions.ActiveCount(),
		})
	})

	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintln(w, "webssh_gateway_active_sessions", sessions.ActiveCount())
		_, _ = fmt.Fprintln(w, "webssh_gateway_audit_events_total", len(auditor.Recent()))
	})

	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if err := origins.Check(r.Header.Get("Origin")); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		if err := limiter.Allow(r.RemoteAddr); err != nil {
			http.Error(w, err.Error(), http.StatusTooManyRequests)
			return
		}
		targetHost := r.URL.Query().Get("host")
		if targetHost != "" {
			if _, err := guard.Check(r.Context(), targetHost, 22); err != nil {
				auditor.Record(audit.Entry{
					Event:      audit.EventPolicyDenied,
					UserID:     "ws-precheck",
					TargetHost: targetHost,
					TargetPort: 22,
					Reason:     err.Error(),
				})
				http.Error(w, err.Error(), http.StatusForbidden)
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "upgrade_required"})
	})

	return mux, nil
}

func main() {
	cfg := loadConfigFromEnv()
	handler, err := NewMux(cfg)
	if err != nil {
		log.Fatalf("gateway init failed: %v", err)
	}
	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("WebSSH Studio Gateway listening on %s", cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
