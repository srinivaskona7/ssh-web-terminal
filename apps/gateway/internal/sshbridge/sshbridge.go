package sshbridge

import (
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
	"os"
	"path"
	"path/filepath"
	"strings"
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

type HopConfig struct {
	Addr   string
	Host   string
	Port   int
	User   string
	Signer ssh.Signer
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
		cfg := &ssh.ClientConfig{
			User: hop.User,
			Auth: []ssh.AuthMethod{ssh.PublicKeys(hop.Signer)},
			HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
				if hkCb == nil {
					return nil
				}
				return hkCb(ctx, hop.Host, hop.Port, key)
			},
			Timeout: 10 * time.Second,
		}

		if i == 0 {
			var d net.Dialer
			conn, err := d.DialContext(ctx, "tcp", hop.Addr)
			if err != nil {
				return nil, err
			}
			c, chans, reqs, err := ssh.NewClientConn(conn, hop.Addr, cfg)
			if err != nil {
				_ = conn.Close()
				return nil, err
			}
			currentClient = ssh.NewClient(c, chans, reqs)
		} else {
			prevClient := currentClient
			conn, err := prevClient.Dial("tcp", hop.Addr)
			if err != nil {
				_ = prevClient.Close()
				return nil, err
			}
			wrappedConn := &chainedConn{Conn: conn, parent: prevClient}
			c, chans, reqs, err := ssh.NewClientConn(wrappedConn, hop.Addr, cfg)
			if err != nil {
				_ = wrappedConn.Close()
				return nil, err
			}
			currentClient = ssh.NewClient(c, chans, reqs)
		}
	}
	return currentClient, nil
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
	if trimmed == "" {
		return ".", nil
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
			entries = append(entries, protocol.SftpDirEntry{
				Name:    info.Name(),
				Path:    path.Join(cleanPath, info.Name()),
				Size:    info.Size(),
				Mode:    info.Mode().String(),
				ModTime: info.ModTime().Unix(),
				IsDir:   info.IsDir(),
			})
		}
		res.OK = true
		res.Entries = entries
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
