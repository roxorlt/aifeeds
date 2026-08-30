# Operations artifacts

This directory contains immutable, reviewable inputs and runbooks for exceptional operations.
Artifacts are generated from read-only evidence and must never be treated as authorization to mutate
production. Each operation keeps its own dated directory and explicit activation/rollback gates.

- [`2026-08-30-publication-inventory/`](./2026-08-30-publication-inventory/README.md) seals the first
  append-only publication inventory and documents the authenticated, bounded, idempotent activation
  route. Its archived command is intentionally non-executable until an exact authoritative old budget
  snapshot is captured and independently reviewed.
