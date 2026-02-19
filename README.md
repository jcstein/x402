# x402 -> Celestia Blob Demo (Scaffold)

Pay for [Celestia](https://celestia.org) blobs on **Mocha testnet** using stablecoins on **Solana** and **Base** testnet.

The name comes from [HTTP 402: Payment Required](https://http.cat/status/402), the status code made for this flow.

[![402 Payment Required](https://http.cat/images/402.jpg)](https://http.cat/status/402)

> Source: https://http.cat/status/402

Prototype API that charges via `x402` before submitting blob data to Celestia Mocha.

## TL;DR

- Run `npm install && cp .env.example .env && npm run dev`.
- Pay with x402 on Base Sepolia or Solana Devnet, then submit blobs to Celestia Mocha.
- Main endpoint: `POST /v1/blobs` (returns `402` challenge first, then succeeds after payment).
- Idempotency is built in via `Idempotency-Key` (safe retries, no double-charge replay).
- Failed Celestia submits return `4xx/5xx`, so settlement does not execute.

## Frontend Demo

React + Vite + TypeScript single-page demo lives in `frontend/`.

### Prerequisites

- Node.js 18+ and npm
- Backend server running locally (default `http://127.0.0.1:4021`)

### Quick start

```bash
npm run frontend:install && npm run frontend:dev
```

<!-- screenshot -->

### UI panels

- **Config bar**: set API base URL (`VITE_API_BASE_URL` fallback `http://127.0.0.1:4021`)
- **Blob Input**: raw text payload, file upload, namespace, live byte/base64 sizing
- **Idempotency Key**: auto-generated UUID, editable input, regenerate button
- **Quote**: calls `POST /v1/quote`, displays raw JSON quote response
- **Submit Blob**: calls `POST /v1/blobs`, shows 402 challenge details or submit success/error, includes replay button
- **Network Info**: calls `GET /v1/network-info` and shows JSON response
- **Poster Status**: calls `GET /v1/poster` and shows JSON response
- **Explorer Links**: shown after successful submit (`txHash`) for Celestia Mocha, Solana Devnet, and Base Sepolia

## Table of Contents

- [What This Scaffold Includes](#what-this-scaffold-includes)
- [Quick Start](#quick-start)
- [Pricing Model (Current)](#pricing-model-current)
- [Payload Size Notes](#payload-size-notes)
- [Celestia Poster Flow (Go Mode)](#celestia-poster-flow-go-mode)
- [API Usage](#api-usage)
- [End-to-End Payment Tests (EVM + SVM)](#end-to-end-payment-tests-evm--svm)
- [Validated Test Runs (2026-02-19)](#validated-test-runs-2026-02-19)
- [Env Knobs You'll Likely Tune](#env-knobs-youll-likely-tune)
- [Current Assumptions](#current-assumptions)

## What This Scaffold Includes

- `POST /v1/blobs` paid endpoint (x402 middleware)
- `POST /v1/quote` free endpoint to preview price from payload size
- `GET /v1/network-info` free endpoint to inspect live Celenium constants
- `GET /v1/poster` free endpoint to inspect the Celestia poster account/balance in `rpc` or `go` mode
- Idempotency support with `Idempotency-Key` (replay-safe and duplicate-charge-safe)
- Refund safety by design:
  - if blob submission fails, endpoint returns a `4xx/5xx` status
  - x402 settlement is only executed on successful (`<400`) responses
  - failed submissions are not settled, so no transfer-refund transaction is required
- Celestia submit adapters:
  - `mock` mode (default)
  - `rpc` mode via `state.SubmitPayForBlob` on celestia-node HTTP RPC
  - `go` mode via local `api/client` runner (recommended for QuickNode DA endpoint usage)
- Facilitator sync retry:
  - server starts immediately
  - x402 facilitator support sync runs in background with retry
  - paid requests return a short “payment backend not ready” error until sync succeeds

## Quick Start

1. Install deps:

```bash
npm install
```

2. Configure env:

```bash
cp .env.example .env
```

3. Start:

```bash
npm run dev
```

If you want to run locally without a live Celestia endpoint, set:

```bash
CELESTIA_SUBMIT_MODE=mock npm run dev
```

## Pricing Model (Current)

`charged_usd = max(min_usd, estimated_mainnet_usd * (1 + markup_bps/10000) + fixed_usd)`

Where:
- `estimated_mainnet_usd` comes from:
  - Celenium mainnet `estimate_for_pfb` gas
  - Celenium mainnet median gas price
  - TIA/USD from CoinGecko (fallback env value if unavailable)

### Live values sampled on 2026-02-19

- Mainnet gas price median: `0.004000`
- Mocha gas price median: `0.005481`
- `estimate_for_pfb` (bytes -> gas):
  - `1024 -> 87988`
  - `65536 -> 632756`
  - `1048576 -> 8988596`
  - `8388608 -> 71362484`

With a 25% markup and current TIA/USD, the 8 MiB quote is still relatively small, so you may want higher markup/fixed fee for abuse resistance.

## Payload Size Notes

This demo default is `MAX_PAYLOAD_BYTES=8192000` (~7.81 MiB practical ceiling).

Relevant references:
- Celestia docs: max blob tx size is 8 MiB.
- Celenium consensus constants endpoint currently reports:
  - mainnet `block_max_bytes = 33554432`
  - mocha `block_max_bytes = 134217728`

In practice, transaction overhead means the full `8,388,608` payload can be rejected with `tx too large` on Mocha, so this scaffold defaults slightly lower.

The endpoint `GET /v1/network-info` returns these values live.

## Celestia Poster Flow (Go Mode)

`CELESTIA_SUBMIT_MODE=go` uses a local Go command in this repo:
- command default: `go run ./go/cmd/celestia-poster`
- keyring auto-creates the poster key (if missing)
- poster key lives at `CELESTIA_GO_KEYRING_DIR` (default `./.celestia-poster-keys`)
- service submits all blobs with that signer

Important envs:
- `CELESTIA_GO_DA_URL` (QuickNode Mocha DA URL)
- `CELESTIA_GO_CORE_GRPC_ADDR` (optional; defaults to `<da-host>:9090`)
- `CELESTIA_GO_CORE_AUTH_TOKEN` (optional; defaults to DA token)
- `CELESTIA_TX_KEY_NAME` or `CELESTIA_GO_KEY_NAME` (poster key name)

For most QuickNode setups, only `CELESTIA_GO_DA_URL` is required.

## API Usage

### 1) Preview quote

```bash
curl -sS http://localhost:4021/v1/quote \
  -H 'content-type: application/json' \
  -d '{"data":"aGVsbG8gd29ybGQ="}'
```

### 2) Check poster account

```bash
curl -sS http://localhost:4021/v1/poster
```

### 3) Paid submit

Use a stable `Idempotency-Key` for retries:

```bash
curl -i http://localhost:4021/v1/blobs \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-001' \
  -d '{"data":"aGVsbG8gd29ybGQ="}'
```

First request returns `402 Payment Required` with x402 requirements.
Client then pays and retries the same request.

## End-to-End Payment Tests (EVM + SVM)

Use the built-in test harness to exercise the full x402 flow:
- initial `402` challenge
- signed payment retry
- successful submit
- idempotent replay without duplicate charging

### EVM (Base Sepolia)

### Prerequisites

- Server running (default `http://127.0.0.1:4021`)
- Payer wallet private key funded with Base Sepolia USDC
- `.env` configured with your recipient addresses (`X402_EVM_PAY_TO`, `X402_SVM_PAY_TO`)

### Run

```bash
PAYER_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY \
npm run test:payment:evm
```

Optional overrides:
- `TEST_BLOB_ENDPOINT` (default `http://127.0.0.1:4021/v1/blobs`)
- `TEST_DATA_B64`
- `TEST_PAYLOAD_BYTES` (generates payload automatically, e.g. `2097152` for 2 MiB)
- `TEST_NAMESPACE_ID_B64`
- `TEST_IDEMPOTENCY_KEY`

### SVM (Solana Devnet)

```bash
PAYER_SVM_PRIVATE_KEY=YOUR_SOLANA_PRIVATE_KEY \
npm run test:payment:svm
```

Prerequisites:
- payer wallet has Solana Devnet USDC
- payer wallet also has some Devnet SOL for tx fees / ATA creation

Private key formats accepted:
- base58-encoded secret key
- JSON array of key bytes (like Solana CLI `id.json`)
- hex string (`0x...`)

Optional:
- `SVM_RPC_URL` to override RPC used when building the client-side Solana payment transaction
- `TEST_PAYLOAD_BYTES` (e.g. `2097152` for 2 MiB)

## Validated Test Runs (2026-02-19)

All tests below were run against:
- x402 server on `http://127.0.0.1:4021`
- Base Sepolia + Solana Devnet payment rails
- Celestia Mocha in `CELESTIA_SUBMIT_MODE=go`

### A) Funding / failure safety

- Poster unfunded case: submit attempt fails at Celestia stage and API returns `4xx/5xx`.
- Settlement safety: no x402 settlement occurs for failed submits (no charge).
- This is the implemented "refund on revert" behavior for this prototype.

### B) Successful paid submit flow (SVM)

Command pattern:

```bash
export PAYER_SVM_PRIVATE_KEY="$(tr -d '\n' < ~/.x402-keys/solana-devnet.json)"
TEST_PAYLOAD_BYTES=<size_bytes> npm run test:payment:svm
```

Observed successful runs:
- `2,097,152` bytes (2 MiB): submit success, settlement success, replay cached (`replayed: true`) with no re-charge.
- `3,145,728` bytes (3 MiB): submit success, settlement success, replay cached with no re-charge.
- `8,192,000` bytes (~7.81 MiB): submit success, settlement success, replay cached with no re-charge.

Example successful Celestia tx hashes from these runs:
- `397D14052FAA5346619EF178C4A57DF0D60AF8E41965FAA8190AAE09EA9790B5` (2 MiB)
- `5045D20F339C1B2B10947179A479D09ECFDED1AF2CF0E8A7A12A696300830DB1` (3 MiB)
- `D01E1241E0137A5F5765BA3D08B17408BB84643EF9DF35A3E05FA13D7B244A74` (~7.81 MiB)

Explorer links (verified examples):
- 2 MiB (SVM):
  - Celestia: [397D14.. on Celenium](https://mocha.celenium.io/tx/397D14052FAA5346619EF178C4A57DF0D60AF8E41965FAA8190AAE09EA9790B5?tab=messages)
  - Solana payment: [3HK1Uq.. on Solana Explorer](https://explorer.solana.com/tx/3HK1UqwvgjrNn9178x2tFe8qwUf2uRCH3SENJcwn48b5mCuReoXw7UJgXAZGGoAriyStsYCmcux3fkchAspCZKVP?cluster=devnet)
- 3 MiB (SVM):
  - Celestia: [5045D2.. on Celenium](https://mocha.celenium.io/tx/5045D20F339C1B2B10947179A479D09ECFDED1AF2CF0E8A7A12A696300830DB1?tab=messages)
  - Solana payment: [2VzoXi.. on Solana Explorer](https://explorer.solana.com/tx/2VzoXirkBd37KjVurBZo4pYRN8Qrtd1cuc4EpiBLGrGX623sHZ3gktSxBR81bT82aYdfZz9kMwg3P7G1SB7Nwkij?cluster=devnet)
- 8,192,000 bytes (SVM):
  - Celestia: [D01E12.. on Celenium](https://mocha.celenium.io/tx/D01E1241E0137A5F5765BA3D08B17408BB84643EF9DF35A3E05FA13D7B244A74?tab=messages)
  - Solana payment: [3JYaWp.. on Solana Explorer](https://explorer.solana.com/tx/3JYaWpKpXbB4qz1yVXc7RxWAxfyicGvBsp7Bj64mwa7StnVKf6z4Nipby8pTrGeVzT789iw4ShQqnDpjHfyHKrpo?cluster=devnet)
- 2 MiB (EVM):
  - Celestia: [306d9c.. on Celenium](https://mocha.celenium.io/tx/306d9c7229c8bfb75f655f704b4f7338f2c8a78ada66c87028e76f2723b4488c?tab=messages)
  - Base Sepolia payment: [0x144c85.. on Blockscout](https://base-sepolia.blockscout.com/tx/0x144c859318910641212e7dc711cf5acdf04f5e3d2c716d7f3b40b0e722a2bfdb)

### C) Detailed command/output snippets

#### 3 MiB SVM paid flow

```bash
export PAYER_SVM_PRIVATE_KEY="$(tr -d '\n' < ~/.x402-keys/solana-devnet.json)"
TEST_PAYLOAD_BYTES=3145728 npm run test:payment:svm
```

```json
Initial challenge received:
{
  "idempotencyKey": "payflow-svm-1771496698264-860192",
  "acceptedOptions": [
    { "network": "eip155:84532", "amount": "43400" },
    { "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "amount": "43400" }
  ]
}

Paid request succeeded:
{
  "status": 200,
  "body": {
    "status": "submitted",
    "payloadBytes": 3145728,
    "txHash": "5045D20F339C1B2B10947179A479D09ECFDED1AF2CF0E8A7A12A696300830DB1",
    "height": 10149866,
    "idempotency": { "replayed": false, "status": "completed" }
  },
  "settlement": {
    "success": true,
    "transaction": "2VzoXirkBd37KjVurBZo4pYRN8Qrtd1cuc4EpiBLGrGX623sHZ3gktSxBR81bT82aYdfZz9kMwg3P7G1SB7Nwkij",
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
  }
}

Replay check:
{
  "status": 200,
  "body": { "idempotency": { "replayed": true, "status": "completed" } }
}
```

#### 8,192,000-byte SVM paid flow

```bash
export PAYER_SVM_PRIVATE_KEY="$(tr -d '\n' < ~/.x402-keys/solana-devnet.json)"
TEST_PAYLOAD_BYTES=8192000 npm run test:payment:svm
```

```json
Initial challenge received:
{
  "idempotencyKey": "payflow-svm-1771496718261-952712",
  "acceptedOptions": [
    { "network": "eip155:84532", "amount": "112700" },
    { "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "amount": "112700" }
  ]
}

Paid request succeeded:
{
  "status": 200,
  "body": {
    "status": "submitted",
    "payloadBytes": 8192000,
    "txHash": "D01E1241E0137A5F5765BA3D08B17408BB84643EF9DF35A3E05FA13D7B244A74",
    "height": 10149869,
    "idempotency": { "replayed": false, "status": "completed" }
  },
  "settlement": {
    "success": true,
    "transaction": "3JYaWpKpXbB4qz1yVXc7RxWAxfyicGvBsp7Bj64mwa7StnVKf6z4Nipby8pTrGeVzT789iw4ShQqnDpjHfyHKrpo",
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
  }
}
```

#### 2 MiB EVM paid flow

```bash
PAYER_EVM_PRIVATE_KEY=0xYOUR_PRIVATE_KEY TEST_PAYLOAD_BYTES=2097152 npm run test:payment:evm
```

```json
Initial challenge received:
{
  "acceptedOptions": [
    { "network": "eip155:84532", "amount": "29000" },
    { "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "amount": "29000" }
  ],
  "selectedNetwork": "eip155:84532"
}

Paid request succeeded:
{
  "status": 200,
  "body": {
    "status": "submitted",
    "payloadBytes": 2097152,
    "txHash": "306D9C7229C8BFB75F655F704B4F7338F2C8A78ADA66C87028E76F2723B4488C",
    "idempotency": { "replayed": false, "status": "completed" }
  },
  "settlement": {
    "success": true,
    "transaction": "0x144c859318910641212e7dc711cf5acdf04f5e3d2c716d7f3b40b0e722a2bfdb",
    "network": "eip155:84532"
  }
}
```

### D) Edge cases validated/fixed

- Dynamic quote mismatch under retries:
  - Symptom: second leg returned `402 No matching payment requirements` on larger payloads.
  - Fix: quote snapshot is reused per idempotency key.
- JSON request size limit:
  - Symptom: Express returned `413 PayloadTooLargeError` before x402 challenge for larger base64 JSON bodies.
  - Fix: body limit now accounts for base64 expansion overhead.
- Practical max payload:
  - Full `8,388,608` byte data can hit Celestia tx-size constraints (`code 21`), depending on overhead.
  - Default is set to `8,192,000` bytes for reliable behavior in this setup.

## Env Knobs You'll Likely Tune

- Payment rails:
  - `X402_EVM_NETWORK` (default `eip155:84532`, Base Sepolia)
  - `X402_SVM_NETWORK` (default Solana Devnet)
- Recipient addresses:
  - `X402_EVM_PAY_TO`
  - `X402_SVM_PAY_TO`
- Pricing:
  - `PRICING_MARKUP_BPS`
  - `PRICING_FIXED_USD`
  - `PRICING_MIN_USD`
- Celestia submit:
  - `CELESTIA_SUBMIT_MODE=mock|rpc|go`
  - `CELESTIA_TX_KEY_NAME`
  - `CELESTIA_SIGNER_ADDRESS`
  - `CELESTIA_GO_DA_URL`
  - `CELESTIA_GO_CORE_GRPC_ADDR`
  - `CELESTIA_GO_CORE_AUTH_TOKEN`
  - `CELESTIA_GO_KEYRING_DIR`
  - `CELESTIA_GO_POSTER_CMD_JSON`

## Current Assumptions

- EVM testnet uses Base Sepolia (`eip155:84532`).
- Solana uses Devnet.
- Celestia target is Mocha.
- “Refund on revert” is handled by preventing settlement on failed submits (`4xx/5xx`).

If you want a post-settlement refund wallet flow too, add a separate refund worker that reads settlement headers and sends explicit token refunds.
