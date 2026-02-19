# x402

Pay for [Celestia](https://celestia.org) blobs on **Mocha testnet** using stablecoins on **Solana** and **Base** testnet.

The name comes from [HTTP 402: Payment Required](https://http.cat/status/402) — the status code that was always meant for micropayments on the web, and now it's finally getting its moment.

[![402 Payment Required](https://http.cat/images/402.jpg)](https://http.cat/status/402)

> Source: https://http.cat/status/402

## What is it?

x402 lets you use stablecoins (USDC, etc.) on Solana and Base testnet to pay for blob data posted to Celestia's mocha testnet. No native TIA required for testing — just stablecoins you already have on EVM or Solana.

## Networks

| Role | Network |
|------|---------|
| Payment | Solana testnet, Base Sepolia |
| Data availability | Celestia mocha testnet |

## Base Sepolia Test

First successful end-to-end test — EVM payment on Base Sepolia → blob posted to Celestia Mocha:

```
PAYER_EVM_PRIVATE_KEY=$PRIVATE_KEY npm run test:payment:evm
```

**What happened:**
- 🔵 Paid $0.01 USDC on **Base Sepolia** (EIP-155 / chain 84532)
- 📦 Blob submitted to **Celestia Mocha** (22 bytes, height 10149010)
- ✅ Settlement confirmed on Base Sepolia
- 🔁 Replay check returned cached response — **no double charge**

**Explorer links:**
- [Celestia tx on Celenium](https://mocha.celenium.io/tx/4bcb2e74e891539c10e1743302c1086ff091f66a0062e585d73277917F41BE20?tab=messages)
- [Base Sepolia payment on Blockscout](https://base-sepolia.blockscout.com/address/0xcaAAe7A6a221Ce83C698d82F4708a64E5426FBc9?tab=token_transfers)

**Unfunded wallet — fails with 402 (no charge):**

```
PAYER_EVM_PRIVATE_KEY=$UNFUNDED_PRIVATE_KEY npm run test:payment:evm
```

```
Initial challenge received: { ... }
Paid request failed with 402. Body: {}
```

The server returns HTTP 402 and settlement never executes — so the blob is never posted and you're never charged.

---

## Solana Devnet Test

Solana payment on Solana devnet → blob posted to Celestia Mocha:

```bash
export PAYER_SVM_PRIVATE_KEY="$(tr -d '\n' < ~/.x402-keys/solana-devnet.json)"
npm run test:payment:svm
```

**What happened:**
- 🟣 Paid $0.01 USDC on **Solana devnet** (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)
- 📦 Blob submitted to **Celestia Mocha** (26 bytes, height 10149397)
- ✅ Settlement confirmed on Solana devnet
- 🔁 Replay check returned cached response — **no double charge**

**Explorer links:**
- [Celestia tx on Celenium](https://mocha.celenium.io/tx/a1acf11d074308218b954bd460b8ebba26f2a6bfd55fe5153cf1e10fa70d0c4d?tab=messages)
- [Solana devnet payment on Solana Explorer](https://explorer.solana.com/tx/jhkvSga5ARnw7jNAURJ25DiFZTCm7YxqMuLyVgGazUhQdULXJPw9ZfGMCwxUjqZLhpkQBiVV9wphRfBSZVmte1S?cluster=devnet)
- [Payer address on Orb Markets](https://orbmarkets.io/address/AToF9t2XxnQV7PjUtApmLwdGzhH7U8PGB7JzafF8BaHq?cluster=devnet&hideSpam=true)

<details>
<summary>Full test output</summary>

```json
Initial challenge received:
{
  "idempotencyKey": "payflow-svm-1771493768676-782010",
  "acceptedOptions": [
    {
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0xcaAAe7A6a221Ce83C698d82F4708a64E5426FBc9"
    },
    {
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "amount": "10000",
      "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "payTo": "AToF9t2XxnQV7PjUtApmLwdGzhH7U8PGB7JzafF8BaHq"
    }
  ]
}

Paid request succeeded:
{
  "status": 200,
  "body": {
    "status": "submitted",
    "txHash": "A1ACF11D074308218B954BD460B8EBBA26F2A6BFD55FE5153CF1E10FA70D0C4D",
    "height": 10149397,
    "quote": {
      "payloadBytes": 26,
      "chargedUsd": 0.01,
      "chargedPriceString": "$0.0100"
    },
    "idempotency": { "replayed": false, "status": "completed" }
  },
  "settlement": {
    "success": true,
    "transaction": "jhkvSga5ARnw7jNAURJ25DiFZTCm7YxqMuLyVgGazUhQdULXJPw9ZfGMCwxUjqZLhpkQBiVV9wphRfBSZVmte1S",
    "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "payer": "AToF9t2XxnQV7PjUtApmLwdGzhH7U8PGB7JzafF8BaHq"
  }
}

Replay check (should be cached response / no re-charge):
{
  "status": 200,
  "body": {
    "idempotency": { "replayed": true, "status": "completed" }
  }
}
```

</details>

---

<details>
<summary>Full EVM test output</summary>

```json
Initial challenge received:
{
  "idempotencyKey": "payflow-1771492498574-509346",
  "acceptedOptions": [
    {
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0xcaAAe7A6a221Ce83C698d82F4708a64E5426FBc9"
    },
    {
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "amount": "10000",
      "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "payTo": "AToF9t2XxnQV7PjUtApmLwdGzhH7U8PGB7JzafF8BaHq"
    }
  ],
  "selectedNetwork": "eip155:84532"
}

Paid request succeeded:
{
  "status": 200,
  "body": {
    "status": "submitted",
    "txHash": "C5B2FD344F582C91BD824394C428A301AABFD1C9C66DDACAAC345599676AC99A",
    "height": 10149192,
    "quote": {
      "payloadBytes": 22,
      "chargedUsd": 0.01,
      "chargedPriceString": "$0.0100"
    },
    "idempotency": { "replayed": false, "status": "completed" }
  },
  "settlement": {
    "success": true,
    "transaction": "0x4aa8c788c3e2aa700f4086f389469886d6edf9dd4cf128615e17a0c07560bf7d",
    "network": "eip155:84532",
    "payer": "0xcE5181a17319C89eC3CC9100968fba3c2c53DF82"
  }
}

Replay check (should be cached response / no re-charge):
{
  "status": 200,
  "body": {
    "idempotency": { "replayed": true, "status": "completed" }
  }
}
```

</details>

## License

Apache 2.0
