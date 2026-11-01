package audit

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

type EventType string

const (
	EventConnect       EventType = "session.connect"
	EventDisconnect    EventType = "session.disconnect"
	EventResume        EventType = "session.resume"
	EventAuthSuccess   EventType = "ssh.auth_success"
	EventAuthFailure   EventType = "ssh.auth_failure"
	EventPolicyDenied  EventType = "policy.denied"
	EventSftpTransfer  EventType = "sftp.transfer_meta"
)

// Entry strictly records metadata only — never terminal content, key material, or passwords.
type Entry struct {
	Timestamp      string    `json:"timestamp"`
	Event          EventType `json:"event"`
	SessionID      string    `json:"sessionId,omitempty"`
	UserID         string    `json:"userId"`
	TargetHost     string    `json:"targetHost"`
	TargetPort     int       `json:"targetPort"`
	TargetUser     string    `json:"targetUser,omitempty"`
	KeyFingerprint string    `json:"keyFingerprint,omitempty"`
	BytesCount     int64     `json:"bytesCount,omitempty"`
	Reason         string    `json:"reason,omitempty"`
}

type Logger struct {
	mu      sync.Mutex
	out     io.Writer
	recent  []Entry
	maxKeep int
}

func NewLogger(out io.Writer, maxKeep int) *Logger {
	if maxKeep <= 0 {
		maxKeep = 500
	}
	return &Logger{
		out:     out,
		maxKeep: maxKeep,
	}
}

func (l *Logger) Record(e Entry) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if e.Timestamp == "" {
		e.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	l.recent = append(l.recent, e)
	if len(l.recent) > l.maxKeep {
		l.recent = l.recent[len(l.recent)-l.maxKeep:]
	}
	if l.out != nil {
		b, err := json.Marshal(e)
		if err == nil {
			_, _ = l.out.Write(append(b, byte(10)))
		}
	}
}

func (l *Logger) Recent() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	cp := make([]Entry, len(l.recent))
	copy(cp, l.recent)
	return cp
}
