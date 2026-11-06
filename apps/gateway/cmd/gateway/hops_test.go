package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/webssh-studio/gateway/internal/protocol"
	"golang.org/x/crypto/ssh"
)

func TestResolveHopCredentials(t *testing.T) {
	target := protocol.ControlMessage{
		AuthMethod:           "remote_signer",
		Password:             "target-pass",
		PublicKey:            "ssh-ed25519 TARGET",
		PrivateKeyPem:        "TARGET PEM",
		PrivateKeyPassphrase: "target-phrase",
		KeyFingerprint:       "SHA256:target",
	}
	inherited := hopCredentials{
		AuthMethod:           "remote_signer",
		Password:             "target-pass",
		PublicKey:            "ssh-ed25519 TARGET",
		PrivateKeyPem:        "TARGET PEM",
		PrivateKeyPassphrase: "target-phrase",
		KeyFingerprint:       "SHA256:target",
		Inherited:            true,
	}
	cases := []struct {
		name string
		hop  protocol.JumpHop
		want hopCredentials
	}{
		{"no credentials inherits the target's", protocol.JumpHop{Host: "b"}, inherited},
		{"a passphrase alone is not a credential", protocol.JumpHop{Host: "b", PrivateKeyPassphrase: "hop-phrase"}, inherited},
		// Anything the hop sends counts as set: a blank-looking field must fail
		// loudly rather than quietly authenticate with the target's secrets.
		{"whitespace still counts as set", protocol.JumpHop{Host: "b", KeyFingerprint: " "}, hopCredentials{KeyFingerprint: " "}},
		{"own password only", protocol.JumpHop{Password: "hop-pass"}, hopCredentials{Password: "hop-pass"}},
		{"own auth method only", protocol.JumpHop{AuthMethod: "password"}, hopCredentials{AuthMethod: "password"}},
		{"own fingerprint only", protocol.JumpHop{KeyFingerprint: "SHA256:hop"}, hopCredentials{KeyFingerprint: "SHA256:hop"}},
		{"own public key", protocol.JumpHop{PublicKey: "ssh-ed25519 HOP"}, hopCredentials{PublicKey: "ssh-ed25519 HOP"}},
		{
			"own private key keeps its own passphrase",
			protocol.JumpHop{PrivateKeyPem: "HOP PEM", PrivateKeyPassphrase: "hop-phrase"},
			hopCredentials{PrivateKeyPem: "HOP PEM", PrivateKeyPassphrase: "hop-phrase"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveHopCredentials(tc.hop, target); got != tc.want {
				t.Fatalf("resolveHopCredentials() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

// auditHops pulls the jumps array out of the newest record of one event.
func auditHops(t *testing.T, logged, event string) []map[string]any {
	t.Helper()
	var hops []map[string]any
	found := false
	for _, line := range strings.Split(strings.TrimSpace(logged), "\n") {
		var rec struct {
			Event string           `json:"event"`
			Jumps []map[string]any `json:"jumps"`
		}
		if json.Unmarshal([]byte(line), &rec) == nil && rec.Event == event {
			hops, found = rec.Jumps, true
		}
	}
	if !found {
		t.Fatalf("no %s audit record in %s", event, logged)
	}
	return hops
}

func TestJumpHopsUseTheirOwnPasswordOrInheritTheTargets(t *testing.T) {
	target := newTestSSHD(t, "target-pass")
	ownCreds := newTestSSHD(t, "bastion-pass")
	inheriting := newTestSSHD(t, "target-pass")
	srv, auditLog := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	ownHost, ownPort := ownCreds.HostPort()
	inhHost, inhPort := inheriting.HostPort()
	msg := passwordConnect(target, "target-pass")
	msg.Jump = []protocol.JumpHop{
		{Host: ownHost, Port: ownPort, User: "ops", AuthMethod: "password", Password: "bastion-pass"},
		{Host: inhHost, Port: inhPort, User: "ubuntu"},
	}
	out := ws.connect(t, msg, nil)
	out.mustConnect(t)
	if len(out.prompts) != 3 {
		t.Fatalf("expected a host-key prompt per hop and the target, got %d", len(out.prompts))
	}

	hops := auditHops(t, auditLog.String(), "ssh.auth_success")
	want := []map[string]any{
		{"host": ownHost, "port": float64(ownPort), "user": "ops", "authMethod": "password"},
		{"host": inhHost, "port": float64(inhPort), "user": "ubuntu", "authMethod": "password"},
	}
	if fmt.Sprint(hops) != fmt.Sprint(want) {
		t.Fatalf("audit jumps = %v, want %v", hops, want)
	}
	for _, secret := range []string{"bastion-pass", "target-pass"} {
		if strings.Contains(auditLog.String(), secret) {
			t.Fatalf("audit log leaked a password: %s", auditLog.String())
		}
	}
}

func TestJumpHopWithOwnCredentialsNeverFallsBackToTheTargets(t *testing.T) {
	// Both hosts accept the target's password; the hop's own wrong password
	// must still fail, or a typo would silently authenticate as the target.
	target := newTestSSHD(t, "shared-pass")
	bastion := newTestSSHD(t, "shared-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	bastionHost, bastionPort := bastion.HostPort()
	msg := passwordConnect(target, "shared-pass")
	msg.Jump = []protocol.JumpHop{{Host: bastionHost, Port: bastionPort, User: "ops", Password: "wrong-pass"}}
	out := ws.connect(t, msg, nil)
	if out.failure == nil || out.failure.Code != "SSH_CONNECT_FAILED" || !strings.Contains(out.failure.Message, "ProxyJump hop 1") {
		t.Fatalf("expected the hop's own credentials to fail and name hop 1, got %+v", out.failure)
	}
	if len(out.prompts) != 1 {
		t.Fatalf("expected the chain to stop at the bastion, got %d host-key prompts", len(out.prompts))
	}
}

func TestJumpHopWithUnusableOwnCredentialsIsRejected(t *testing.T) {
	target := newTestSSHD(t, "target-pass")
	bastion := newTestSSHD(t, "target-pass")
	srv, _ := newTestGateway(t)
	ws := dialTestWS(t, srv.URL, "http://localhost:5173")
	defer ws.conn.Close()

	// A fingerprint names a key but carries no public key to sign with.
	bastionHost, bastionPort := bastion.HostPort()
	msg := passwordConnect(target, "target-pass")
	msg.Jump = []protocol.JumpHop{{Host: bastionHost, Port: bastionPort, User: "ops", KeyFingerprint: "SHA256:hop-only"}}
	out := ws.connect(t, msg, nil)
	if out.failure == nil || out.failure.Code != "INVALID_JUMP_CHAIN" || !strings.Contains(out.failure.Message, "hop 1") {
		t.Fatalf("expected INVALID_JUMP_CHAIN naming hop 1, got %+v", out.failure)
	}
	if len(out.prompts) != 0 {
		t.Fatalf("expected no SSH handshake for an unusable chain, got %d prompts", len(out.prompts))
	}
}

func TestRemoteSignerSignRequestsNameTheirHop(t *testing.T) {
	hopPub, hopPriv, _ := ed25519.GenerateKey(rand.Reader)
	hopKey, _ := ssh.NewPublicKey(hopPub)
	targetPub, targetPriv, _ := ed25519.GenerateKey(rand.Reader)
	targetKey, _ := ssh.NewPublicKey(targetPub)

	signWith := map[string]ed25519.PrivateKey{
		ssh.FingerprintSHA256(hopKey):    hopPriv,
		ssh.FingerprintSHA256(targetKey): targetPriv,
	}
	sign := func(req protocol.ControlMessage) []byte {
		data, err := base64.StdEncoding.DecodeString(req.DataBase64)
		if err != nil {
			t.Fatalf("sign_request carried invalid base64: %v", err)
		}
		priv, ok := signWith[req.KeyFingerprint]
		if !ok {
			t.Fatalf("sign_request for unknown key %q", req.KeyFingerprint)
		}
		return ed25519.Sign(priv, data)
	}

	t.Run("hop with its own key", func(t *testing.T) {
		target := newTestSSHD(t, "target-pass")
		bastion := newTestSSHD(t, "", hopKey)
		srv, auditLog := newTestGateway(t)
		ws := dialTestWS(t, srv.URL, "http://localhost:5173")
		defer ws.conn.Close()

		bastionHost, bastionPort := bastion.HostPort()
		msg := passwordConnect(target, "target-pass")
		msg.Jump = []protocol.JumpHop{{
			Host:           bastionHost,
			Port:           bastionPort,
			User:           "ops",
			AuthMethod:     "remote_signer",
			PublicKey:      string(ssh.MarshalAuthorizedKey(hopKey)),
			KeyFingerprint: ssh.FingerprintSHA256(hopKey),
		}}
		out := ws.connect(t, msg, sign)
		out.mustConnect(t)
		if len(out.signRequests) == 0 {
			t.Fatal("expected the bastion to be authenticated through sign_request")
		}
		for _, req := range out.signRequests {
			if req.KeyFingerprint != ssh.FingerprintSHA256(hopKey) || req.Host != bastionHost || req.Port != bastionPort || req.HopIndex != 1 {
				t.Fatalf("sign_request = %+v, want the bastion's fingerprint, %s:%d and hopIndex 1", req, bastionHost, bastionPort)
			}
		}
		hops := auditHops(t, auditLog.String(), "ssh.auth_success")
		if len(hops) != 1 || hops[0]["authMethod"] != "remote_signer (ssh-ed25519)" {
			t.Fatalf("audit jumps = %v", hops)
		}
	})

	t.Run("hop inheriting the target's key", func(t *testing.T) {
		target := newTestSSHD(t, "", targetKey)
		bastion := newTestSSHD(t, "", targetKey)
		srv, _ := newTestGateway(t)
		ws := dialTestWS(t, srv.URL, "http://localhost:5173")
		defer ws.conn.Close()

		targetHost, targetPort := target.HostPort()
		bastionHost, bastionPort := bastion.HostPort()
		out := ws.connect(t, protocol.ControlMessage{
			Type:           "connect",
			Host:           targetHost,
			Port:           targetPort,
			User:           "ubuntu",
			AuthMethod:     "remote_signer",
			PublicKey:      string(ssh.MarshalAuthorizedKey(targetKey)),
			KeyFingerprint: ssh.FingerprintSHA256(targetKey),
			Jump:           []protocol.JumpHop{{Host: bastionHost, Port: bastionPort, User: "ops"}},
			Cols:           80,
			Rows:           24,
		}, sign)
		out.mustConnect(t)

		var sawHop, sawTarget bool
		for i, req := range out.signRequests {
			if req.KeyFingerprint != ssh.FingerprintSHA256(targetKey) {
				t.Fatalf("sign_request %d used fingerprint %q", i, req.KeyFingerprint)
			}
			switch {
			case req.HopIndex == 1 && req.Host == bastionHost && req.Port == bastionPort:
				sawHop = true
			case req.HopIndex == 0 && req.Host == targetHost && req.Port == targetPort:
				sawTarget = true
				// The final target is hopIndex 0, which stays off the wire.
				if strings.Contains(string(out.signRaw[i]), `"hopIndex"`) {
					t.Fatalf("the target's sign_request must omit hopIndex: %s", out.signRaw[i])
				}
			default:
				t.Fatalf("sign_request %d names neither the bastion nor the target: %+v", i, req)
			}
		}
		if !sawHop || !sawTarget {
			t.Fatalf("expected sign requests for the bastion and the target, got %+v", out.signRequests)
		}
	})
}
