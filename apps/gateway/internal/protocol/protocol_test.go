package protocol

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	frames := []BinaryFrame{
		{Type: FrameTypeControl, Channel: 0, Seq: 1, Payload: []byte(`{"type":"hello"}`)},
		{Type: FrameTypePtyData, Channel: 1, Seq: 42, Payload: []byte("ls -la")},
		{Type: FrameTypeSftpData, Channel: 1024, Seq: 999999999, Payload: bytes.Repeat([]byte{0xab}, 4096)},
		{Type: FrameTypePing, Channel: 0, Seq: 7, Payload: nil},
		{Type: FrameTypePong, Channel: 0, Seq: 7, Payload: []byte{1, 2, 3, 4}},
	}

	for i, want := range frames {
		raw, err := EncodeFrame(want)
		if err != nil {
			t.Fatalf("case %d EncodeFrame failed: %v", i, err)
		}
		got, err := DecodeFrame(raw)
		if err != nil {
			t.Fatalf("case %d DecodeFrame failed: %v", i, err)
		}
		if got.Type != want.Type || got.Channel != want.Channel || got.Seq != want.Seq || !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("case %d mismatch: got %+v want %+v", i, got, want)
		}
	}
}

func TestControlFrameRoundTripAndValidation(t *testing.T) {
	msg := ControlMessage{
		Type:           "connect",
		Host:           "prod.example.com",
		Port:           22,
		User:           "ubuntu",
		KeyFingerprint: "SHA256:testfp",
		Cols:           120,
		Rows:           40,
	}
	raw, err := EncodeControlFrame(10, msg)
	if err != nil {
		t.Fatalf("EncodeControlFrame error: %v", err)
	}
	f, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("DecodeFrame error: %v", err)
	}
	decoded, err := DecodeControlPayload(f.Payload)
	if err != nil {
		t.Fatalf("DecodeControlPayload error: %v", err)
	}
	if decoded.Host != "prod.example.com" || decoded.User != "ubuntu" || decoded.Port != 22 {
		t.Fatalf("unexpected decoded control message: %+v", decoded)
	}

	if _, err := EncodeControlFrame(1, ControlMessage{}); err == nil {
		t.Fatal("expected error for empty control type")
	}
	if _, err := DecodeControlPayload([]byte(`not-json`)); err == nil {
		t.Fatal("expected error for invalid control JSON")
	}
	if _, err := DecodeControlPayload([]byte(`{}`)); err == nil {
		t.Fatal("expected error for missing type field")
	}
}

func TestFlowController(t *testing.T) {
	fc := NewFlowController(1024)
	if fc.Available(1) != 1024 {
		t.Fatalf("expected 1024 initial credit, got %d", fc.Available(1))
	}
	if !fc.Consume(1, 600) {
		t.Fatal("expected Consume(600) to succeed")
	}
	if fc.Consume(1, 500) {
		t.Fatal("expected Consume(500) to fail with 424 remaining")
	}
	if next := fc.Grant(1, 576); next != 1000 {
		t.Fatalf("expected 1000 after grant, got %d", next)
	}
	if !fc.Consume(1, 1000) {
		t.Fatal("expected Consume(1000) to succeed")
	}
}

// The browser client is written against these exact JSON names; a renamed tag
// would silently drop the field on one side of the wire.
func TestExecStreamEnvAndHopWireNames(t *testing.T) {
	msg := ControlMessage{
		Type:        "exec_output",
		Stream:      "stderr",
		HopIndex:    2,
		Env:         map[string]string{"LANG": "C.UTF-8"},
		EnvAccepted: []string{"LANG"},
		EnvRejected: []string{"SECRET"},
		Jump: []JumpHop{{
			Host:                 "bastion",
			Port:                 22,
			User:                 "ops",
			AuthMethod:           "password",
			Password:             "p",
			PublicKey:            "k",
			PrivateKeyPem:        "pem",
			PrivateKeyPassphrase: "pp",
			KeyFingerprint:       "SHA256:x",
		}},
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	for _, key := range []string{"stream", "hopIndex", "env", "envAccepted", "envRejected", "jump"} {
		if _, ok := top[key]; !ok {
			t.Fatalf("expected key %q in %s", key, raw)
		}
	}
	var hops []map[string]any
	if err := json.Unmarshal(top["jump"], &hops); err != nil {
		t.Fatalf("Unmarshal jump failed: %v", err)
	}
	for _, key := range []string{"host", "port", "user", "authMethod", "password", "publicKey", "privateKeyPem", "privateKeyPassphrase", "keyFingerprint"} {
		if _, ok := hops[0][key]; !ok {
			t.Fatalf("expected hop key %q in %s", key, top["jump"])
		}
	}

	// A hop that names no credential must stay credential-free on the wire.
	bare, _ := json.Marshal(JumpHop{Host: "b", Port: 22, User: "u"})
	if string(bare) != `{"host":"b","port":22,"user":"u"}` {
		t.Fatalf("expected a bare hop to omit every credential field, got %s", bare)
	}
}

func FuzzDecodeFrame(f *testing.F) {
	valid, _ := EncodeFrame(BinaryFrame{
		Type:    FrameTypePtyData,
		Channel: 1,
		Seq:     100,
		Payload: []byte("hello world"),
	})
	f.Add(valid)
	f.Add([]byte{0, 0, 0})
	f.Add([]byte{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 'o', 'k'})

	f.Fuzz(func(t *testing.T, data []byte) {
		frame, err := DecodeFrame(data)
		if err == nil {
			reencoded, err2 := EncodeFrame(frame)
			if err2 != nil {
				t.Fatalf("EncodeFrame failed after successful DecodeFrame: %v", err2)
			}
			if !bytes.Equal(reencoded, data) {
				t.Fatalf("round-trip mismatch")
			}
		}
	})
}
