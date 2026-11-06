package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/crypto/ssh"
)

const (
	maxEnvVars       = 32
	maxEnvValueBytes = 4096
)

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// validateEnv checks the connect env before anything is dialled. Errors name
// the variable, never its value.
func validateEnv(env map[string]string) error {
	if len(env) > maxEnvVars {
		return fmt.Errorf("%d environment variables exceed the limit of %d", len(env), maxEnvVars)
	}
	for _, name := range sortedEnvNames(env) {
		value := env[name]
		switch {
		case !envNamePattern.MatchString(name):
			return fmt.Errorf("environment variable %q has an invalid name", name)
		case len(value) > maxEnvValueBytes:
			return fmt.Errorf("environment variable %q exceeds %d bytes", name, maxEnvValueBytes)
		case strings.ContainsRune(value, 0):
			return fmt.Errorf("environment variable %q contains a NUL byte", name)
		}
	}
	return nil
}

func sortedEnvNames(env map[string]string) []string {
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// applyEnv sends one want-reply env request per variable, in name order, and
// reports which the server took. A refusal is reported, never worked around
// with an export typed into the shell.
func applyEnv(sess *ssh.Session, env map[string]string) (accepted, rejected []string) {
	for _, name := range sortedEnvNames(env) {
		if err := sess.Setenv(name, env[name]); err != nil {
			rejected = append(rejected, name)
		} else {
			accepted = append(accepted, name)
		}
	}
	return accepted, rejected
}
