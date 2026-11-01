package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGatewayHTTPAndSecurityEndpoints(t *testing.T) {
	cfg := ServerConfig{
		ListenAddr:         ":0",
		AllowedOrigins:     []string{"https://app.webssh.studio"},
		DestAllowlist:      []string{},
		DestDenylist:       []string{},
		SessionGrace:       time.Minute,
		RingBufferBytes:    65536,
		MaxSessionsPerUser: 5,
		RateLimitPerSec:    100,
	}
	handler, err := NewMux(cfg)
	if err != nil {
		t.Fatalf("NewMux failed: %v", err)
	}

	// 1. /healthz
	reqHealth := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recHealth := httptest.NewRecorder()
	handler.ServeHTTP(recHealth, reqHealth)
	if recHealth.Code != http.StatusOK || !strings.Contains(recHealth.Body.String(), `"status":"ok"`) {
		t.Fatalf("unexpected /healthz response: %d %s", recHealth.Code, recHealth.Body.String())
	}

	// 2. /metrics
	reqMetrics := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	recMetrics := httptest.NewRecorder()
	handler.ServeHTTP(recMetrics, reqMetrics)
	if recMetrics.Code != http.StatusOK || !strings.Contains(recMetrics.Body.String(), "webssh_gateway_active_sessions") {
		t.Fatalf("unexpected /metrics response: %d %s", recMetrics.Code, recMetrics.Body.String())
	}

	// 3. /ws blocks disallowed Origin
	reqBadOrigin := httptest.NewRequest(http.MethodGet, "/ws", nil)
	reqBadOrigin.Header.Set("Origin", "https://evil.example.com")
	recBadOrigin := httptest.NewRecorder()
	handler.ServeHTTP(recBadOrigin, reqBadOrigin)
	if recBadOrigin.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for bad Origin, got %d", recBadOrigin.Code)
	}

	// 4. /ws blocks SSRF metadata target
	reqSSRF := httptest.NewRequest(http.MethodGet, "/ws?host=169.254.169.254", nil)
	reqSSRF.Header.Set("Origin", "https://app.webssh.studio")
	recSSRF := httptest.NewRecorder()
	handler.ServeHTTP(recSSRF, reqSSRF)
	if recSSRF.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for SSRF target 169.254.169.254, got %d", recSSRF.Code)
	}
}
