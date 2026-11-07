# Runbook — Kubernetes (`kubernetes/kubectl-client.ts`)

## Rules

- Explicit kubeconfig context only; never assume cluster-admin.
- All args `posixQuote`d, names validated `^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`.
- Secrets never listed/decoded. Errors shown verbatim.

## Commands

- `kubectl config get-contexts` (list)
- `kubectl get pods -A -o json` → PodSummary
- `kubectl get deploy,sts,ds -A` → WorkloadSummary
- `kubectl get events -A --sort-by=.lastTimestamp`
- `kubectl logs <pod> -n <ns> --previous` / `describe`

## Prerequisites

`kubectl` binary on host, kubeconfig for SSH user, cluster reachable.

## Status

Implemented — needs real cluster for Verified.
