package policy

import (
	"context"
	"net/netip"
	"testing"
)

type mockResolver struct {
	records map[string][]netip.Addr
}

func (m mockResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return m.records[host], nil
}

func TestGuardBlocksSSRFVectorsByDefault(t *testing.T) {
	resolver := mockResolver{
		records: map[string][]netip.Addr{
			"public.example.com":  {netip.MustParseAddr("93.184.216.34")},
			"rebind.example.com":  {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("169.254.169.254")},
			"internal.corp.local": {netip.MustParseAddr("10.24.1.15")},
		},
	}

	g, err := NewGuard(Config{Resolver: resolver})
	if err != nil {
		t.Fatalf("NewGuard failed: %v", err)
	}

	blockedCases := []struct {
		name string
		host string
		port int
	}{
		{"IPv4 loopback", "127.0.0.1", 22},
		{"IPv4 loopback subnet", "127.0.1.99", 22},
		{"IPv6 loopback", "::1", 22},
		{"IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1", 22},
		{"Cloud metadata AWS/GCP/Azure", "169.254.169.254", 80},
		{"IPv4-mapped metadata", "::ffff:169.254.169.254", 80},
		{"Link-local IPv6", "fe80::1", 22},
		{"RFC1918 10/8", "10.0.0.5", 22},
		{"RFC1918 172.16/12", "172.20.0.1", 22},
		{"RFC1918 192.168/16", "192.168.1.10", 22},
		{"IPv6 ULA", "fd00::1234", 22},
		{"CGNAT", "100.64.1.1", 22},
		{"Unspecified", "0.0.0.0", 22},
		{"Decimal encoded 127.0.0.1", "2130706433", 22},
		{"Hex encoded 127.0.0.1", "0x7f.0.0.1", 22},
		{"Octal encoded 127.0.0.1", "0177.0.0.1", 22},
		{"DNS rebinding mixed record", "rebind.example.com", 22},
		{"DNS resolving to RFC1918", "internal.corp.local", 22},
		{"Invalid port 0", "93.184.216.34", 0},
		{"Invalid port 70000", "93.184.216.34", 70000},
	}

	for _, tc := range blockedCases {
		if _, err := g.Check(context.Background(), tc.host, tc.port); err == nil {
			t.Errorf("case %q (%s:%d): expected block, but was allowed", tc.name, tc.host, tc.port)
		}
	}

	addr, err := g.Check(context.Background(), "public.example.com", 22)
	if err != nil {
		t.Fatalf("expected public.example.com to be allowed, got error: %v", err)
	}
	if addr != netip.MustParseAddr("93.184.216.34") {
		t.Fatalf("unexpected resolved addr: %s", addr)
	}
}

func TestGuardAllowlistAndDenylistPrecedence(t *testing.T) {
	g, err := NewGuard(Config{
		Allowlist: []string{"10.10.0.0/16", "127.0.0.1"},
		Denylist:  []string{"10.10.99.0/24", "93.184.216.34"},
	})
	if err != nil {
		t.Fatalf("NewGuard failed: %v", err)
	}

	if _, err := g.Check(context.Background(), "10.10.1.25", 22); err != nil {
		t.Fatalf("expected allowlisted RFC1918 subnet 10.10.1.25 to pass: %v", err)
	}
	if _, err := g.Check(context.Background(), "127.0.0.1", 2222); err != nil {
		t.Fatalf("expected explicitly allowlisted 127.0.0.1 to pass: %v", err)
	}
	if _, err := g.Check(context.Background(), "10.10.99.5", 22); err == nil {
		t.Fatal("expected denylist 10.10.99.0/24 to override allowlist 10.10.0.0/16")
	}
	if _, err := g.Check(context.Background(), "93.184.216.34", 22); err == nil {
		t.Fatal("expected denylisted public IP to be blocked")
	}
}
