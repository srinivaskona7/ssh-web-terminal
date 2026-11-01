package session

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

const (
	DefaultRingBufferBytes = 4 * 1024 * 1024 // 4 MiB default ring buffer
	DefaultSessionGrace    = 15 * time.Minute
)

var (
	ErrSessionNotFound = errors.New("session: session not found or expired")
	ErrInvalidToken    = errors.New("session: invalid resume token")
	ErrMaxSessions     = errors.New("session: maximum sessions per user exceeded")
)

type BufferedFrame struct {
	Channel uint16
	Seq     uint64
	Payload []byte
}

type RingBuffer struct {
	mu       sync.Mutex
	maxBytes int
	used     int
	frames   []BufferedFrame
	lastSeq  uint64
	evicted  uint64
	evictB   int
}

func NewRingBuffer(maxBytes int) *RingBuffer {
	if maxBytes <= 0 {
		maxBytes = DefaultRingBufferBytes
	}
	return &RingBuffer{
		maxBytes: maxBytes,
	}
}

func (rb *RingBuffer) Append(channel uint16, payload []byte) uint64 {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	rb.lastSeq++
	seq := rb.lastSeq

	cp := make([]byte, len(payload))
	copy(cp, payload)

	// If single payload exceeds maxBytes, truncate from front of payload
	if len(cp) > rb.maxBytes {
		dropped := len(cp) - rb.maxBytes
		cp = cp[dropped:]
		rb.evictB += dropped
	}

	for rb.used+len(cp) > rb.maxBytes && len(rb.frames) > 0 {
		oldest := rb.frames[0]
		rb.frames = rb.frames[1:]
		rb.used -= len(oldest.Payload)
		rb.evicted = oldest.Seq
		rb.evictB += len(oldest.Payload)
	}

	rb.frames = append(rb.frames, BufferedFrame{
		Channel: channel,
		Seq:     seq,
		Payload: cp,
	})
	rb.used += len(cp)
	return seq
}

func (rb *RingBuffer) ReplayFrom(lastClientSeq uint64) (frames []BufferedFrame, wrapped bool, firstAvailableSeq uint64, lastSeq uint64, truncatedBytes int) {
	rb.mu.Lock()
	defer rb.mu.Unlock()

	lastSeq = rb.lastSeq
	if len(rb.frames) == 0 {
		return nil, false, lastSeq, lastSeq, 0
	}

	firstAvailableSeq = rb.frames[0].Seq
	if lastClientSeq+1 < firstAvailableSeq {
		wrapped = true
		truncatedBytes = rb.evictB
	}

	for _, f := range rb.frames {
		if f.Seq > lastClientSeq {
			cp := make([]byte, len(f.Payload))
			copy(cp, f.Payload)
			frames = append(frames, BufferedFrame{
				Channel: f.Channel,
				Seq:     f.Seq,
				Payload: cp,
			})
		}
	}
	return frames, wrapped, firstAvailableSeq, lastSeq, truncatedBytes
}

type Session struct {
	ID          string
	UserID      string
	Host        string
	Port        int
	TargetUser  string
	ResumeToken string
	Buffer      *RingBuffer
	CreatedAt   time.Time
	DetachedAt  time.Time
	Detached    bool
}

type Manager struct {
	mu              sync.Mutex
	sessions        map[string]*Session
	ringBufferBytes int
	gracePeriod     time.Duration
	maxPerUser      int
}

func NewManager(ringBufferBytes int, gracePeriod time.Duration, maxPerUser int) *Manager {
	if ringBufferBytes <= 0 {
		ringBufferBytes = DefaultRingBufferBytes
	}
	if gracePeriod <= 0 {
		gracePeriod = DefaultSessionGrace
	}
	if maxPerUser <= 0 {
		maxPerUser = 10
	}
	return &Manager{
		sessions:        make(map[string]*Session),
		ringBufferBytes: ringBufferBytes,
		gracePeriod:     gracePeriod,
		maxPerUser:      maxPerUser,
	}
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Manager) Create(userID, host string, port int, targetUser string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	m.pruneLocked(now)

	count := 0
	for _, s := range m.sessions {
		if s.UserID == userID {
			count++
		}
	}
	if count >= m.maxPerUser {
		return nil, ErrMaxSessions
	}

	sess := &Session{
		ID:          "sess_" + randomHex(12),
		UserID:      userID,
		Host:        host,
		Port:        port,
		TargetUser:  targetUser,
		ResumeToken: randomHex(24),
		Buffer:      NewRingBuffer(m.ringBufferBytes),
		CreatedAt:   now,
	}
	m.sessions[sess.ID] = sess
	return sess, nil
}

func (m *Manager) Detach(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[sessionID]; ok {
		s.Detached = true
		s.DetachedAt = time.Now()
	}
}

func (m *Manager) Resume(sessionID, token string, lastSeq uint64) (*Session, []BufferedFrame, bool, uint64, uint64, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.pruneLocked(time.Now())

	s, ok := m.sessions[sessionID]
	if !ok {
		return nil, nil, false, 0, 0, 0, ErrSessionNotFound
	}
	if subtle.ConstantTimeCompare([]byte(s.ResumeToken), []byte(token)) != 1 {
		return nil, nil, false, 0, 0, 0, ErrInvalidToken
	}

	s.Detached = false
	s.DetachedAt = time.Time{}
	frames, wrapped, firstSeq, currentLastSeq, trunc := s.Buffer.ReplayFrom(lastSeq)
	return s, frames, wrapped, firstSeq, currentLastSeq, trunc, nil
}

func (m *Manager) Close(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, sessionID)
}

func (m *Manager) ActiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(time.Now())
	return len(m.sessions)
}

func (m *Manager) pruneLocked(now time.Time) {
	for id, s := range m.sessions {
		if s.Detached && now.Sub(s.DetachedAt) > m.gracePeriod {
			delete(m.sessions, id)
		}
	}
}
