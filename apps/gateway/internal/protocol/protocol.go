package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
)

const (
	HeaderByteLength          = 15
	MaxFramePayloadBytes      = 4 * 1024 * 1024 // 4 MiB
	DefaultChannelCreditBytes = 512 * 1024      // 512 KiB

	ControlChannelID   uint16 = 0
	FirstPtyChannelID  uint16 = 1
	FirstSftpChannelID uint16 = 1024
)

type FrameType uint8

const (
	FrameTypeControl  FrameType = 1
	FrameTypePtyData  FrameType = 2
	FrameTypeSftpData FrameType = 3
	FrameTypePing     FrameType = 4
	FrameTypePong     FrameType = 5
)

var (
	ErrTruncatedHeader = errors.New("protocol: frame shorter than 15-byte header")
	ErrInvalidType     = errors.New("protocol: invalid frame type")
	ErrPayloadTooLarge = errors.New("protocol: frame payload exceeds maximum")
	ErrLengthMismatch  = errors.New("protocol: frame byte length does not match declared payload length")
	ErrInvalidControl  = errors.New("protocol: invalid control message JSON")
)

type BinaryFrame struct {
	Type    FrameType
	Channel uint16
	Seq     uint64
	Payload []byte
}

type JumpHop struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	User           string `json:"user"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
}

type SftpDirEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime int64  `json:"modTime"`
	IsDir   bool   `json:"isDir"`
}

type ControlMessage struct {
	Type                 string         `json:"type"`
	ProtocolVersion      int            `json:"protocolVersion,omitempty"`
	ClientVersion        string         `json:"clientVersion,omitempty"`
	OIDCToken            string         `json:"oidcToken,omitempty"`
	SessionID            string         `json:"sessionId,omitempty"`
	Host                 string         `json:"host,omitempty"`
	Port                 int            `json:"port,omitempty"`
	User                 string         `json:"user,omitempty"`
	AuthMethod           string         `json:"authMethod,omitempty"`
	Password             string         `json:"password,omitempty"`
	PrivateKeyPem        string         `json:"privateKeyPem,omitempty"`
	PrivateKeyPassphrase string         `json:"privateKeyPassphrase,omitempty"`
	PublicKey            string         `json:"publicKey,omitempty"`
	KeyFingerprint       string         `json:"keyFingerprint,omitempty"`
	Jump                 []JumpHop      `json:"jump,omitempty"`
	Cols                 int            `json:"cols,omitempty"`
	Rows                 int            `json:"rows,omitempty"`
	TmuxSession          string         `json:"tmuxSession,omitempty"`
	Algorithm            string         `json:"algorithm,omitempty"`
	Fingerprint          string         `json:"fingerprint,omitempty"`
	PublicKeyBase64      string         `json:"publicKeyBase64,omitempty"`
	Trusted              bool           `json:"trusted,omitempty"`
	OverrideMismatch     bool           `json:"overrideMismatch,omitempty"`
	RequestID            string         `json:"requestId,omitempty"`
	DataBase64           string         `json:"dataBase64,omitempty"`
	SignatureBase64      string         `json:"signatureBase64,omitempty"`
	ResumeToken          string         `json:"resumeToken,omitempty"`
	PtyChannel           uint16         `json:"ptyChannel,omitempty"`
	Cipher               string         `json:"cipher,omitempty"`
	Kex                  string         `json:"kex,omitempty"`
	ServerVersion        string         `json:"serverVersion,omitempty"`
	AuthMethodUsed       string         `json:"authMethodUsed,omitempty"`
	SftpReady            bool           `json:"sftpReady,omitempty"`
	SftpError            string         `json:"sftpError,omitempty"`
	Channel              uint16         `json:"channel,omitempty"`
	Token                string         `json:"token,omitempty"`
	LastSeq              string         `json:"lastSeq,omitempty"`
	Seq                  string         `json:"seq,omitempty"`
	Bytes                int            `json:"bytes,omitempty"`
	FirstAvailableSeq    string         `json:"firstAvailableSeq,omitempty"`
	TruncatedBytes       int            `json:"truncatedBytes,omitempty"`
	OpID                 string         `json:"opId,omitempty"`
	Op                   string         `json:"op,omitempty"`
	Path                 string         `json:"path,omitempty"`
	TargetPath           string         `json:"targetPath,omitempty"`
	Mode                 string         `json:"mode,omitempty"`
	Offset               int64          `json:"offset,omitempty"`
	Size                 int64          `json:"size,omitempty"`
	Sha256               string         `json:"sha256,omitempty"`
	OK                   bool           `json:"ok,omitempty"`
	Entries              []SftpDirEntry `json:"entries,omitempty"`
	Command              string         `json:"command,omitempty"`
	TimeoutMs            int            `json:"timeoutMs,omitempty"`
	Stdout               string         `json:"stdout,omitempty"`
	Stderr               string         `json:"stderr,omitempty"`
	ExitCode             int            `json:"exitCode,omitempty"`
	DurationMs           int64          `json:"durationMs,omitempty"`
	TunnelID             string         `json:"tunnelId,omitempty"`
	ForwardType          string         `json:"forwardType,omitempty"`
	BindAddress          string         `json:"bindAddress,omitempty"`
	LocalPort            int            `json:"localPort,omitempty"`
	RemoteHost           string         `json:"remoteHost,omitempty"`
	RemotePort           int            `json:"remotePort,omitempty"`
	HttpPath             string         `json:"httpPath,omitempty"`
	Active               bool           `json:"active,omitempty"`
	BoundAddress         string         `json:"boundAddress,omitempty"`
	StatusCode           int            `json:"statusCode,omitempty"`
	StatusText           string         `json:"statusText,omitempty"`
	BodyPreview          string         `json:"bodyPreview,omitempty"`
	BytesTransferred     int64          `json:"bytesTransferred,omitempty"`
	Error                string         `json:"error,omitempty"`
	Code                 string         `json:"code,omitempty"`
	Message              string         `json:"message,omitempty"`
	Fatal                bool           `json:"fatal,omitempty"`
}

func EncodeFrame(f BinaryFrame) ([]byte, error) {
	if f.Type < FrameTypeControl || f.Type > FrameTypePong {
		return nil, fmt.Errorf("%w: %d", ErrInvalidType, f.Type)
	}
	if len(f.Payload) > MaxFramePayloadBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrPayloadTooLarge, len(f.Payload), MaxFramePayloadBytes)
	}
	out := make([]byte, HeaderByteLength+len(f.Payload))
	out[0] = byte(f.Type)
	binary.BigEndian.PutUint16(out[1:3], f.Channel)
	binary.BigEndian.PutUint64(out[3:11], f.Seq)
	binary.BigEndian.PutUint32(out[11:15], uint32(len(f.Payload)))
	copy(out[HeaderByteLength:], f.Payload)
	return out, nil
}

func DecodeFrame(raw []byte) (BinaryFrame, error) {
	if len(raw) < HeaderByteLength {
		return BinaryFrame{}, fmt.Errorf("%w: got %d bytes", ErrTruncatedHeader, len(raw))
	}
	ft := FrameType(raw[0])
	if ft < FrameTypeControl || ft > FrameTypePong {
		return BinaryFrame{}, fmt.Errorf("%w: %d", ErrInvalidType, ft)
	}
	ch := binary.BigEndian.Uint16(raw[1:3])
	seq := binary.BigEndian.Uint64(raw[3:11])
	payloadLen := binary.BigEndian.Uint32(raw[11:15])
	if payloadLen > MaxFramePayloadBytes {
		return BinaryFrame{}, fmt.Errorf("%w: %d", ErrPayloadTooLarge, payloadLen)
	}
	if uint64(len(raw)) != uint64(HeaderByteLength)+uint64(payloadLen) {
		return BinaryFrame{}, fmt.Errorf("%w: got %d want %d", ErrLengthMismatch, len(raw), HeaderByteLength+int(payloadLen))
	}
	payload := make([]byte, payloadLen)
	copy(payload, raw[HeaderByteLength:])
	return BinaryFrame{
		Type:    ft,
		Channel: ch,
		Seq:     seq,
		Payload: payload,
	}, nil
}

func EncodeControlFrame(seq uint64, msg ControlMessage) ([]byte, error) {
	if msg.Type == "" {
		return nil, fmt.Errorf("%w: empty type", ErrInvalidControl)
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidControl, err)
	}
	return EncodeFrame(BinaryFrame{
		Type:    FrameTypeControl,
		Channel: ControlChannelID,
		Seq:     seq,
		Payload: payload,
	})
}

func DecodeControlPayload(payload []byte) (ControlMessage, error) {
	var msg ControlMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		return ControlMessage{}, fmt.Errorf("%w: %v", ErrInvalidControl, err)
	}
	if msg.Type == "" {
		return ControlMessage{}, fmt.Errorf("%w: missing type field", ErrInvalidControl)
	}
	return msg, nil
}

type FlowController struct {
	mu            sync.Mutex
	credits       map[uint16]int
	defaultCredit int
}

func NewFlowController(defaultCredit int) *FlowController {
	if defaultCredit <= 0 {
		defaultCredit = DefaultChannelCreditBytes
	}
	return &FlowController{
		credits:       make(map[uint16]int),
		defaultCredit: defaultCredit,
	}
}

func (fc *FlowController) Available(channel uint16) int {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	c, ok := fc.credits[channel]
	if !ok {
		fc.credits[channel] = fc.defaultCredit
		return fc.defaultCredit
	}
	return c
}

func (fc *FlowController) Consume(channel uint16, n int) bool {
	if n < 0 {
		return false
	}
	fc.mu.Lock()
	defer fc.mu.Unlock()
	avail, ok := fc.credits[channel]
	if !ok {
		avail = fc.defaultCredit
	}
	if avail < n {
		return false
	}
	fc.credits[channel] = avail - n
	return true
}

func (fc *FlowController) Grant(channel uint16, n int) int {
	if n <= 0 {
		return fc.Available(channel)
	}
	fc.mu.Lock()
	defer fc.mu.Unlock()
	avail, ok := fc.credits[channel]
	if !ok {
		avail = fc.defaultCredit
	}
	next := avail + n
	fc.credits[channel] = next
	return next
}
