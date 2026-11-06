package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/webssh-studio/gateway/internal/protocol"
	"golang.org/x/crypto/ssh"
)

const (
	execStreamFlushBytes = 32 * 1024
	execStreamFlushDelay = 100 * time.Millisecond
	maxExecStreams       = 4
)

// outputBatcher groups one stream's output: a batch is sent once 32 KiB is
// buffered, or 100 ms after its first byte. Close flushes the rest; anything
// written after Close is dropped.
type outputBatcher struct {
	mu     sync.Mutex
	send   func([]byte)
	buf    []byte
	timer  *time.Timer
	gen    uint64
	closed bool
}

func newOutputBatcher(send func([]byte)) *outputBatcher {
	return &outputBatcher{send: send}
}

func (b *outputBatcher) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return len(p), nil
	}
	b.buf = append(b.buf, p...)
	for len(b.buf) >= execStreamFlushBytes {
		b.send(b.buf[:execStreamFlushBytes])
		b.buf = append([]byte(nil), b.buf[execStreamFlushBytes:]...)
	}
	if len(b.buf) > 0 && b.timer == nil {
		b.gen++
		gen := b.gen
		b.timer = time.AfterFunc(execStreamFlushDelay, func() { b.flushTimed(gen) })
	}
	return len(p), nil
}

func (b *outputBatcher) flushTimed(gen uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed || gen != b.gen {
		return
	}
	b.timer = nil
	b.flushLocked()
}

func (b *outputBatcher) flushLocked() {
	if len(b.buf) > 0 {
		b.send(b.buf)
		b.buf = nil
	}
}

func (b *outputBatcher) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.flushLocked()
}

// execStream is one running exec_stream command.
type execStream struct {
	opID   string
	start  time.Time
	owner  *execStreams
	stdout *outputBatcher
	stderr *outputBatcher

	mu   sync.Mutex
	sess *ssh.Session
	done bool
	once sync.Once
}

// execStreams tracks one connection's streams and enforces the limit.
type execStreams struct {
	mu     sync.Mutex
	active map[string]*execStream
	gauge  *atomic.Int64
	send   func(protocol.ControlMessage) error
}

func newExecStreams(gauge *atomic.Int64, send func(protocol.ControlMessage) error) *execStreams {
	return &execStreams{active: make(map[string]*execStream), gauge: gauge, send: send}
}

// start reserves a slot synchronously, so the limit and duplicate checks see
// requests in arrival order, then runs the command in the background.
func (s *execStreams) start(client *ssh.Client, msg protocol.ControlMessage) {
	refuse := func(reason string) {
		_ = s.send(protocol.ControlMessage{Type: "exec_stream_end", OpID: msg.OpID, OK: false, Error: reason})
	}
	if client == nil {
		refuse("SSH session not connected")
		return
	}
	s.mu.Lock()
	switch {
	case s.active[msg.OpID] != nil:
		s.mu.Unlock()
		refuse("duplicate opId")
		return
	case len(s.active) >= maxExecStreams:
		s.mu.Unlock()
		refuse(fmt.Sprintf("too many concurrent streams (max %d)", maxExecStreams))
		return
	}
	st := &execStream{opID: msg.OpID, start: time.Now(), owner: s}
	st.stdout = newOutputBatcher(st.output("stdout"))
	st.stderr = newOutputBatcher(st.output("stderr"))
	s.active[msg.OpID] = st
	s.gauge.Add(1)
	s.mu.Unlock()

	go st.run(client, msg.Command, time.Duration(msg.TimeoutMs)*time.Millisecond)
}

// cancel stops a running stream. Unknown and finished opIds are ignored.
func (s *execStreams) cancel(opID string) {
	s.mu.Lock()
	st := s.active[opID]
	s.mu.Unlock()
	if st != nil {
		st.stop("cancelled", true)
	}
}

// closeAll ends every stream without reporting: the socket is going away.
func (s *execStreams) closeAll() {
	s.mu.Lock()
	streams := make([]*execStream, 0, len(s.active))
	for _, st := range s.active {
		streams = append(streams, st)
	}
	s.mu.Unlock()
	for _, st := range streams {
		st.stop("", false)
	}
}

func (st *execStream) output(stream string) func([]byte) {
	return func(p []byte) {
		_ = st.owner.send(protocol.ControlMessage{
			Type:       "exec_output",
			OpID:       st.opID,
			Stream:     stream,
			DataBase64: base64.StdEncoding.EncodeToString(p),
		})
	}
}

func (st *execStream) run(client *ssh.Client, command string, timeout time.Duration) {
	sess, err := client.NewSession()
	if err != nil {
		st.finish(protocol.ControlMessage{Error: err.Error()}, true)
		return
	}
	defer sess.Close()
	st.mu.Lock()
	if st.done {
		st.mu.Unlock()
		return
	}
	st.sess = sess
	st.mu.Unlock()

	sess.Stdout = st.stdout
	sess.Stderr = st.stderr
	if timeout > 0 {
		timer := time.AfterFunc(timeout, func() {
			st.stop(fmt.Sprintf("timed out after %d ms", timeout.Milliseconds()), true)
		})
		defer timer.Stop()
	}
	// Wait returns only after the output copies finish, so finish flushes
	// everything the command printed before the end is sent.
	if err := sess.Start(command); err != nil {
		st.finish(protocol.ControlMessage{Error: err.Error()}, true)
		return
	}
	st.finish(execStreamOutcome(sess.Wait()), true)
}

// execStreamOutcome turns Wait's result into the end message fields.
func execStreamOutcome(err error) protocol.ControlMessage {
	var exitErr *ssh.ExitError
	var missing *ssh.ExitMissingError
	switch {
	case err == nil:
		return protocol.ControlMessage{OK: true}
	case errors.As(err, &exitErr) && exitErr.Signal() != "":
		return protocol.ControlMessage{ExitCode: exitErr.ExitStatus(), Error: "killed by signal " + exitErr.Signal()}
	case errors.As(err, &exitErr):
		return protocol.ControlMessage{ExitCode: exitErr.ExitStatus()}
	case errors.As(err, &missing):
		return protocol.ControlMessage{Error: "channel closed before the command reported an exit status"}
	default:
		return protocol.ControlMessage{Error: err.Error()}
	}
}

// stop signals the command, closes its channel and ends the stream at once.
func (st *execStream) stop(reason string, report bool) {
	st.mu.Lock()
	sess := st.sess
	st.mu.Unlock()
	if sess != nil {
		_ = sess.Signal(ssh.SIGTERM)
		_ = sess.Close()
	}
	st.finish(protocol.ControlMessage{Error: reason}, report)
}

// finish runs once per stream: flush output, free the slot, then send the end.
func (st *execStream) finish(end protocol.ControlMessage, report bool) {
	st.once.Do(func() {
		st.mu.Lock()
		st.done = true
		st.mu.Unlock()
		st.stdout.Close()
		st.stderr.Close()

		s := st.owner
		s.mu.Lock()
		delete(s.active, st.opID)
		s.gauge.Add(-1)
		s.mu.Unlock()

		if !report {
			return
		}
		end.Type = "exec_stream_end"
		end.OpID = st.opID
		end.DurationMs = time.Since(st.start).Milliseconds()
		_ = s.send(end)
	})
}
