package main

import "github.com/webssh-studio/gateway/internal/protocol"

// hopCredentials is what one ProxyJump hop authenticates with.
type hopCredentials struct {
	AuthMethod           string
	Password             string
	PublicKey            string
	PrivateKeyPem        string
	PrivateKeyPassphrase string
	KeyFingerprint       string
	// Inherited marks credentials copied from the target.
	Inherited bool
}

// resolveHopCredentials picks a hop's credentials. A hop that sets any
// credential field uses only its own, so a wrong hop password can never fall
// back to the target's; a hop that sets none inherits the target's. A
// passphrase alone unlocks nothing and does not count.
func resolveHopCredentials(hop protocol.JumpHop, target protocol.ControlMessage) hopCredentials {
	if hop.AuthMethod != "" || hop.Password != "" || hop.PublicKey != "" || hop.PrivateKeyPem != "" || hop.KeyFingerprint != "" {
		return hopCredentials{
			AuthMethod:           hop.AuthMethod,
			Password:             hop.Password,
			PublicKey:            hop.PublicKey,
			PrivateKeyPem:        hop.PrivateKeyPem,
			PrivateKeyPassphrase: hop.PrivateKeyPassphrase,
			KeyFingerprint:       hop.KeyFingerprint,
		}
	}
	return hopCredentials{
		AuthMethod:           target.AuthMethod,
		Password:             target.Password,
		PublicKey:            target.PublicKey,
		PrivateKeyPem:        target.PrivateKeyPem,
		PrivateKeyPassphrase: target.PrivateKeyPassphrase,
		KeyFingerprint:       target.KeyFingerprint,
		Inherited:            true,
	}
}
