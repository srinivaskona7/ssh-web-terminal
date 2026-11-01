package policy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
)

var (
	ErrDestinationDenied = errors.New("policy: destination blocked by security policy")
	ErrInvalidHostPort   = errors.New("policy: invalid host or port")
)

type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type netResolver struct{}

func (netResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return net.DefaultResolver.LookupNetIP(ctx, network, host)
}

type Config struct {
	Allowlist []string
	Denylist  []string
	Resolver  Resolver
}

type Guard struct {
	allowPrefixes []netip.Prefix
	allowHosts    map[string]struct{}
	denyPrefixes  []netip.Prefix
	denyHosts     map[string]struct{}
	defaultDeny   []netip.Prefix
	resolver      Resolver
}

var defaultBlockedCIDRs = []string{
	"0.0.0.0/8",          // Unspecified IPv4
	"127.0.0.0/8",        // Loopback IPv4
	"10.0.0.0/8",         // RFC1918 Private
	"172.16.0.0/12",      // RFC1918 Private
	"192.168.0.0/16",     // RFC1918 Private
	"169.254.0.0/16",     // Link-local & Cloud Metadata (169.254.169.254)
	"100.64.0.0/10",      // CGNAT
	"192.0.0.0/24",       // IETF protocol assignments
	"192.0.2.0/24",       // TEST-NET-1
	"198.18.0.0/15",      // Benchmarking
	"198.51.100.0/24",    // TEST-NET-2
	"203.0.113.0/24",     // TEST-NET-3
	"224.0.0.0/4",        // Multicast IPv4
	"240.0.0.0/4",        // Reserved IPv4
	"::/128",             // Unspecified IPv6
	"::1/128",            // Loopback IPv6
	"fe80::/10",          // Link-local IPv6
	"fc00::/7",           // Unique local IPv6 (ULA)
	"ff00::/8",           // Multicast IPv6
	"2001:db8::/32",      // Documentation IPv6
	"100::/64",           // Discard-only IPv6
}

func NewGuard(cfg Config) (*Guard, error) {
	g := &Guard{
		allowHosts: make(map[string]struct{}),
		denyHosts:  make(map[string]struct{}),
		resolver:   cfg.Resolver,
	}
	if g.resolver == nil {
		g.resolver = netResolver{}
	}

	for _, cidr := range defaultBlockedCIDRs {
		p, err := netip.ParsePrefix(cidr)
		if err != nil {
			return nil, err
		}
		g.defaultDeny = append(g.defaultDeny, p)
	}

	if err := parseEntries(cfg.Allowlist, &g.allowPrefixes, g.allowHosts); err != nil {
		return nil, fmt.Errorf("invalid allowlist: %w", err)
	}
	if err := parseEntries(cfg.Denylist, &g.denyPrefixes, g.denyHosts); err != nil {
		return nil, fmt.Errorf("invalid denylist: %w", err)
	}
	return g, nil
}

func parseEntries(entries []string, prefixes *[]netip.Prefix, hosts map[string]struct{}) error {
	for _, raw := range entries {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		if p, err := netip.ParsePrefix(item); err == nil {
			*prefixes = append(*prefixes, p.Masked())
			continue
		}
		if addr, err := netip.ParseAddr(item); err == nil {
			ua := addr.Unmap()
			bits := 128
			if ua.Is4() {
				bits = 32
			}
			*prefixes = append(*prefixes, netip.PrefixFrom(ua, bits))
			continue
		}
		hosts[strings.ToLower(item)] = struct{}{}
	}
	return nil
}

// Check resolves and validates a target host and port against SSRF and destination policies.
// It returns the verified IP address to dial directly (preventing DNS rebinding between check and dial).
func (g *Guard) Check(ctx context.Context, host string, port int) (netip.Addr, error) {
	cleanHost := strings.TrimSpace(strings.ToLower(host))
	cleanHost = strings.TrimPrefix(cleanHost, "[")
	cleanHost = strings.TrimSuffix(cleanHost, "]")

	if cleanHost == "" || port <= 0 || port > 65535 {
		return netip.Addr{}, fmt.Errorf("%w: %s:%d", ErrInvalidHostPort, host, port)
	}

	// Reject numeric-encoded / octal / hex IPv4 tricks if not standard dotted-quad or hostname
	if isSuspiciousNumericHost(cleanHost) {
		return netip.Addr{}, fmt.Errorf("%w: non-canonical numeric host %q", ErrDestinationDenied, host)
	}

	if _, denied := g.denyHosts[cleanHost]; denied {
		return netip.Addr{}, fmt.Errorf("%w: host %q in denylist", ErrDestinationDenied, cleanHost)
	}
	_, hostAllowlisted := g.allowHosts[cleanHost]

	var resolved []netip.Addr
	if ip, err := netip.ParseAddr(cleanHost); err == nil {
		resolved = []netip.Addr{ip.Unmap()}
	} else {
		ips, err := g.resolver.LookupNetIP(ctx, "ip", cleanHost)
		if err != nil || len(ips) == 0 {
			return netip.Addr{}, fmt.Errorf("%w: DNS lookup failed for %q", ErrDestinationDenied, cleanHost)
		}
		for _, ip := range ips {
			resolved = append(resolved, ip.Unmap())
		}
	}

	// Every resolved IP must pass policy to prevent DNS rebinding / multi-record bypass
	for _, addr := range resolved {
		if err := g.checkAddr(addr, hostAllowlisted); err != nil {
			return netip.Addr{}, err
		}
	}

	return resolved[0], nil
}

func (g *Guard) checkAddr(addr netip.Addr, hostAllowlisted bool) error {
	ua := addr.Unmap()
	if !ua.IsValid() {
		return fmt.Errorf("%w: invalid IP", ErrDestinationDenied)
	}

	for _, p := range g.denyPrefixes {
		if p.Contains(ua) {
			return fmt.Errorf("%w: IP %s matched explicit denylist %s", ErrDestinationDenied, ua, p)
		}
	}

	for _, p := range g.allowPrefixes {
		if p.Contains(ua) {
			return nil
		}
	}
	if hostAllowlisted {
		return nil
	}

	for _, p := range g.defaultDeny {
		if p.Contains(ua) {
			return fmt.Errorf("%w: IP %s in restricted range %s", ErrDestinationDenied, ua, p)
		}
	}

	if ua.IsLoopback() || ua.IsLinkLocalUnicast() || ua.IsLinkLocalMulticast() || ua.IsMulticast() || ua.IsPrivate() || ua.IsUnspecified() {
		return fmt.Errorf("%w: IP %s is non-public", ErrDestinationDenied, ua)
	}

	return nil
}

func isSuspiciousNumericHost(host string) bool {
	// Reject pure decimal integers (e.g. 2130706433 for 127.0.0.1) or hex/octal segments (0x7f.0.0.1, 0177.0.0.1)
	allDigits := true
	for i := 0; i < len(host); i++ {
		if host[i] < '0' || host[i] > '9' {
			allDigits = false
			break
		}
	}
	if allDigits {
		return true
	}
	parts := strings.Split(host, ".")
	allNumericOrHex := true
	hasOctalOrHex := false
	for _, part := range parts {
		if part == "" {
			return true
		}
		if strings.HasPrefix(part, "0x") || strings.HasPrefix(part, "0X") {
			hasOctalOrHex = true
			continue
		}
		isNum := true
		for i := 0; i < len(part); i++ {
			if part[i] < '0' || part[i] > '9' {
				isNum = false
				break
			}
		}
		if !isNum {
			allNumericOrHex = false
			break
		}
		if len(part) > 1 && part[0] == '0' {
			hasOctalOrHex = true
		}
	}
	return allNumericOrHex && hasOctalOrHex
}
