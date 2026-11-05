package sshbridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/sftp"
	"github.com/webssh-studio/gateway/internal/protocol"
	"golang.org/x/crypto/ssh"
)

var (
	ErrSignRejected    = errors.New("sshbridge: remote signature rejected or timed out")
	ErrHostKeyRejected = errors.New("sshbridge: host key rejected by client")
	ErrChecksumFailed  = errors.New("sshbridge: SFTP chunk or file SHA-256 verification failed")
	ErrPathTraversal   = errors.New("sshbridge: invalid or traversal path rejected")
)

type SignCallback func(ctx context.Context, alg string, data []byte) ([]byte, error)
type HostKeyCallback func(ctx context.Context, host string, port int, key ssh.PublicKey) error

// RemoteSigner implements ssh.Signer by forwarding signing challenges to the browser's non-extractable CryptoKey.
type RemoteSigner struct {
	pubKey ssh.PublicKey
	signFn SignCallback
}

func NewRemoteSigner(pubKey ssh.PublicKey, signFn SignCallback) *RemoteSigner {
	return &RemoteSigner{
		pubKey: pubKey,
		signFn: signFn,
	}
}

func (rs *RemoteSigner) PublicKey() ssh.PublicKey {
	return rs.pubKey
}

func (rs *RemoteSigner) Sign(_ io.Reader, data []byte) (*ssh.Signature, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	alg := rs.pubKey.Type()
	rawSig, err := rs.signFn(ctx, alg, data)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSignRejected, err)
	}

	switch alg {
	case ssh.KeyAlgoED25519:
		if len(rawSig) != 64 {
			return nil, fmt.Errorf("invalid ed25519 signature length %d", len(rawSig))
		}
		return &ssh.Signature{
			Format: ssh.KeyAlgoED25519,
			Blob:   rawSig,
		}, nil
	case ssh.KeyAlgoECDSA256:
		// WebCrypto ECDSA P-256 produces 64-byte IEEE-P1363 (r || s). Convert to SSH mpint blob if 64 bytes.
		blob := rawSig
		if len(rawSig) == 64 {
			var err error
			blob, err = ConvertP1363ToSSHBlob(rawSig)
			if err != nil {
				return nil, err
			}
		}
		return &ssh.Signature{
			Format: ssh.KeyAlgoECDSA256,
			Blob:   blob,
		}, nil
	default:
		return &ssh.Signature{
			Format: alg,
			Blob:   rawSig,
		}, nil
	}
}

// ConvertP1363ToSSHBlob converts a 64-byte IEEE-P1363 (r || s) ECDSA P-256 signature into SSH wire format (mpint r, mpint s).
func ConvertP1363ToSSHBlob(p1363 []byte) ([]byte, error) {
	if len(p1363) != 64 {
		return nil, fmt.Errorf("expected 64-byte P1363 signature, got %d", len(p1363))
	}
	r := new(big.Int).SetBytes(p1363[:32])
	s := new(big.Int).SetBytes(p1363[32:])
	if r.Sign() <= 0 || s.Sign() <= 0 {
		return nil, errors.New("invalid zero ECDSA signature component")
	}
	var sig struct {
		R *big.Int
		S *big.Int
	}
	sig.R = r
	sig.S = s
	return ssh.Marshal(&sig), nil
}

func FormatHostKeyFingerprint(pub ssh.PublicKey) string {
	return ssh.FingerprintSHA256(pub)
}

func ParsePrivateKeySigner(pemText string, passphrase string) (ssh.Signer, error) {
	raw := []byte(strings.TrimSpace(pemText))
	if len(raw) == 0 {
		return nil, errors.New("empty private key PEM")
	}
	if passphrase != "" {
		return ssh.ParsePrivateKeyWithPassphrase(raw, []byte(passphrase))
	}
	return ssh.ParsePrivateKey(raw)
}

type HopConfig struct {
	Addr     string
	Host     string
	Port     int
	User     string
	Signer   ssh.Signer
	Password string
}

type chainedConn struct {
	net.Conn
	parent *ssh.Client
}

func (c *chainedConn) Close() error {
	err1 := c.Conn.Close()
	err2 := c.parent.Close()
	if err1 != nil {
		return err1
	}
	return err2
}

// DialChain dials a target SSH server directly or through one or more ProxyJump bastion hops.
func DialChain(ctx context.Context, hops []HopConfig, target HopConfig, hkCb HostKeyCallback) (*ssh.Client, error) {
	var currentClient *ssh.Client

	allHops := append(append([]HopConfig{}, hops...), target)
	for i, hop := range allHops {
		var authMethods []ssh.AuthMethod
		if hop.Signer != nil {
			authMethods = append(authMethods, ssh.PublicKeys(hop.Signer))
		}
		if hop.Password != "" {
			authMethods = append(authMethods, ssh.Password(hop.Password))
		}
		if len(authMethods) == 0 {
			if currentClient != nil {
				_ = currentClient.Close()
			}
			return nil, errors.New("sshbridge: no authentication method provided")
		}

		hopCopy := hop
		cfg := &ssh.ClientConfig{
			User: hopCopy.User,
			Auth: authMethods,
			HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
				if hkCb == nil {
					return nil
				}
				return hkCb(ctx, hopCopy.Host, hopCopy.Port, key)
			},
			Timeout: 10 * time.Second,
		}

		if i == 0 {
			var d net.Dialer
			conn, err := d.DialContext(ctx, "tcp", hopCopy.Addr)
			if err != nil {
				return nil, err
			}
			c, chans, reqs, err := ssh.NewClientConn(conn, hopCopy.Addr, cfg)
			if err != nil {
				_ = conn.Close()
				return nil, err
			}
			currentClient = ssh.NewClient(c, chans, reqs)
		} else {
			prevClient := currentClient
			conn, err := prevClient.Dial("tcp", hopCopy.Addr)
			if err != nil {
				_ = prevClient.Close()
				return nil, err
			}
			wrappedConn := &chainedConn{Conn: conn, parent: prevClient}
			c, chans, reqs, err := ssh.NewClientConn(wrappedConn, hopCopy.Addr, cfg)
			if err != nil {
				_ = wrappedConn.Close()
				return nil, err
			}
			currentClient = ssh.NewClient(c, chans, reqs)
		}
	}
	return currentClient, nil
}

// ExecCommand executes a single non-interactive command over a fresh SSH session channel.
func ExecCommand(ctx context.Context, client *ssh.Client, command string, timeout time.Duration) (string, string, int, int64, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	start := time.Now()
	sess, err := client.NewSession()
	if err != nil {
		return "", "", 1, 0, err
	}
	defer sess.Close()

	var stdoutBuf, stderrBuf bytes.Buffer
	sess.Stdout = &stdoutBuf
	sess.Stderr = &stderrBuf

	done := make(chan error, 1)
	go func() {
		done <- sess.Run(command)
	}()

	var runErr error
	select {
	case <-execCtx.Done():
		_ = sess.Close()
		return stdoutBuf.String(), stderrBuf.String(), 124, time.Since(start).Milliseconds(), errors.New("command timed out")
	case runErr = <-done:
	}

	dur := time.Since(start).Milliseconds()
	exitCode := 0
	if runErr != nil {
		var exitErr *ssh.ExitError
		if errors.As(runErr, &exitErr) {
			exitCode = exitErr.ExitStatus()
			runErr = nil
		} else {
			exitCode = 1
		}
	}
	return stdoutBuf.String(), stderrBuf.String(), exitCode, dur, runErr
}

// DeployAuthorizedKey connects once with a password (ssh-copy-id equivalent) and appends pubKeyLine to ~/.ssh/authorized_keys.
func DeployAuthorizedKey(ctx context.Context, addr, host string, port int, user, password, pubKeyLine string, hkCb HostKeyCallback) error {
	cleanKey := strings.TrimSpace(pubKeyLine)
	if cleanKey == "" || strings.IndexByte(cleanKey, 10) >= 0 || strings.IndexByte(cleanKey, 13) >= 0 {
		return errors.New("invalid public key line")
	}

	cfg := &ssh.ClientConfig{
		User: user,
		Auth: []ssh.AuthMethod{ssh.Password(password)},
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			if hkCb == nil {
				return nil
			}
			return hkCb(ctx, host, port, key)
		},
		Timeout: 10 * time.Second,
	}

	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		return err
	}
	client := ssh.NewClient(c, chans, reqs)
	defer client.Close()

	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return err
	}
	defer sftpClient.Close()

	_ = sftpClient.MkdirAll(".ssh")
	_ = sftpClient.Chmod(".ssh", 0700)

	f, err := sftpClient.OpenFile(".ssh/authorized_keys", os.O_CREATE|os.O_RDWR)
	if err != nil {
		return err
	}
	defer f.Close()

	existing, _ := io.ReadAll(f)
	if !strings.Contains(string(existing), cleanKey) {
		var out bytes.Buffer
		if len(existing) > 0 && existing[len(existing)-1] != byte(10) {
			out.WriteByte(byte(10))
		}
		out.WriteString(cleanKey)
		out.WriteByte(byte(10))
		if _, err := f.Write(out.Bytes()); err != nil {
			return err
		}
	}
	_ = sftpClient.Chmod(".ssh/authorized_keys", 0600)
	return nil
}

// SanitizeRemotePath cleans a remote POSIX path and rejects null bytes.
func SanitizeRemotePath(p string) (string, error) {
	if strings.ContainsRune(p, 0) {
		return "", ErrPathTraversal
	}
	trimmed := strings.TrimSpace(p)
	if trimmed == "" || trimmed == "~" {
		return ".", nil
	}
	if strings.HasPrefix(trimmed, "~/") {
		trimmed = strings.TrimPrefix(trimmed, "~/")
		if trimmed == "" {
			return ".", nil
		}
	}
	cleaned := path.Clean(filepath.ToSlash(trimmed))
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("%w: %q", ErrPathTraversal, p)
	}
	return cleaned, nil
}

// SFTPBridge executes chunked resumable uploads (.part -> atomic rename), directory listings, and file edits over an *sftp.Client.
type SFTPBridge struct {
	client *sftp.Client
}

func NewSFTPBridge(client *sftp.Client) *SFTPBridge {
	return &SFTPBridge{client: client}
}

func (b *SFTPBridge) HandleOp(msg protocol.ControlMessage) protocol.ControlMessage {
	res := protocol.ControlMessage{
		Type: "sftp_result",
		OpID: msg.OpID,
	}
	if b == nil || b.client == nil {
		res.Error = "SFTP subsystem is not available on this session"
		return res
	}
	cleanPath, err := SanitizeRemotePath(msg.Path)
	if err != nil {
		res.Error = err.Error()
		return res
	}

	switch msg.Op {
	case "list":
		infos, err := b.client.ReadDir(cleanPath)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		entries := make([]protocol.SftpDirEntry, 0, len(infos))
		for _, info := range infos {
			entryPath := path.Join(cleanPath, info.Name())
			if cleanPath == "." {
				entryPath = info.Name()
			}
			entries = append(entries, protocol.SftpDirEntry{
				Name:    info.Name(),
				Path:    entryPath,
				Size:    info.Size(),
				Mode:    info.Mode().String(),
				ModTime: info.ModTime().Unix(),
				IsDir:   info.IsDir(),
			})
		}
		res.OK = true
		res.Entries = entries
		return res

	case "stat":
		info, err := b.client.Stat(cleanPath)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		res.Size = info.Size()
		res.Mode = info.Mode().String()
		res.Entries = []protocol.SftpDirEntry{
			{
				Name:    info.Name(),
				Path:    cleanPath,
				Size:    info.Size(),
				Mode:    info.Mode().String(),
				ModTime: info.ModTime().Unix(),
				IsDir:   info.IsDir(),
			},
		}
		return res

	case "chmod":
		modeStr := strings.TrimSpace(msg.Mode)
		if modeStr == "" {
			res.Error = "missing chmod mode"
			return res
		}
		modeVal, parseErr := strconv.ParseUint(modeStr, 8, 32)
		if parseErr != nil {
			res.Error = fmt.Sprintf("invalid octal mode %q: %v", modeStr, parseErr)
			return res
		}
		if err := b.client.Chmod(cleanPath, os.FileMode(modeVal)); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		return res

	case "mkdir":
		if err := b.client.MkdirAll(cleanPath); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		return res

	case "remove":
		if err := b.client.Remove(cleanPath); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		return res

	case "rename":
		target, err := SanitizeRemotePath(msg.TargetPath)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		if err := b.client.PosixRename(cleanPath, target); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		return res

	case "upload_init":
		partPath := cleanPath + ".part"
		st, err := b.client.Stat(partPath)
		if err == nil {
			res.Offset = st.Size()
		} else {
			f, err := b.client.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY)
			if err != nil {
				res.Error = err.Error()
				return res
			}
			_ = f.Close()
			res.Offset = 0
		}
		res.OK = true
		return res

	case "upload_chunk":
		partPath := cleanPath + ".part"
		chunkBytes, err := base64.StdEncoding.DecodeString(msg.DataBase64)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		if msg.Sha256 != "" {
			sum := sha256.Sum256(chunkBytes)
			if !strings.EqualFold(hex.EncodeToString(sum[:]), msg.Sha256) {
				res.Error = ErrChecksumFailed.Error()
				return res
			}
		}
		f, err := b.client.OpenFile(partPath, os.O_CREATE|os.O_WRONLY)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		defer f.Close()
		if _, err := f.Seek(msg.Offset, io.SeekStart); err != nil {
			res.Error = err.Error()
			return res
		}
		if _, err := f.Write(chunkBytes); err != nil {
			res.Error = err.Error()
			return res
		}
		res.OK = true
		res.Offset = msg.Offset + int64(len(chunkBytes))
		return res

	case "upload_commit":
		partPath := cleanPath + ".part"
		if msg.Sha256 != "" {
			f, err := b.client.Open(partPath)
			if err != nil {
				res.Error = err.Error()
				return res
			}
			h := sha256.New()
			_, copyErr := io.Copy(h, f)
			_ = f.Close()
			if copyErr != nil {
				res.Error = copyErr.Error()
				return res
			}
			gotHex := hex.EncodeToString(h.Sum(nil))
			if !strings.EqualFold(gotHex, msg.Sha256) {
				res.Error = fmt.Sprintf("%s: got %s want %s", ErrChecksumFailed.Error(), gotHex, msg.Sha256)
				return res
			}
		}
		if err := b.client.PosixRename(partPath, cleanPath); err != nil {
			_ = b.client.Remove(cleanPath)
			if err2 := b.client.Rename(partPath, cleanPath); err2 != nil {
				res.Error = err2.Error()
				return res
			}
		}
		res.OK = true
		return res

	case "download_read", "read_file":
		f, err := b.client.Open(cleanPath)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			res.Error = err.Error()
			return res
		}
		readSize := msg.Size
		if readSize <= 0 || readSize > 1024*1024 {
			readSize = 256 * 1024
		}
		if _, err := f.Seek(msg.Offset, io.SeekStart); err != nil {
			res.Error = err.Error()
			return res
		}
		buf := make([]byte, readSize)
		n, err := f.Read(buf)
		if err != nil && !errors.Is(err, io.EOF) {
			res.Error = err.Error()
			return res
		}
		chunk := buf[:n]
		sum := sha256.Sum256(chunk)
		res.OK = true
		res.DataBase64 = base64.StdEncoding.EncodeToString(chunk)
		res.Offset = msg.Offset + int64(n)
		res.Size = st.Size()
		res.Sha256 = hex.EncodeToString(sum[:])
		return res

	case "write_file":
		raw, err := base64.StdEncoding.DecodeString(msg.DataBase64)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		f, err := b.client.OpenFile(cleanPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		_, writeErr := f.Write(raw)
		_ = f.Close()
		if writeErr != nil {
			res.Error = writeErr.Error()
			return res
		}
		res.OK = true
		return res

	default:
		res.Error = fmt.Sprintf("unsupported sftp op %q", msg.Op)
		return res
	}
}

type activeTunnel struct {
	id         string
	listener   net.Listener
	remoteAddr string
	bytesMoved atomic.Int64
}

type TunnelManager struct {
	client  *ssh.Client
	mu      sync.Mutex
	tunnels map[string]*activeTunnel
}

func NewTunnelManager(client *ssh.Client) *TunnelManager {
	return &TunnelManager{
		client:  client,
		tunnels: make(map[string]*activeTunnel),
	}
}

func (tm *TunnelManager) CloseAll() {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	for id, t := range tm.tunnels {
		if t.listener != nil {
			_ = t.listener.Close()
		}
		delete(tm.tunnels, id)
	}
}

func (tm *TunnelManager) HandleOp(msg protocol.ControlMessage) protocol.ControlMessage {
	res := protocol.ControlMessage{
		Type:     "tunnel_result",
		OpID:     msg.OpID,
		TunnelID: msg.TunnelID,
	}
	if tm == nil || tm.client == nil {
		res.Error = "SSH session not connected"
		return res
	}

	switch msg.Op {
	case "start":
		remoteHost := msg.RemoteHost
		if remoteHost == "" {
			remoteHost = "127.0.0.1"
		}
		if msg.RemotePort <= 0 || msg.RemotePort > 65535 {
			res.Error = fmt.Sprintf("invalid remote port %d", msg.RemotePort)
			return res
		}
		remoteTarget := fmt.Sprintf("%s:%d", remoteHost, msg.RemotePort)

		bindHost := msg.BindAddress
		if bindHost == "" {
			bindHost = "127.0.0.1"
		}
		localPort := msg.LocalPort
		if localPort < 0 || localPort > 65535 {
			res.Error = fmt.Sprintf("invalid local port %d", localPort)
			return res
		}
		listenAddr := fmt.Sprintf("%s:%d", bindHost, localPort)
		ln, err := net.Listen("tcp", listenAddr)
		if err != nil && localPort > 0 {
			// If requested port is unavailable or privileged, try ephemeral port only if requested or report actual bind error
			ln, err = net.Listen("tcp", fmt.Sprintf("%s:0", bindHost))
			if err != nil {
				res.Error = fmt.Sprintf("failed to bind local listener %s: %v", listenAddr, err)
				return res
			}
		} else if err != nil {
			res.Error = fmt.Sprintf("failed to bind local listener %s: %v", listenAddr, err)
			return res
		}

		tunID := msg.TunnelID
		if tunID == "" {
			tunID = fmt.Sprintf("tun_%d", time.Now().UnixNano())
		}
		tun := &activeTunnel{
			id:         tunID,
			listener:   ln,
			remoteAddr: remoteTarget,
		}

		tm.mu.Lock()
		if old, exists := tm.tunnels[tunID]; exists && old.listener != nil {
			_ = old.listener.Close()
		}
		tm.tunnels[tunID] = tun
		tm.mu.Unlock()

		go tm.acceptLoop(tun)

		res.OK = true
		res.TunnelID = tunID
		res.Active = true
		res.BoundAddress = ln.Addr().String()
		return res

	case "stop":
		tm.mu.Lock()
		tun, exists := tm.tunnels[msg.TunnelID]
		if exists {
			if tun.listener != nil {
				_ = tun.listener.Close()
			}
			delete(tm.tunnels, msg.TunnelID)
		}
		tm.mu.Unlock()
		res.OK = true
		res.Active = false
		return res

	case "http_preview":
		remoteHost := msg.RemoteHost
		if remoteHost == "" {
			remoteHost = "127.0.0.1"
		}
		port := msg.RemotePort
		if port <= 0 {
			port = msg.LocalPort
		}
		if port <= 0 || port > 65535 {
			res.Error = "invalid target port for HTTP preview"
			return res
		}
		target := fmt.Sprintf("%s:%d", remoteHost, port)
		rConn, err := tm.client.Dial("tcp", target)
		if err != nil {
			res.Error = fmt.Sprintf("remote tunnel dial %s failed: %v", target, err)
			return res
		}
		defer rConn.Close()
		_ = rConn.SetDeadline(time.Now().Add(4 * time.Second))

		reqPath := msg.HttpPath
		if reqPath == "" || !strings.HasPrefix(reqPath, "/") {
			reqPath = "/" + strings.TrimPrefix(reqPath, "/")
		}
		req, err := http.NewRequest(http.MethodGet, "http://"+target+reqPath, nil)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		req.Header.Set("Connection", "close")
		req.Header.Set("User-Agent", "WebSSH-Studio-Tunnel-Preview/1.0")
		if err := req.Write(rConn); err != nil {
			res.Error = fmt.Sprintf("failed writing HTTP request over tunnel: %v", err)
			return res
		}
		resp, err := http.ReadResponse(bufio.NewReader(rConn), req)
		if err != nil {
			res.Error = fmt.Sprintf("failed reading HTTP response from %s: %v", target, err)
			return res
		}
		defer resp.Body.Close()
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		res.OK = true
		res.StatusCode = resp.StatusCode
		res.StatusText = resp.Status
		res.BodyPreview = string(bodyBytes)
		res.BytesTransferred = int64(len(bodyBytes))
		return res

	default:
		res.Error = fmt.Sprintf("unsupported tunnel op %q", msg.Op)
		return res
	}
}

func (tm *TunnelManager) acceptLoop(tun *activeTunnel) {
	for {
		localConn, err := tun.listener.Accept()
		if err != nil {
			return
		}
		go func(lc net.Conn) {
			defer lc.Close()
			rc, err := tm.client.Dial("tcp", tun.remoteAddr)
			if err != nil {
				return
			}
			defer rc.Close()
			done := make(chan struct{}, 2)
			go func() {
				n, _ := io.Copy(rc, lc)
				tun.bytesMoved.Add(n)
				done <- struct{}{}
			}()
			go func() {
				n, _ := io.Copy(lc, rc)
				tun.bytesMoved.Add(n)
				done <- struct{}{}
			}()
			<-done
		}(localConn)
	}
}
