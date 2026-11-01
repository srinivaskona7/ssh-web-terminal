package sshbridge

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"path/filepath"
	"testing"

	"github.com/pkg/sftp"
	"github.com/webssh-studio/gateway/internal/protocol"
	"github.com/webssh-studio/gateway/internal/testsshd"
	"golang.org/x/crypto/ssh"
)

func TestRemoteSignerEd25519AndECDSAP256WithOpenSSHServer(t *testing.T) {
	// 1. Generate browser-side Ed25519 and ECDSA P-256 keys
	edPub, edPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519 generate failed: %v", err)
	}
	edSSHPub, err := ssh.NewPublicKey(edPub)
	if err != nil {
		t.Fatalf("ssh.NewPublicKey ed25519 failed: %v", err)
	}

	ecPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ecdsa P-256 generate failed: %v", err)
	}
	ecSSHPub, err := ssh.NewPublicKey(&ecPriv.PublicKey)
	if err != nil {
		t.Fatalf("ssh.NewPublicKey ecdsa failed: %v", err)
	}

	tmpDir := t.TempDir()
	sshd, err := testsshd.NewServer(tmpDir, "one-time-pass", []ssh.PublicKey{edSSHPub})
	if err != nil {
		t.Fatalf("testsshd.NewServer failed: %v", err)
	}
	defer sshd.Close()

	host, port := sshd.HostPort()

	// 2. Authenticate with Ed25519 RemoteSigner (key stays in callback closure, never exposed to SSH client)
	edRemoteSigner := NewRemoteSigner(edSSHPub, func(_ context.Context, alg string, data []byte) ([]byte, error) {
		if alg != ssh.KeyAlgoED25519 {
			t.Fatalf("expected ssh-ed25519, got %s", alg)
		}
		return ed25519.Sign(edPriv, data), nil
	})

	var observedFingerprint string
	client, err := DialChain(context.Background(), nil, HopConfig{
		Addr:   sshd.Addr(),
		Host:   host,
		Port:   port,
		User:   "ubuntu",
		Signer: edRemoteSigner,
	}, func(_ context.Context, _ string, _ int, key ssh.PublicKey) error {
		observedFingerprint = FormatHostKeyFingerprint(key)
		return nil
	})
	if err != nil {
		t.Fatalf("DialChain with Ed25519 RemoteSigner failed: %v", err)
	}
	defer client.Close()

	if observedFingerprint != FormatHostKeyFingerprint(sshd.HostKey()) {
		t.Fatalf("host key fingerprint mismatch: got %s", observedFingerprint)
	}

	// 3. Test one-time key deployment (ssh-copy-id) for the ECDSA P-256 key, then authenticate via IEEE-P1363 signature conversion!
	ecAuthorizedLine := string(ssh.MarshalAuthorizedKey(ecSSHPub))
	if err := DeployAuthorizedKey(context.Background(), sshd.Addr(), host, port, "ubuntu", "one-time-pass", ecAuthorizedLine, nil); err != nil {
		t.Fatalf("DeployAuthorizedKey failed: %v", err)
	}

	ecRemoteSigner := NewRemoteSigner(ecSSHPub, func(_ context.Context, alg string, data []byte) ([]byte, error) {
		// Simulate WebCrypto ECDSA P-256 sign() which hashes with SHA-256 and returns 64-byte IEEE-P1363 (r || s)
		digest := sha256.Sum256(data)
		r, s, err := ecdsa.Sign(rand.Reader, ecPriv, digest[:])
		if err != nil {
			return nil, err
		}
		p1363 := make([]byte, 64)
		rBytes := r.Bytes()
		sBytes := s.Bytes()
		copy(p1363[32-len(rBytes):32], rBytes)
		copy(p1363[64-len(sBytes):64], sBytes)
		return p1363, nil
	})

	// Also test ProxyJump chain: hop through sshd (bastion) to sshd (target)
	bastionHop := HopConfig{
		Addr:   sshd.Addr(),
		Host:   host,
		Port:   port,
		User:   "ubuntu",
		Signer: edRemoteSigner,
	}
	targetHop := HopConfig{
		Addr:   sshd.Addr(),
		Host:   host,
		Port:   port,
		User:   "ubuntu",
		Signer: ecRemoteSigner,
	}
	chainedClient, err := DialChain(context.Background(), []HopConfig{bastionHop}, targetHop, nil)
	if err != nil {
		t.Fatalf("DialChain with ProxyJump + P1363 ECDSA RemoteSigner failed: %v", err)
	}
	defer chainedClient.Close()

	// 4. Test SFTP chunked resumable upload (.part -> SHA-256 verification -> atomic rename) & download
	sftpClient, err := sftp.NewClient(chainedClient)
	if err != nil {
		t.Fatalf("sftp.NewClient failed: %v", err)
	}
	defer sftpClient.Close()

	bridge := NewSFTPBridge(sftpClient)
	remoteFile := filepath.ToSlash(filepath.Join(tmpDir, "release.bin"))

	initRes := bridge.HandleOp(protocol.ControlMessage{
		OpID: "op-1",
		Op:   "upload_init",
		Path: remoteFile,
	})
	if !initRes.OK || initRes.Offset != 0 {
		t.Fatalf("upload_init failed: %+v", initRes)
	}

	chunk1 := bytes.Repeat([]byte("A"), 256*1024)
	chunk2 := bytes.Repeat([]byte("B"), 128*1024)
	c1Sum := sha256.Sum256(chunk1)
	c2Sum := sha256.Sum256(chunk2)

	res1 := bridge.HandleOp(protocol.ControlMessage{
		OpID:       "op-2",
		Op:         "upload_chunk",
		Path:       remoteFile,
		Offset:     0,
		DataBase64: base64.StdEncoding.EncodeToString(chunk1),
		Sha256:     hex.EncodeToString(c1Sum[:]),
	})
	if !res1.OK || res1.Offset != int64(len(chunk1)) {
		t.Fatalf("upload_chunk 1 failed: %+v", res1)
	}

	// Simulate interrupted upload resume: upload_init returns current .part offset (256 KiB)
	resumeRes := bridge.HandleOp(protocol.ControlMessage{
		OpID: "op-3",
		Op:   "upload_init",
		Path: remoteFile,
	})
	if !resumeRes.OK || resumeRes.Offset != int64(len(chunk1)) {
		t.Fatalf("upload_init resume expected offset %d, got %+v", len(chunk1), resumeRes)
	}

	res2 := bridge.HandleOp(protocol.ControlMessage{
		OpID:       "op-4",
		Op:         "upload_chunk",
		Path:       remoteFile,
		Offset:     resumeRes.Offset,
		DataBase64: base64.StdEncoding.EncodeToString(chunk2),
		Sha256:     hex.EncodeToString(c2Sum[:]),
	})
	if !res2.OK || res2.Offset != int64(len(chunk1)+len(chunk2)) {
		t.Fatalf("upload_chunk 2 failed: %+v", res2)
	}

	fullHash := sha256.New()
	fullHash.Write(chunk1)
	fullHash.Write(chunk2)
	fullHex := hex.EncodeToString(fullHash.Sum(nil))

	commitRes := bridge.HandleOp(protocol.ControlMessage{
		OpID:   "op-5",
		Op:     "upload_commit",
		Path:   remoteFile,
		Sha256: fullHex,
	})
	if !commitRes.OK {
		t.Fatalf("upload_commit failed: %+v", commitRes)
	}

	dlRes := bridge.HandleOp(protocol.ControlMessage{
		OpID:   "op-6",
		Op:     "download_read",
		Path:   remoteFile,
		Offset: 0,
		Size:   64,
	})
	if !dlRes.OK || dlRes.Size != int64(len(chunk1)+len(chunk2)) {
		t.Fatalf("download_read failed: %+v", dlRes)
	}
}
