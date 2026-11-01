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
	"path/filepath"
	"strings"
	"sync"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Server is an embedded OpenSSH-compatible SSH + SFTP server for deterministic integration testing.
type Server struct {
	listener   net.Listener
	hostSigner ssh.Signer
	rootDir    string
	password   string

	mu             sync.RWMutex
	authorizedKeys map[string]bool
	wg             sync.WaitGroup
	closed         chan struct{}
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
	return s.hostSigner.PublicKey()
}

func (s *Server) Close() error {
	close(s.closed)
	err := s.listener.Close()
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
		s.wg.Add(1)
		go func(c net.Conn) {
			defer s.wg.Done()
			s.handleConn(c)
		}(conn)
	}
}

func (s *Server) handleConn(nConn net.Conn) {
	defer nConn.Close()

	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if s.isKeyAuthorized(key) {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("public key not authorized")
		},
		PasswordCallback: func(conn ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if s.password != "" && string(pass) == s.password {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("invalid password")
		},
	}
	cfg.AddHostKey(s.hostSigner)

	_, chans, reqs, err := ssh.NewServerConn(nConn, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)

	for newChan := range chans {
		switch newChan.ChannelType() {
		case "session":
			ch, requests, err := newChan.Accept()
			if err != nil {
				continue
			}
			go s.handleSessionChannel(ch, requests)
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
	target := fmt.Sprintf("%s:%d", msg.DestAddr, msg.DestPort)
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

func (s *Server) handleSessionChannel(ch ssh.Channel, requests <-chan *ssh.Request) {
	for req := range requests {
		switch req.Type {
		case "pty-req", "window-change", "env":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		case "shell":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			go func() {
				defer ch.Close()
				_, _ = ch.Write([]byte("webssh-test-shell$ "))
				buf := make([]byte, 1024)
				for {
					n, err := ch.Read(buf)
					if n > 0 {
						chunk := string(buf[:n])
						if strings.Contains(chunk, "exit") {
							_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(&struct{ Status uint32 }{0}))
							return
						}
						_, _ = ch.Write([]byte("echo:" + chunk))
					}
					if err != nil {
						return
					}
				}
			}()
		case "exec":
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
			var payload struct{ Command string }
			_ = ssh.Unmarshal(req.Payload, &payload)
			go func(cmd string) {
				defer ch.Close()
				_, _ = ch.Write([]byte("executed:" + cmd))
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(&struct{ Status uint32 }{0}))
			}(payload.Command)
		case "subsystem":
			var sub struct{ Name string }
			_ = ssh.Unmarshal(req.Payload, &sub)
			if sub.Name == "sftp" {
				if req.WantReply {
					_ = req.Reply(true, nil)
				}
				go func() {
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
