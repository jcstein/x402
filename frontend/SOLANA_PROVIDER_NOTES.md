# Solana Provider Notes (MetaMask vs Brave)

Date: 2026-02-20

## What was attempted
- Added browser Solana signing via `@x402/svm` in `frontend/src/App.tsx`.
- Bridged injected wallet `signTransaction(...)` into `toClientSvmSigner(...)`.
- Added a connect button intended for MetaMask Solana.

## What went wrong in practice
- In Brave, injected Solana providers can resolve to Brave Wallet first.
- Provider selection/fallback behavior caused Solana flow changes to interfere with the previously working EVM path.

## Current decision
- Reverted frontend to the known-good EVM-only flow to keep Base Sepolia payments stable.
- Kept system dark mode support in CSS.

## Safer next approach for Solana re-introduction
- Isolate Solana into a separate code path/component and feature flag.
- Require explicit provider identity before connect/sign (no implicit fallback).
- Add runtime diagnostics panel for detected providers and chosen signer.
- Validate EVM regression tests before merging any Solana wallet changes.
