package testsshd

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var (
	lf       = string([]byte{10})
	cr       = string([]byte{13})
	crlf     = string([]byte{13, 10})
	tabStr   = string([]byte{9})
	bsSeq    = string([]byte{8, 32, 8})
	escClear = string([]byte{27}) + "[2J" + string([]byte{27}) + "[H"
)

// Server is an embedded OpenSSH-compatible SSH + SFTP server for deterministic integration testing.
type Server struct {
	listener   net.Listener
	hostSigner ssh.Signer
	rootDir    string
	password   string

	mu             sync.RWMutex
	authorizedKeys map[string]bool
	conns          map[net.Conn]struct{}
	wg             sync.WaitGroup
	closed         chan struct{}

	// openSessions counts session channels whose handler and command
	// goroutines are still running; requestLog and signals record what
	// clients asked for, so tests can assert on the wire behaviour.
	openSessions atomic.Int64
	requestLog   [][]string
	signals      []string
}

func NewServer(rootDir string, password string, initialKeys []ssh.PublicKey) (*Server, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	hostSigner, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}

	s := &Server{
		listener:       ln,
		hostSigner:     hostSigner,
		rootDir:        rootDir,
		password:       password,
		authorizedKeys: make(map[string]bool),
		conns:          make(map[net.Conn]struct{}),
		closed:         make(chan struct{}),
	}
	for _, k := range initialKeys {
		s.authorizedKeys[string(k.Marshal())] = true
	}

	s.wg.Add(1)
	go s.acceptLoop()
	return s, nil
}

func (s *Server) Addr() string {
	return s.listener.Addr().String()
}

func (s *Server) HostPort() (string, int) {
	tcpAddr := s.listener.Addr().(*net.TCPAddr)
	return tcpAddr.IP.String(), tcpAddr.Port
}

func (s *Server) HostKey() ssh.PublicKey {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hostSigner.PublicKey()
}

func (s *Server) RootDir() string {
	return s.rootDir
}

// OpenSessions reports session channels that are still being served,
// including any command still running on one.
func (s *Server) OpenSessions() int {
	return int(s.openSessions.Load())
}

// RequestLog returns, per session channel in open order, the request types
// the client sent (for example "env", "pty-req", "shell").
func (s *Server) RequestLog() [][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([][]string, len(s.requestLog))
	for i, reqs := range s.requestLog {
		out[i] = append([]string(nil), reqs...)
	}
	return out
}

// ReceivedSignals returns the signal names delivered by "signal" requests.
func (s *Server) ReceivedSignals() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.signals...)
}

func (s *Server) logRequest(idx int, reqType string) {
	s.mu.Lock()
	s.requestLog[idx] = append(s.requestLog[idx], reqType)
	s.mu.Unlock()
}

func (s *Server) RotateHostKey() error {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.hostSigner = signer
	s.mu.Unlock()
	return nil
}

func (s *Server) Close() error {
	close(s.closed)
	err := s.listener.Close()
	s.mu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return err
}

func (s *Server) isKeyAuthorized(key ssh.PublicKey) bool {
	s.mu.RLock()
	if s.authorizedKeys[string(key.Marshal())] {
		s.mu.RUnlock()
		return true
	}
	s.mu.RUnlock()

	// Also check .ssh/authorized_keys in rootDir (for DeployAuthorizedKey / ssh-copy-id tests)
	akBytes, err := os.ReadFile(filepath.Join(s.rootDir, ".ssh", "authorized_keys"))
	if err != nil {
		return false
	}
	rest := akBytes
	for len(rest) > 0 {
		pub, _, _, next, err := ssh.ParseAuthorizedKey(rest)
		if err != nil {
			break
		}
		if bytes.Equal(pub.Marshal(), key.Marshal()) {
			return true
		}
		rest = next
	}
	return false
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-s.closed:
				return
			default:
				continue
			}
		}
		s.mu.Lock()
		s.conns[conn] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func(c net.Conn) {
			defer func() {
				s.mu.Lock()
				delete(s.conns, c)
				s.mu.Unlock()
				s.wg.Done()
			}()
			s.handleConn(c)
		}(conn)
	}
}

func (s *Server) handleConn(nConn net.Conn) {
	defer nConn.Close()

	cfg := &ssh.ServerConfig{
		ServerVersion: "SSH-2.0-OpenSSH_9.6_testsshd",
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if s.isKeyAuthorized(key) {
				return &ssh.Permissions{
					Extensions: map[string]string{"user": conn.User()},
				}, nil
			}
			return nil, errors.New("public key not authorized")
		},
		PasswordCallback: func(conn ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if s.password != "" && string(pass) == s.password {
				return &ssh.Permissions{
					Extensions: map[string]string{"user": conn.User()},
				}, nil
			}
			return nil, errors.New("invalid password")
		},
	}
	s.mu.RLock()
	cfg.AddHostKey(s.hostSigner)
	s.mu.RUnlock()

	sConn, chans, reqs, err := ssh.NewServerConn(nConn, cfg)
	if err != nil {
		return
	}
	user := sConn.User()
	if user == "" {
		user = "root"
	}
	go ssh.DiscardRequests(reqs)

	for newChan := range chans {
		switch newChan.ChannelType() {
		case "session":
			ch, requests, err := newChan.Accept()
			if err != nil {
				continue
			}
			go s.handleSessionChannel(user, ch, requests)
		case "direct-tcpip":
			s.handleDirectTCPIP(newChan)
		default:
			_ = newChan.Reject(ssh.UnknownChannelType, "unsupported channel type")
		}
	}
}

func (s *Server) handleDirectTCPIP(newChan ssh.NewChannel) {
	var msg struct {
		DestAddr   string
		DestPort   uint32
		OriginAddr string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(newChan.ExtraData(), &msg); err != nil {
		_ = newChan.Reject(ssh.Prohibited, "invalid direct-tcpip payload")
		return
	}
	target := net.JoinHostPort(msg.DestAddr, strconv.Itoa(int(msg.DestPort)))
	destConn, err := net.Dial("tcp", target)
	if err != nil {
		_ = newChan.Reject(ssh.ConnectionFailed, err.Error())
		return
	}
	ch, reqs, err := newChan.Accept()
	if err != nil {
		_ = destConn.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	go func() {
		defer ch.Close()
		defer destConn.Close()
		_, _ = io.Copy(ch, destConn)
	}()
	go func() {
		defer ch.Close()
		defer destConn.Close()
		_, _ = io.Copy(destConn, ch)
	}()
}

type shellState struct {
	user     string
	cwd      string // virtual path starting at "/" (mapped to s.rootDir)
	lastExit int
	env      map[string]string

	// done closes when the session channel closes; signals carries "signal"
	// requests. Long-running builtins (sleep, tail -f) stop on either.
	done     <-chan struct{}
	signals  <-chan string
	killedBy string
	// emit writes output immediately, before the command line finishes.
	emit func(stdout, stderr string)
}

// acceptEnv mirrors OpenSSH's stock "AcceptEnv LANG LC_*".
func acceptEnv(name string) bool {
	return name == "LANG" || strings.HasPrefix(name, "LC_")
}

var signalNumbers = map[string]int{"HUP": 1, "INT": 2, "QUIT": 3, "KILL": 9, "USR1": 10, "USR2": 12, "PIPE": 13, "ALRM": 14, "TERM": 15}

// signalName normalises "-TERM", "SIGTERM" and "15" to "TERM".
func signalName(spec string) string {
	spec = strings.TrimPrefix(strings.ToUpper(strings.TrimPrefix(spec, "-")), "SIG")
	if n, err := strconv.Atoi(spec); err == nil {
		for name, num := range signalNumbers {
			if num == n {
				return name
			}
		}
		return ""
	}
	if _, ok := signalNumbers[spec]; ok {
		return spec
	}
	return ""
}

func (st *shellState) kill(sig string) (int, bool) {
	st.killedBy = sig
	return 128 + signalNumbers[sig], true
}

// pause waits for d unless the channel closes or a signal arrives first.
func (st *shellState) pause(d time.Duration) (int, bool) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return 0, false
	case <-st.done:
		return 0, true
	case sig := <-st.signals:
		return st.kill(sig)
	}
}

func (st *shellState) pendingSignal() string {
	select {
	case sig := <-st.signals:
		return sig
	default:
		return ""
	}
}

func lastLines(data []byte, n int) string {
	text := strings.TrimSuffix(string(data), lf)
	if text == "" || n <= 0 {
		return ""
	}
	lines := strings.Split(text, lf)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, lf) + lf
}

// followFile behaves like tail -f (retry=false) or tail -F (retry=true):
// it prints the last lines, then streams appended bytes until stopped.
func (s *Server) followFile(st *shellState, target string, retry bool, lines int) (int, bool) {
	if target == "/dev/null" {
		for {
			if code, stopped := st.pause(time.Hour); stopped {
				return code, true
			}
		}
	}
	_, hostPath, err := s.resolveHostPath(st.cwd, target)
	if err != nil {
		st.emit("", fmt.Sprintf("tail: cannot open '%s' for reading: %v", target, err)+lf)
		return 1, false
	}
	offset := int64(-1) // -1 until the file has been opened
	missingReported := false
	for {
		info, statErr := os.Stat(hostPath)
		switch {
		case statErr != nil:
			if !missingReported {
				if offset >= 0 {
					st.emit("", fmt.Sprintf("tail: '%s' has become inaccessible: No such file or directory", target)+lf)
				} else {
					st.emit("", fmt.Sprintf("tail: cannot open '%s' for reading: No such file or directory", target)+lf)
				}
				if !retry {
					return 1, false
				}
				missingReported = true
			}
			offset = -1
		case offset < 0:
			data, _ := os.ReadFile(hostPath)
			if missingReported {
				st.emit("", fmt.Sprintf("tail: '%s' has appeared;  following new file", target)+lf)
				st.emit(string(data), "")
			} else {
				st.emit(lastLines(data, lines), "")
			}
			missingReported = false
			offset = int64(len(data))
		case info.Size() != offset:
			if info.Size() < offset {
				st.emit("", fmt.Sprintf("tail: %s: file truncated", target)+lf)
				offset = 0
			}
			if f, openErr := os.Open(hostPath); openErr == nil {
				chunk, _ := io.ReadAll(io.NewSectionReader(f, offset, info.Size()-offset))
				_ = f.Close()
				offset += int64(len(chunk))
				st.emit(string(chunk), "")
			}
		}
		if code, stopped := st.pause(50 * time.Millisecond); stopped {
			return code, true
		}
	}
}

func (s *Server) resolveHostPath(virtualCwd, target string) (string, string, error) {
	var virt string
	if strings.HasPrefix(target, "~/") {
		virt = path.Clean("/" + strings.TrimPrefix(target, "~/"))
	} else if target == "~" {
		virt = "/"
	} else if strings.HasPrefix(target, "/") {
		virt = path.Clean(target)
	} else {
		virt = path.Clean(path.Join(virtualCwd, target))
	}
	rel := strings.TrimPrefix(virt, "/")
	full := filepath.Join(s.rootDir, filepath.FromSlash(rel))
	absRoot, err := filepath.Abs(s.rootDir)
	if err != nil {
		return "", "", err
	}
	absFull, err := filepath.Abs(full)
	if err != nil {
		return "", "", err
	}
	if absFull != absRoot && !strings.HasPrefix(absFull, absRoot+string(filepath.Separator)) {
		return "", "", errors.New("permission denied: outside root")
	}
	return virt, absFull, nil
}

func (s *Server) formatDisplayPath(virt string) string {
	if virt == "/" || virt == "." || virt == "" {
		return "~"
	}
	return "~" + virt
}

func (s *Server) evalSingleCommand(st *shellState, rawCmd string) (stdout string, stderr string, exitCode int, shouldExit bool) {
	cmd := strings.TrimSpace(rawCmd)
	if cmd == "" {
		return "", "", 0, false
	}

	cmd = strings.ReplaceAll(cmd, "$?", strconv.Itoa(st.lastExit))

	// ">&2" sends the command's stdout to stderr, as in printf 'oops' >&2.
	toStderr := false
	if strings.HasSuffix(cmd, ">&2") {
		toStderr = true
		cmd = strings.TrimSuffix(cmd, ">&2")
		if strings.HasSuffix(cmd, " 1") {
			cmd = strings.TrimSuffix(cmd, "1")
		}
		cmd = strings.TrimSpace(cmd)
	}

	var redirectFile string
	var appendMode bool
	if idx := strings.Index(cmd, ">>"); idx > 0 {
		redirectFile = strings.TrimSpace(cmd[idx+2:])
		cmd = strings.TrimSpace(cmd[:idx])
		appendMode = true
	} else if idx := strings.IndexByte(cmd, '>'); idx > 0 && !strings.Contains(cmd, "2>") {
		redirectFile = strings.TrimSpace(cmd[idx+1:])
		cmd = strings.TrimSpace(cmd[:idx])
	}

	tokens := tokenizeShell(cmd)
	if len(tokens) == 0 {
		return "", "", 0, false
	}

	prog := tokens[0]
	args := tokens[1:]

	var outBuf bytes.Buffer
	var errBuf bytes.Buffer
	code := 0

	switch prog {
	case "exit", "logout":
		if len(args) > 0 {
			if v, err := strconv.Atoi(args[0]); err == nil {
				code = v
			}
		}
		return "", "", code, true

	case "true":
		code = 0

	case "false":
		code = 1

	case "uname":
		if len(args) == 0 || args[0] == "-s" {
			outBuf.WriteString("Linux" + lf)
		} else if args[0] == "-a" {
			outBuf.WriteString("Linux testsshd 6.6.0-webssh #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux" + lf)
		} else if args[0] == "-m" {
			outBuf.WriteString("x86_64" + lf)
		} else if args[0] == "-r" {
			outBuf.WriteString("6.6.0-webssh" + lf)
		} else if args[0] == "-n" {
			outBuf.WriteString("testsshd" + lf)
		} else {
			outBuf.WriteString("Linux" + lf)
		}

	case "pwd":
		if st.cwd == "/" || st.cwd == "" {
			outBuf.WriteString("/home/" + st.user + lf)
		} else {
			outBuf.WriteString("/home/" + st.user + st.cwd + lf)
		}

	case "whoami":
		outBuf.WriteString(st.user + lf)

	case "hostname":
		outBuf.WriteString("testsshd" + lf)

	case "id":
		outBuf.WriteString(fmt.Sprintf("uid=1000(%s) gid=1000(%s) groups=1000(%s)", st.user, st.user, st.user) + lf)

	case "echo":
		noNewline := false
		if len(args) > 0 && args[0] == "-n" {
			noNewline = true
			args = args[1:]
		}
		outBuf.WriteString(strings.Join(args, " "))
		if !noNewline {
			outBuf.WriteString(lf)
		}

	case "printf":
		if len(args) > 0 {
			format := unescapePrintf(args[0])
			if len(args) > 1 {
				anyArgs := make([]any, len(args)-1)
				for i, a := range args[1:] {
					anyArgs[i] = a
				}
				outBuf.WriteString(fmt.Sprintf(format, anyArgs...))
			} else {
				outBuf.WriteString(format)
			}
		}

	case "cd":
		target := "~"
		if len(args) > 0 {
			target = args[0]
		}
		virt, hostPath, err := s.resolveHostPath(st.cwd, target)
		if err != nil {
			errBuf.WriteString(fmt.Sprintf("cd: %s: %v", target, err) + lf)
			code = 1
		} else {
			info, statErr := os.Stat(hostPath)
			if statErr != nil || !info.IsDir() {
				errBuf.WriteString(fmt.Sprintf("cd: %s: No such file or directory", target) + lf)
				code = 1
			} else {
				st.cwd = virt
			}
		}

	case "ls":
		longFmt := false
		showAll := false
		target := "."
		for _, a := range args {
			if strings.HasPrefix(a, "-") {
				if strings.Contains(a, "l") {
					longFmt = true
				}
				if strings.Contains(a, "a") {
					showAll = true
				}
			} else {
				target = a
			}
		}
		_, hostPath, err := s.resolveHostPath(st.cwd, target)
		if err != nil {
			errBuf.WriteString(fmt.Sprintf("ls: cannot access '%s': %v", target, err) + lf)
			code = 2
		} else {
			info, statErr := os.Stat(hostPath)
			if statErr != nil {
				errBuf.WriteString(fmt.Sprintf("ls: cannot access '%s': No such file or directory", target) + lf)
				code = 2
			} else if !info.IsDir() {
				if longFmt {
					outBuf.WriteString(fmt.Sprintf("%s 1 %s %s %d %s", info.Mode().String(), st.user, st.user, info.Size(), info.Name()) + lf)
				} else {
					outBuf.WriteString(info.Name() + lf)
				}
			} else {
				entries, readErr := os.ReadDir(hostPath)
				if readErr != nil {
					errBuf.WriteString(fmt.Sprintf("ls: %v", readErr) + lf)
					code = 2
				} else {
					for _, e := range entries {
						if !showAll && strings.HasPrefix(e.Name(), ".") {
							continue
						}
						if longFmt {
							fi, _ := e.Info()
							sz := int64(0)
							modeStr := "-rw-r--r--"
							if fi != nil {
								sz = fi.Size()
								modeStr = fi.Mode().String()
							}
							outBuf.WriteString(fmt.Sprintf("%s 1 %s %s %d %s", modeStr, st.user, st.user, sz, e.Name()) + lf)
						} else {
							outBuf.WriteString(e.Name() + lf)
						}
					}
				}
			}
		}

	case "cat":
		if len(args) == 0 {
			errBuf.WriteString("cat: missing file operand" + lf)
			code = 1
		} else {
			for _, a := range args {
				_, hostPath, err := s.resolveHostPath(st.cwd, a)
				if err != nil {
					errBuf.WriteString(fmt.Sprintf("cat: %s: %v", a, err) + lf)
					code = 1
					continue
				}
				data, readErr := os.ReadFile(hostPath)
				if readErr != nil {
					errBuf.WriteString(fmt.Sprintf("cat: %s: No such file or directory", a) + lf)
					code = 1
					continue
				}
				outBuf.Write(data)
			}
		}

	case "mkdir":
		parents := false
		var targets []string
		for _, a := range args {
			if a == "-p" {
				parents = true
			} else if !strings.HasPrefix(a, "-") {
				targets = append(targets, a)
			}
		}
		for _, t := range targets {
			_, hostPath, err := s.resolveHostPath(st.cwd, t)
			if err != nil {
				errBuf.WriteString(fmt.Sprintf("mkdir: %v", err) + lf)
				code = 1
				continue
			}
			var mkErr error
			if parents {
				mkErr = os.MkdirAll(hostPath, 0755)
			} else {
				mkErr = os.Mkdir(hostPath, 0755)
			}
			if mkErr != nil {
				errBuf.WriteString(fmt.Sprintf("mkdir: cannot create directory '%s': %v", t, mkErr) + lf)
				code = 1
			}
		}

	case "touch":
		for _, t := range args {
			_, hostPath, err := s.resolveHostPath(st.cwd, t)
			if err != nil {
				errBuf.WriteString(fmt.Sprintf("touch: %v", err) + lf)
				code = 1
				continue
			}
			f, openErr := os.OpenFile(hostPath, os.O_CREATE|os.O_WRONLY, 0644)
			if openErr != nil {
				errBuf.WriteString(fmt.Sprintf("touch: %v", openErr) + lf)
				code = 1
				continue
			}
			_ = f.Close()
		}

	case "rm":
		recursive := false
		force := false
		var targets []string
		for _, a := range args {
			if strings.HasPrefix(a, "-") {
				if strings.Contains(a, "r") || strings.Contains(a, "R") {
					recursive = true
				}
				if strings.Contains(a, "f") {
					force = true
				}
			} else {
				targets = append(targets, a)
			}
		}
		for _, t := range targets {
			_, hostPath, err := s.resolveHostPath(st.cwd, t)
			if err != nil {
				if !force {
					errBuf.WriteString(fmt.Sprintf("rm: %v", err) + lf)
					code = 1
				}
				continue
			}
			var rmErr error
			if recursive {
				rmErr = os.RemoveAll(hostPath)
			} else {
				rmErr = os.Remove(hostPath)
			}
			if rmErr != nil && !force {
				errBuf.WriteString(fmt.Sprintf("rm: cannot remove '%s': %v", t, rmErr) + lf)
				code = 1
			}
		}

	case "chmod":
		if len(args) < 2 {
			errBuf.WriteString("chmod: missing operand" + lf)
			code = 1
		} else {
			modeVal, parseErr := strconv.ParseUint(args[0], 8, 32)
			if parseErr != nil {
				errBuf.WriteString(fmt.Sprintf("chmod: invalid mode: '%s'", args[0]) + lf)
				code = 1
			} else {
				_, hostPath, err := s.resolveHostPath(st.cwd, args[1])
				if err != nil {
					errBuf.WriteString(fmt.Sprintf("chmod: %v", err) + lf)
					code = 1
				} else if chErr := os.Chmod(hostPath, os.FileMode(modeVal)); chErr != nil {
					errBuf.WriteString(fmt.Sprintf("chmod: %v", chErr) + lf)
					code = 1
				}
			}
		}

	case "uptime":
		outBuf.WriteString(" 12:00:00 up 14 days,  3:42,  1 user,  load average: 0.12, 0.08, 0.05" + lf)

	case "free":
		outBuf.WriteString("               total        used        free      shared  buff/cache   available" + lf +
			"Mem:            8192        1840        4120          64        2232        6012" + lf +
			"Swap:           2048           0        2048" + lf)

	case "df":
		outBuf.WriteString("Filesystem      Size  Used Avail Use% Mounted on" + lf +
			"/dev/root        50G   12G   38G  24% /" + lf)

	case "ps":
		outBuf.WriteString("  PID TTY          TIME CMD" + lf +
			"    1 ?        00:00:01 sshd" + lf +
			"  102 pts/0    00:00:00 bash" + lf)

	case "printenv":
		if len(args) == 0 {
			names := make([]string, 0, len(st.env))
			for name := range st.env {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				outBuf.WriteString(name + "=" + st.env[name] + lf)
			}
		} else {
			for _, name := range args {
				if v, ok := st.env[name]; ok {
					outBuf.WriteString(v + lf)
				} else {
					code = 1
				}
			}
		}

	case "sleep":
		secs := 0.0
		if len(args) > 0 {
			v, err := strconv.ParseFloat(args[0], 64)
			if err != nil || v < 0 {
				errBuf.WriteString(fmt.Sprintf("sleep: invalid time interval '%s'", args[0]) + lf)
				code = 1
			}
			secs = v
		}
		if code == 0 {
			if c, stopped := st.pause(time.Duration(secs * float64(time.Second))); stopped {
				st.lastExit = c
				return outBuf.String(), errBuf.String(), c, true
			}
		}

	case "kill":
		// Only the session's own process ($$) exists here; killing it ends
		// the command with that signal, which the client sees as exit-signal.
		sig := "TERM"
		var pids []string
		for i := 0; i < len(args); i++ {
			switch a := args[i]; {
			case a == "-s" && i+1 < len(args):
				sig = signalName(args[i+1])
				i++
			case strings.HasPrefix(a, "-"):
				sig = signalName(a)
			default:
				pids = append(pids, a)
			}
		}
		switch {
		case sig == "":
			errBuf.WriteString("kill: invalid signal specification" + lf)
			code = 1
		case len(pids) == 0:
			errBuf.WriteString("kill: usage: kill [-s sigspec | -sigspec] pid" + lf)
			code = 2
		default:
			for _, pid := range pids {
				if pid == "$$" {
					c, _ := st.kill(sig)
					st.lastExit = c
					return outBuf.String(), errBuf.String(), c, true
				}
				errBuf.WriteString(fmt.Sprintf("kill: (%s) - No such process", pid) + lf)
				code = 1
			}
		}

	case "tail":
		follow, retry, lines := false, false, 10
		target := ""
		for i := 0; i < len(args); i++ {
			switch a := args[i]; {
			case a == "-f":
				follow = true
			case a == "-F":
				follow, retry = true, true
			case a == "-n" && i+1 < len(args):
				if v, err := strconv.Atoi(args[i+1]); err == nil {
					lines = v
				}
				i++
			case strings.HasPrefix(a, "-"):
			default:
				target = a
			}
		}
		switch {
		case target == "":
			errBuf.WriteString("tail: reading standard input is not supported" + lf)
			code = 1
		case follow:
			// Output is emitted as it appears; nothing is left to return.
			c, stopped := s.followFile(st, target, retry, lines)
			st.lastExit = c
			return "", "", c, stopped
		default:
			_, hostPath, err := s.resolveHostPath(st.cwd, target)
			data, readErr := os.ReadFile(hostPath)
			if err != nil || readErr != nil {
				errBuf.WriteString(fmt.Sprintf("tail: cannot open '%s' for reading: No such file or directory", target) + lf)
				code = 1
			} else {
				outBuf.WriteString(lastLines(data, lines))
			}
		}

	default:
		if strings.HasPrefix(cmd, "legacy-echo ") {
			outBuf.WriteString("executed:" + cmd)
		} else {
			errBuf.WriteString(fmt.Sprintf("bash: %s: command not found", prog) + lf)
			code = 127
		}
	}

	if toStderr {
		errBuf.Write(outBuf.Bytes())
		outBuf.Reset()
	}

	if redirectFile != "" && code == 0 {
		_, hostPath, err := s.resolveHostPath(st.cwd, redirectFile)
		if err != nil {
			errBuf.WriteString(fmt.Sprintf("bash: %s: %v", redirectFile, err) + lf)
			code = 1
		} else {
			flags := os.O_CREATE | os.O_WRONLY
			if appendMode {
				flags |= os.O_APPEND
			} else {
				flags |= os.O_TRUNC
			}
			f, openErr := os.OpenFile(hostPath, flags, 0644)
			if openErr != nil {
				errBuf.WriteString(fmt.Sprintf("bash: %s: %v", redirectFile, openErr) + lf)
				code = 1
			} else {
				_, _ = f.Write(outBuf.Bytes())
				_ = f.Close()
				outBuf.Reset()
			}
		}
	}

	st.lastExit = code
	return outBuf.String(), errBuf.String(), code, false
}

func (s *Server) executeCommandLine(st *shellState, line string) (stdout string, stderr string, exitCode int, shouldExit bool) {
	var allOut bytes.Buffer
	var allErr bytes.Buffer
	code, exitNow := s.runCommandLine(st, line, func(out, errStr string) {
		allOut.WriteString(out)
		allErr.WriteString(errStr)
	})
	return allOut.String(), allErr.String(), code, exitNow
}

// runCommandLine evaluates a compound command line and hands each segment's
// output to emit as soon as that segment produces it, so exec clients see
// output while later segments are still running.
func (s *Server) runCommandLine(st *shellState, line string, emit func(stdout, stderr string)) (exitCode int, shouldExit bool) {
	st.emit = emit
	defer func() { st.emit = nil }()

	lastCode := 0
	for _, seg := range splitCompoundCommand(line) {
		if seg.op == "&&" && lastCode != 0 {
			continue
		}
		if seg.op == "||" && lastCode == 0 {
			continue
		}
		if sig := st.pendingSignal(); sig != "" {
			code, _ := st.kill(sig)
			return code, true
		}
		out, errStr, code, exitNow := s.evalSingleCommand(st, seg.cmd)
		if out != "" || errStr != "" {
			emit(out, errStr)
		}
		lastCode = code
		if exitNow {
			return lastCode, true
		}
	}
	return lastCode, false
}

// sendExit reports how the command ended: exit-signal when it was killed,
// exit-status otherwise.
func sendExit(ch ssh.Channel, st *shellState, code int) {
	if st.killedBy != "" {
		_, _ = ch.SendRequest("exit-signal", false, ssh.Marshal(&struct {
			Signal     string
			CoreDumped bool
			Error      string
			Lang       string
		}{Signal: st.killedBy}))
		return
	}
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(&struct{ Status uint32 }{uint32(code)}))
}

type cmdSegment struct {
	op  string
	cmd string
}

func splitCompoundCommand(line string) []cmdSegment {
	var res []cmdSegment
	curOp := ""
	var buf strings.Builder
	inSingle := false
	inDouble := false

	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == byte(39) && !inDouble {
			inSingle = !inSingle
			buf.WriteByte(c)
			continue
		}
		if c == '"' && !inSingle {
			inDouble = !inDouble
			buf.WriteByte(c)
			continue
		}
		if !inSingle && !inDouble {
			if c == ';' {
				res = append(res, cmdSegment{op: curOp, cmd: buf.String()})
				buf.Reset()
				curOp = ";"
				continue
			}
			if c == '&' && i+1 < len(line) && line[i+1] == '&' {
				res = append(res, cmdSegment{op: curOp, cmd: buf.String()})
				buf.Reset()
				curOp = "&&"
				i++
				continue
			}
			if c == '|' && i+1 < len(line) && line[i+1] == '|' {
				res = append(res, cmdSegment{op: curOp, cmd: buf.String()})
				buf.Reset()
				curOp = "||"
				i++
				continue
			}
		}
		buf.WriteByte(c)
	}
	if strings.TrimSpace(buf.String()) != "" || len(res) == 0 {
		res = append(res, cmdSegment{op: curOp, cmd: buf.String()})
	}
	return res
}

func tokenizeShell(cmd string) []string {
	var tokens []string
	var cur strings.Builder
	inSingle := false
	inDouble := false

	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if c == byte(92) && !inSingle && i+1 < len(cmd) {
			i++
			cur.WriteByte(cmd[i])
			continue
		}
		if c == byte(39) && !inDouble {
			inSingle = !inSingle
			continue
		}
		if c == '"' && !inSingle {
			inDouble = !inDouble
			continue
		}
		if (c == ' ' || c == byte(9)) && !inSingle && !inDouble {
			if cur.Len() > 0 {
				tokens = append(tokens, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteByte(c)
	}
	if cur.Len() > 0 {
		tokens = append(tokens, cur.String())
	}
	return tokens
}

func unescapePrintf(s string) string {
	backslash := string([]byte{92})
	r := strings.NewReplacer(
		backslash+"n", lf,
		backslash+"r", cr,
		backslash+"t", tabStr,
		backslash+backslash, backslash,
	)
	return r.Replace(s)
}

func toCRLF(s string) string {
	s = strings.ReplaceAll(s, crlf, lf)
	return strings.ReplaceAll(s, lf, crlf)
}

func (s *Server) formatPrompt(st *shellState) string {
	return fmt.Sprintf("%s@testsshd:%s$ ", st.user, s.formatDisplayPath(st.cwd))
}

func (s *Server) handleSessionChannel(user string, ch ssh.Channel, requests <-chan *ssh.Request) {
	s.openSessions.Add(1)
	s.mu.Lock()
	logIdx := len(s.requestLog)
	s.requestLog = append(s.requestLog, nil)
	s.mu.Unlock()

	done := make(chan struct{})
	signals := make(chan string, 4)
	var running sync.WaitGroup
	defer func() {
		close(done)
		running.Wait()
		s.openSessions.Add(-1)
	}()

	st := &shellState{
		user:     user,
		cwd:      "/",
		lastExit: 0,
		env:      make(map[string]string),
		done:     done,
		signals:  signals,
	}
	started := false
	for req := range requests {
		s.logRequest(logIdx, req.Type)
		switch req.Type {
		case "pty-req", "window-change":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		case "env":
			// Like sshd, only variables on the accept-list are applied, and
			// only before the shell or command starts.
			var kv struct{ Name, Value string }
			ok := ssh.Unmarshal(req.Payload, &kv) == nil && !started && acceptEnv(kv.Name)
			if ok {
				st.env[kv.Name] = kv.Value
			}
			if req.WantReply {
				_ = req.Reply(ok, nil)
			}
		case "signal":
			var msg struct{ Signal string }
			if ssh.Unmarshal(req.Payload, &msg) == nil {
				sig := msg.Signal
				if name := signalName(sig); name != "" {
					sig = name
				}
				s.mu.Lock()
				s.signals = append(s.signals, sig)
				s.mu.Unlock()
				select {
				case signals <- sig:
				default:
				}
			}
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		case "shell":
			started = true
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			running.Add(1)
			go func() {
				defer running.Done()
				defer ch.Close()
				_, _ = ch.Write([]byte(s.formatPrompt(st)))
				var lineBuf []byte
				var history []string
				histIdx := -1
				buf := make([]byte, 1024)
				for {
					n, err := ch.Read(buf)
					if n > 0 {
						chunk := buf[:n]
						i := 0
						for i < len(chunk) {
							b := chunk[i]
							switch b {
							case 0x03: // Ctrl+C
								lineBuf = lineBuf[:0]
								_, _ = ch.Write([]byte("^C" + crlf + s.formatPrompt(st)))
								i++
							case 0x04: // Ctrl+D
								if len(lineBuf) == 0 {
									_, _ = ch.Write([]byte("logout" + crlf))
									_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(&struct{ Status uint32 }{0}))
									return
								}
								i++
							case 0x0c: // Ctrl+L
								_, _ = ch.Write([]byte(escClear + s.formatPrompt(st) + string(lineBuf)))
								i++
							case 0x7f, 0x08: // Backspace
								if len(lineBuf) > 0 {
									lineBuf = lineBuf[:len(lineBuf)-1]
									_, _ = ch.Write([]byte(bsSeq))
								}
								i++
							case 0x09: // Tab completion
								prefix := string(lineBuf)
								if completed := s.completeInput(st, prefix); completed != "" {
									lineBuf = append(lineBuf, []byte(completed)...)
									_, _ = ch.Write([]byte(completed))
								}
								i++
							case 0x1b: // Escape sequence (arrows)
								if i+2 < len(chunk) && chunk[i+1] == '[' {
									code := chunk[i+2]
									if code == 'A' && len(history) > 0 { // Up arrow
										if histIdx < 0 {
											histIdx = len(history) - 1
										} else if histIdx > 0 {
											histIdx--
										}
										clearCount := len(lineBuf)
										lineBuf = []byte(history[histIdx])
										_, _ = ch.Write([]byte(strings.Repeat(bsSeq, clearCount) + string(lineBuf)))
									} else if code == 'B' { // Down arrow
										clearCount := len(lineBuf)
										if histIdx >= 0 && histIdx < len(history)-1 {
											histIdx++
											lineBuf = []byte(history[histIdx])
										} else {
											histIdx = -1
											lineBuf = lineBuf[:0]
										}
										_, _ = ch.Write([]byte(strings.Repeat(bsSeq, clearCount) + string(lineBuf)))
									}
									i += 3
									continue
								}
								i++
							case 13, 10:
								if b == 13 && i+1 < len(chunk) && chunk[i+1] == 10 {
									i++
								}
								cmdLine := string(lineBuf)
								lineBuf = lineBuf[:0]
								histIdx = -1
								_, _ = ch.Write([]byte(crlf))
								if strings.TrimSpace(cmdLine) != "" {
									history = append(history, cmdLine)
								}
								out, errStr, code, exitNow := s.executeCommandLine(st, cmdLine)
								if out != "" {
									_, _ = ch.Write([]byte(toCRLF(out)))
								}
								if errStr != "" {
									_, _ = ch.Write([]byte(toCRLF(errStr)))
								}
								if exitNow {
									sendExit(ch, st, code)
									return
								}
								_, _ = ch.Write([]byte(s.formatPrompt(st)))
								i++
							default:
								if b >= 0x20 {
									lineBuf = append(lineBuf, b)
									_, _ = ch.Write([]byte{b})
								}
								i++
							}
						}
					}
					if err != nil {
						return
					}
				}
			}()
		case "exec":
			started = true
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			var payload struct{ Command string }
			_ = ssh.Unmarshal(req.Payload, &payload)
			running.Add(1)
			go func(cmd string) {
				defer running.Done()
				defer ch.Close()
				code, _ := s.runCommandLine(st, cmd, func(out, errStr string) {
					if out != "" {
						_, _ = ch.Write([]byte(out))
					}
					if errStr != "" {
						_, _ = ch.Stderr().Write([]byte(errStr))
					}
				})
				sendExit(ch, st, code)
			}(payload.Command)
		case "subsystem":
			var sub struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &sub)
			if sub.Name == "sftp" {
				started = true
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				running.Add(1)
				go func() {
					defer running.Done()
					defer ch.Close()
					srv, err := sftp.NewServer(ch, sftp.WithServerWorkingDirectory(s.rootDir))
					if err != nil {
						return
					}
					_ = srv.Serve()
				}()
			} else if req.WantReply {
				_ = req.Reply(false, nil)
			}
		default:
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

func (s *Server) completeInput(st *shellState, line string) string {
	parts := strings.Fields(line)
	if len(parts) == 0 {
		return ""
	}
	last := parts[len(parts)-1]
	if len(parts) == 1 && !strings.HasSuffix(line, " ") {
		builtins := []string{"uname", "pwd", "whoami", "hostname", "echo", "printf", "ls", "cat", "mkdir", "touch", "rm", "chmod", "uptime", "free", "df", "exit"}
		for _, b := range builtins {
			if strings.HasPrefix(b, last) && b != last {
				return strings.TrimPrefix(b, last) + " "
			}
		}
	}
	_, hostDir, err := s.resolveHostPath(st.cwd, ".")
	if err != nil {
		return ""
	}
	entries, err := os.ReadDir(hostDir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), last) && e.Name() != last {
			suffix := strings.TrimPrefix(e.Name(), last)
			if e.IsDir() {
				return suffix + "/"
			}
			return suffix
		}
	}
	return ""
}
