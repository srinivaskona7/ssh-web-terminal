package session

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestRingBufferReplayAndWrapResync(t *testing.T) {
	rb := NewRingBuffer(32)
	s1 := rb.Append(1, []byte("1234567890")) // 10B, seq 1
	s2 := rb.Append(1, []byte("abcdefghij")) // 20B, seq 2
	s3 := rb.Append(1, []byte("klmnopqrst")) // 30B, seq 3

	if s1 != 1 || s2 != 2 || s3 != 3 {
		t.Fatalf("unexpected seq numbers: %d %d %d", s1, s2, s3)
	}

	frames, wrapped, firstSeq, lastSeq, _ := rb.ReplayFrom(1)
	if wrapped {
		t.Fatal("expected wrapped=false when buffer has not evicted")
	}
	if firstSeq != 1 || lastSeq != 3 || len(frames) != 2 {
		t.Fatalf("unexpected replay: first=%d last=%d len=%d", firstSeq, lastSeq, len(frames))
	}
	if !bytes.Equal(frames[0].Payload, []byte("abcdefghij")) || !bytes.Equal(frames[1].Payload, []byte("klmnopqrst")) {
		t.Fatalf("unexpected replayed payloads")
	}

	// Push another 10B frame -> evicts seq 1 (30+10 > 32)
	rb.Append(1, []byte("uvwxyz0123")) // seq 4
	frames2, wrapped2, firstSeq2, lastSeq2, trunc := rb.ReplayFrom(0)
	if !wrapped2 {
		t.Fatal("expected wrapped=true when client requests seq 0 after seq 1 was evicted")
	}
	if firstSeq2 != 2 || lastSeq2 != 4 || len(frames2) != 3 || trunc != 10 {
		t.Fatalf("unexpected wrap state: first=%d last=%d len=%d trunc=%d", firstSeq2, lastSeq2, len(frames2), trunc)
	}
}

func TestManagerLifecycleAndGraceExpiry(t *testing.T) {
	mgr := NewManager(1024, 50*time.Millisecond, 2)

	s1, err := mgr.Create("alice", "host1.example.com", 22, "ubuntu")
	if err != nil {
		t.Fatalf("Create s1 failed: %v", err)
	}
	_, err = mgr.Create("alice", "host2.example.com", 22, "ubuntu")
	if err != nil {
		t.Fatalf("Create s2 failed: %v", err)
	}
	if _, err := mgr.Create("alice", "host3.example.com", 22, "ubuntu"); !errors.Is(err, ErrMaxSessions) {
		t.Fatalf("expected ErrMaxSessions on 3rd session, got %v", err)
	}

	s1.Buffer.Append(1, []byte("hello world"))
	mgr.Detach(s1.ID)

	if _, _, _, _, _, _, err := mgr.Resume(s1.ID, "wrong-token", 0); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("expected ErrInvalidToken, got %v", err)
	}

	resumed, frames, wrapped, _, _, _, err := mgr.Resume(s1.ID, s1.ResumeToken, 0)
	if err != nil {
		t.Fatalf("Resume failed: %v", err)
	}
	if resumed.ID != s1.ID || wrapped || len(frames) != 1 {
		t.Fatalf("unexpected resumed state: frames=%d wrapped=%v", len(frames), wrapped)
	}

	mgr.Detach(s1.ID)
	time.Sleep(80 * time.Millisecond)
	if _, _, _, _, _, _, err := mgr.Resume(s1.ID, s1.ResumeToken, 0); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("expected expired session after grace period, got %v", err)
	}
}

func TestConcurrentSessionCreatesIsolate(t *testing.T) {
	mgr := NewManager(1024, time.Minute, 100)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	ids := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			s, err := mgr.Create("alice", fmt.Sprintf("host%d.example.com", n), 22, "ubuntu")
			if err != nil {
				errs <- err
				return
			}
			s.Buffer.Append(1, []byte(fmt.Sprintf("marker-%d", n)))
			ids <- s.ID
		}(i)
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent create failed: %v", err)
	}
	got := make(map[string]bool)
	for id := range ids {
		got[id] = true
	}
	if len(got) != 20 {
		t.Fatalf("expected 20 distinct sessions, got %d", len(got))
	}
}
