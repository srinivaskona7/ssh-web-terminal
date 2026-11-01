package protocol

import (
	"bytes"
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
