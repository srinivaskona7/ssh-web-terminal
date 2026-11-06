package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/webssh-studio/gateway/internal/protocol"
	"github.com/webssh-studio/gateway/internal/testsshd"
)

type streamEvent struct {
	msg  protocol.ControlMessage
	raw  []byte
	at   time.Time
	data string // decoded exec_output payload
}

func readStreamEvent(t *testing.T, ws *testWSClient, timeout time.Duration) streamEvent {
	t.Helper()
	for {
		ctrl, raw := ws.nextControl(t, timeout)
		if ctrl.Type != "exec_output" && ctrl.Type != "exec_stream_end" {
			continue
		}
		ev := streamEvent{msg: ctrl, raw: raw, at: time.Now()}
		if ctrl.Type == "exec_output" {
			data, err := base64.StdEncoding.DecodeString(ctrl.DataBase64)
			if err != nil {
				t.Fatalf("exec_output carried invalid base64: %v", err)
			}
			ev.data = string(data)
		}
		return ev
	}
}

// collectUntilEnd returns opID's events up to and including its first
// exec_stream_end, plus every event that belonged to another stream.
func collectUntilEnd(t *testing.T, ws *testWSClient, opID string, timeout time.Duration) (mine []streamEvent, others []streamEvent) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		ev := readStreamEvent(t, ws, time.Until(deadline))
		if ev.msg.OpID != opID {
			others = append(others, ev)
			continue
		}
		mine = append(mine, ev)
		if ev.msg.Type == "exec_stream_end" {
			return mine, others
		}
	}
}

func streamText(events []streamEvent, stream string) string {
	var b strings.Builder
	for _, ev := range events {
		if ev.msg.Type == "exec_output" && ev.msg.Stream == stream {
			b.WriteString(ev.data)
		}
	}
	return b.String()
}

// expectOutput waits until opID has printed want on stream, failing if the
// stream ends first.
func expectOutput(t *testing.T, ws *testWSClient, opID, stream, want string) {
	t.Helper()
	var got strings.Builder
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(got.String(), want) {
		ev := readStreamEvent(t, ws, time.Until(deadline))
		if ev.msg.OpID != opID {
			continue
		}
		if ev.msg.Type == "exec_stream_end" {
			t.Fatalf("stream %s ended (%s) before printing %q on %s; had %q", opID, ev.raw, want, stream, got.String())
		}
		if ev.msg.Stream == stream {
			got.WriteString(ev.data)
		}
	}
}

func endOf(t *testing.T, events []streamEvent) streamEvent {
	t.Helper()
	ends := 0
	for _, ev := range events {
		if ev.msg.Type == "exec_stream_end" {
			ends++
		}
	}
	last := events[len(events)-1]
	if ends != 1 || last.msg.Type != "exec_stream_end" {
		t.Fatalf("expected exactly one exec_stream_end, last, got %d ends in %d events", ends, len(events))
	}
	return last
}

func startStream(t *testing.T, ws *testWSClient, opID, command string) {
	t.Helper()
	if err := ws.sendControl(protocol.ControlMessage{Type: "exec_stream", OpID: opID, Command: command}); err != nil {
		t.Fatalf("send exec_stream %s failed: %v", opID, err)
	}
}

func cancelStream(t *testing.T, ws *testWSClient, opID string) {
	t.Helper()
	if err := ws.sendControl(protocol.ControlMessage{Type: "exec_cancel", OpID: opID}); err != nil {
		t.Fatalf("send exec_cancel %s failed: %v", opID, err)
	}
}

// expectNothingFor runs a short probe stream to completion and fails if any
// message for the given opIDs arrived meanwhile.
func expectNothingFor(t *testing.T, ws *testWSClient, opIDs ...string) {
	t.Helper()
	startStream(t, ws, "quiet-probe", "sleep 0.3")
	_, others := collectUntilEnd(t, ws, "quiet-probe", 10*time.Second)
	for _, ev := range others {
		if slices.Contains(opIDs, ev.msg.OpID) {
			t.Fatalf("unexpected message for %s: %s", ev.msg.OpID, ev.raw)
		}
	}
}

func metricsBody(t *testing.T, baseURL string) string {
	t.Helper()
	resp, err := http.Get(baseURL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics failed: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return string(body)
}

func waitForStreamsToDrain(t *testing.T) {
	t.Helper()
	waitFor(t, 10*time.Second, "exec-stream goroutines to exit", func() bool { return execStreamGoroutines() == 0 })
}

func TestOutputBatcherFlushesAt32KiBOrAfter100ms(t *testing.T) {
	sent := make(chan []byte, 16)
	b := newOutputBatcher(func(p []byte) { sent <- append([]byte(nil), p...) })
	next := func(what string) []byte {
		t.Helper()
		select {
		case p := <-sent:
			return p
		case <-time.After(2 * time.Second):
			t.Fatalf("no flush for %s", what)
			return nil
		}
	}
	expectNone := func(what string) {
		t.Helper()
		select {
		case p := <-sent:
			t.Fatalf("%s: unexpected flush of %d bytes", what, len(p))
		default:
		}
	}

	start := time.Now()
	_, _ = b.Write([]byte("hello"))
	expectNone("a small write must wait for the delay")
	if p := next("the delayed batch"); string(p) != "hello" {
		t.Fatalf("expected the delayed batch to be %q, got %q", "hello", p)
	}
	if elapsed := time.Since(start); elapsed < 95*time.Millisecond {
		t.Fatalf("a small write flushed after %s, before the 100 ms delay", elapsed)
	}

	_, _ = b.Write(bytes.Repeat([]byte("x"), 40*1024))
	select {
	case p := <-sent:
		if len(p) != 32*1024 {
			t.Fatalf("expected a full 32 KiB batch, got %d bytes", len(p))
		}
	default:
		t.Fatal("a full 32 KiB batch must flush during Write, without waiting for the timer")
	}
	expectNone("the remainder must wait for the delay")
	if p := next("the remainder"); len(p) != 8*1024 {
		t.Fatalf("expected the 8 KiB remainder, got %d bytes", len(p))
	}

	_, _ = b.Write([]byte("tail"))
	b.Close()
	select {
	case p := <-sent:
		if string(p) != "tail" {
			t.Fatalf("Close flushed %q, want %q", p, "tail")
		}
	default:
		t.Fatal("Close must flush what is buffered before returning")
	}
	if n, err := b.Write([]byte("late")); n != 4 || err != nil {
		t.Fatalf("a write after Close must be absorbed, got n=%d err=%v", n, err)
	}
	time.Sleep(150 * time.Millisecond)
	expectNone("a write after Close must never be sent")
}

func TestExecStreamBeforeConnectReportsTheDisconnect(t *testing.T) {
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	startStream(t, ws, "early", "uptime")
	events, _ := collectUntilEnd(t, ws, "early", 5*time.Second)
	end := endOf(t, events)
	if end.msg.OK || end.msg.Error != "SSH session not connected" {
		t.Fatalf("expected a not-connected end, got %s", end.raw)
	}
}

func TestExecStreamDeliversOutputBeforeExitAndReportsTheRealExitCode(t *testing.T) {
	sshd := newTestSSHD(t, "secret-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()
	ws.connect(t, passwordConnect(sshd, "secret-pass"), nil).mustConnect(t)

	startStream(t, ws, "build", `printf 'out-1\n'; printf 'err-1\n' >&2; sleep 1; printf 'out-2\n'; exit 3`)
	events, _ := collectUntilEnd(t, ws, "build", 15*time.Second)
	end := endOf(t, events)

	if got := streamText(events, "stdout"); got != "out-1\nout-2\n" {
		t.Fatalf("stdout = %q", got)
	}
	if got := streamText(events, "stderr"); got != "err-1\n" {
		t.Fatalf("stderr = %q", got)
	}
	// The first lines must arrive while the command is still sleeping, not
	// when it exits.
	var firstOut, firstErr time.Time
	for _, ev := range events {
		if ev.msg.Stream == "stdout" && strings.Contains(ev.data, "out-1") && firstOut.IsZero() {
			firstOut = ev.at
		}
		if ev.msg.Stream == "stderr" && strings.Contains(ev.data, "err-1") && firstErr.IsZero() {
			firstErr = ev.at
		}
	}
	if firstOut.IsZero() || firstErr.IsZero() {
		t.Fatalf("expected separate stdout and stderr batches, got %d events", len(events))
	}
	latest := firstOut
	if firstErr.After(latest) {
		latest = firstErr
	}
	if gap := end.at.Sub(latest); gap < 400*time.Millisecond {
		t.Fatalf("early output arrived only %s before the end; it was held until exit", gap)
	}
	if end.msg.OK || end.msg.ExitCode != 3 || end.msg.Error != "" {
		t.Fatalf("expected ok:false exitCode:3 without an error, got %s", end.raw)
	}
	if end.msg.DurationMs < 1000 {
		t.Fatalf("expected durationMs to cover the 1 s sleep, got %d", end.msg.DurationMs)
	}

	// A clean exit omits exitCode and error.
	startStream(t, ws, "clean", "printf 'done'")
	events, _ = collectUntilEnd(t, ws, "clean", 10*time.Second)
	end = endOf(t, events)
	if !end.msg.OK || strings.Contains(string(end.raw), `"exitCode"`) || strings.Contains(string(end.raw), `"error"`) {
		t.Fatalf("expected ok:true with no exitCode or error, got %s", end.raw)
	}
	if got := streamText(events, "stdout"); got != "done" {
		t.Fatalf("stdout = %q", got)
	}

	// A command killed by a signal names the signal.
	startStream(t, ws, "killed", "printf 'x'; kill -TERM $$")
	events, _ = collectUntilEnd(t, ws, "killed", 10*time.Second)
	end = endOf(t, events)
	if end.msg.OK || !strings.Contains(end.msg.Error, "TERM") || end.msg.ExitCode != 143 {
		t.Fatalf("expected ok:false exitCode:143 naming TERM, got %s", end.raw)
	}

	// Exactly one end per opId: nothing more arrives for the finished streams.
	expectNothingFor(t, ws, "build", "clean", "killed")
}

func TestExecStreamFollowsAGrowingFile(t *testing.T) {
	sshd := newTestSSHD(t, "secret-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()
	ws.connect(t, passwordConnect(sshd, "secret-pass"), nil).mustConnect(t)

	logPath := filepath.Join(sshd.RootDir(), "app.log")
	startStream(t, ws, "follow", "tail -F app.log")
	// The file does not exist yet: tail -F says so on stderr and keeps waiting.
	expectOutput(t, ws, "follow", "stderr", "cannot open 'app.log'")

	if err := os.WriteFile(logPath, []byte("line-1\n"), 0o644); err != nil {
		t.Fatalf("write log failed: %v", err)
	}
	expectOutput(t, ws, "follow", "stdout", "line-1")

	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open log failed: %v", err)
	}
	_, _ = f.WriteString("line-2\n")
	_ = f.Close()
	expectOutput(t, ws, "follow", "stdout", "line-2")

	cancelStream(t, ws, "follow")
	events, _ := collectUntilEnd(t, ws, "follow", 10*time.Second)
	end := endOf(t, events)
	if end.msg.OK || end.msg.Error != "cancelled" {
		t.Fatalf("expected a cancelled end, got %s", end.raw)
	}
}

func TestExecCancelStopsANeverEndingCommandAndReleasesIt(t *testing.T) {
	waitForStreamsToDrain(t)
	sshd := newTestSSHD(t, "secret-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()
	ws.connect(t, passwordConnect(sshd, "secret-pass"), nil).mustConnect(t)
	baseline := sshd.OpenSessions() // the PTY and SFTP sessions

	startStream(t, ws, "forever", "tail -f /dev/null")
	waitFor(t, 5*time.Second, "the stream's SSH session to open", func() bool { return sshd.OpenSessions() == baseline+1 })
	// The goroutine check must see a live stream, or a pass below proves nothing.
	if execStreamGoroutines() == 0 {
		t.Fatal("expected a live exec-stream goroutine while tail -f runs")
	}

	cancelStream(t, ws, "forever")
	events, _ := collectUntilEnd(t, ws, "forever", 10*time.Second)
	end := endOf(t, events)
	if end.msg.OK || end.msg.Error != "cancelled" || strings.Contains(string(end.raw), `"exitCode"`) {
		t.Fatalf("expected ok:false error:cancelled without an exit code, got %s", end.raw)
	}

	waitFor(t, 5*time.Second, "the server-side session to close", func() bool { return sshd.OpenSessions() == baseline })
	waitForStreamsToDrain(t)
	if !slices.Contains(sshd.ReceivedSignals(), "TERM") {
		t.Fatalf("expected the command to receive TERM, got %v", sshd.ReceivedSignals())
	}

	// Cancelling a finished or unknown stream is ignored.
	cancelStream(t, ws, "forever")
	cancelStream(t, ws, "never-started")
	expectNothingFor(t, ws, "forever", "never-started")
}

func TestExecStreamRejectsAFifthStreamAndDuplicateOpIDs(t *testing.T) {
	waitForStreamsToDrain(t)
	sshd := newTestSSHD(t, "secret-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()
	ws.connect(t, passwordConnect(sshd, "secret-pass"), nil).mustConnect(t)
	baseline := sshd.OpenSessions()

	for i := 1; i <= 4; i++ {
		startStream(t, ws, fmt.Sprintf("s%d", i), "sleep 100")
	}
	startStream(t, ws, "s5", "sleep 100")
	startStream(t, ws, "s1", "printf 'dup'")

	events, _ := collectUntilEnd(t, ws, "s5", 5*time.Second)
	if end := endOf(t, events); end.msg.OK || end.msg.Error != "too many concurrent streams (max 4)" {
		t.Fatalf("expected the fifth stream to be refused, got %s", end.raw)
	}
	events, _ = collectUntilEnd(t, ws, "s1", 5*time.Second)
	if end := endOf(t, events); end.msg.OK || end.msg.Error != "duplicate opId" {
		t.Fatalf("expected the duplicate opId to be refused, got %s", end.raw)
	}

	waitFor(t, 5*time.Second, "four stream sessions", func() bool { return sshd.OpenSessions() == baseline+4 })
	if body := metricsBody(t, srv.URL); !strings.Contains(body, "webssh_gateway_exec_streams_active 4") {
		t.Fatalf("expected 4 active exec streams in /metrics, got %q", body)
	}

	// Ending one stream frees its slot.
	cancelStream(t, ws, "s2")
	events, _ = collectUntilEnd(t, ws, "s2", 10*time.Second)
	if end := endOf(t, events); end.msg.Error != "cancelled" {
		t.Fatalf("expected s2 to be cancelled, got %s", end.raw)
	}
	startStream(t, ws, "s5", "printf 'fits-now'")
	events, _ = collectUntilEnd(t, ws, "s5", 10*time.Second)
	if end := endOf(t, events); !end.msg.OK || streamText(events, "stdout") != "fits-now" {
		t.Fatalf("expected s5 to run once a slot was free, got %s", end.raw)
	}

	// Closing the socket ends the remaining streams and their SSH sessions.
	_ = ws.conn.Close()
	waitFor(t, 10*time.Second, "every server-side session to close", func() bool { return sshd.OpenSessions() == 0 })
	waitForStreamsToDrain(t)
	if body := metricsBody(t, srv.URL); !strings.Contains(body, "webssh_gateway_exec_streams_active 0") {
		t.Fatalf("expected 0 active exec streams after the socket closed, got %q", body)
	}
}

func TestExecStreamEndsWhenTheSSHConnectionDrops(t *testing.T) {
	waitForStreamsToDrain(t)
	sshd, err := testsshd.NewServer(t.TempDir(), "secret-pass", nil)
	if err != nil {
		t.Fatalf("testsshd.NewServer failed: %v", err)
	}
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()
	ws.connect(t, passwordConnect(sshd, "secret-pass"), nil).mustConnect(t)
	baseline := sshd.OpenSessions()

	startStream(t, ws, "orphan", "sleep 100")
	waitFor(t, 5*time.Second, "the stream's SSH session to open", func() bool { return sshd.OpenSessions() == baseline+1 })
	_ = sshd.Close()

	events, _ := collectUntilEnd(t, ws, "orphan", 10*time.Second)
	end := endOf(t, events)
	if end.msg.OK || end.msg.Error == "" {
		t.Fatalf("expected ok:false with a reason once the SSH connection dropped, got %s", end.raw)
	}
	waitForStreamsToDrain(t)
}
