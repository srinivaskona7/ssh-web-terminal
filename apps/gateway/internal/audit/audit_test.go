package audit

import (
	"bytes"
	"strings"
	"testing"
)

func TestAuditLoggerRecordsMetadataOnly(t *testing.T) {
	var buf bytes.Buffer
	logger := NewLogger(&buf, 10)

	logger.Record(Entry{
		Event:          EventConnect,
		SessionID:      "sess_123",
		UserID:         "alice@example.com",
		TargetHost:     "prod.example.com",
		TargetPort:     22,
		TargetUser:     "ubuntu",
		KeyFingerprint: "SHA256:abcdef",
	})

	entries := logger.Recent()
	if len(entries) != 1 {
		t.Fatalf("expected 1 audit entry, got %d", len(entries))
	}
	if entries[0].Timestamp == "" {
		t.Fatal("expected RFC3339 timestamp to be populated")
	}
	output := buf.String()
	if !strings.Contains(output, `"event":"session.connect"`) || !strings.Contains(output, `"keyFingerprint":"SHA256:abcdef"`) {
		t.Fatalf("unexpected JSON audit log line: %s", output)
	}
}
