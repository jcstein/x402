import { ChangeEvent, useMemo, useState } from "react";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import { address as solanaAddress } from "@solana/kit";

// ─── Window type augmentations ───────────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    phantom?: {
      solana?: PhantomSolana;
    };
    solana?: PhantomSolana;
  }
}

interface PhantomSolana {
  publicKey: { toBase58: () => string };
  isConnected: boolean;
  connect: () => Promise<{ publicKey: { toBase58: () => string } }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: unknown) => Promise<unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const defaultApiBase = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:4021";
const defaultNamespace = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAwn/EaU0x0Q==";
const encoder = new TextEncoder();

function toBase64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function toBase64FromText(text: string): string {
  return toBase64FromBytes(encoder.encode(text));
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `idempo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

type ApiResult = { status: number; ok: boolean; json: unknown; headers: Headers };

async function requestJson(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ApiResult> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = { error: "Response was not JSON" };
  }

  return { status: response.status, ok: response.ok, json: parsed, headers: response.headers };
}

// ─── Wallet signer builders ───────────────────────────────────────────────────

function buildEvmSigner(addr: string) {
  return toClientEvmSigner({
    address: addr as `0x${string}`,
    signTypedData: ({
      domain,
      types,
      primaryType,
      message,
    }: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }) =>
      window.ethereum!.request({
        method: "eth_signTypedData_v4",
        params: [addr, JSON.stringify({ domain, types, primaryType, message })],
      }) as Promise<`0x${string}`>,
  });
}

async function buildSvmSigner(phantom: PhantomSolana, pubkeyBase58: string) {
  // Lazy-import @solana/web3.js for VersionedTransaction bridging
  const { VersionedTransaction, VersionedMessage } = await import("@solana/web3.js");

  const kitSigner = {
    address: solanaAddress(pubkeyBase58),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signTransactions: async (transactions: readonly any[]) => {
      return Promise.all(
        transactions.map(async (tx) => {
          const message = VersionedMessage.deserialize(new Uint8Array(tx.messageBytes));
          const versionedTx = new VersionedTransaction(message);
          const signed = (await phantom.signTransaction(versionedTx)) as {
            signatures: Uint8Array[];
          };
          // Find our slot in the static account keys
          const keys = message.staticAccountKeys.map((k) => k.toBase58());
          const ourIdx = keys.indexOf(pubkeyBase58);
          const sig = ourIdx >= 0 ? signed.signatures[ourIdx] : signed.signatures[0];
          return { [pubkeyBase58]: sig } as Record<string, Uint8Array>;
        }),
      );
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toClientSvmSigner(kitSigner as unknown as Parameters<typeof toClientSvmSigner>[0]);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBase);
  const [rawPayload, setRawPayload] = useState("hello world");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateIdempotencyKey());

  // Wallet
  const [evmAddress, setEvmAddress] = useState<string | null>(null);
  const [svmAddress, setSvmAddress] = useState<string | null>(null);

  // Results
  const [quoteResponse, setQuoteResponse] = useState<unknown>(null);
  const [submitResponse, setSubmitResponse] = useState<unknown>(null);
  const [submitStatus, setSubmitStatus] = useState<number | null>(null);
  const [networkInfo, setNetworkInfo] = useState<unknown>(null);
  const [posterInfo, setPosterInfo] = useState<unknown>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [loadingKey, setLoadingKey] = useState<string>("");
  const [paymentStatus, setPaymentStatus] = useState<string>("");

  const dataBase64 = useMemo(() => toBase64FromText(rawPayload), [rawPayload]);
  const payloadBytes = useMemo(() => encoder.encode(rawPayload).byteLength, [rawPayload]);
  const blobBody = useMemo(() => ({ data: dataBase64, namespace }), [dataBase64, namespace]);

  const txHash = useMemo(() => {
    if (!submitResponse || typeof submitResponse !== "object") return "";
    const maybe = (submitResponse as Record<string, unknown>).txHash;
    return typeof maybe === "string" ? maybe : "";
  }, [submitResponse]);

  const explorerLinks = useMemo(() => {
    if (!txHash || submitStatus !== 200) return null;
    return {
      celestia: `https://mocha.celenium.io/tx/${txHash}`,
      solana: `https://explorer.solana.com/tx/${txHash}?cluster=devnet`,
      base: `https://sepolia.basescan.org/tx/${txHash}`,
    };
  }, [submitStatus, txHash]);

  const isBusy = (key: string) => loadingKey === key;

  async function runAction(actionKey: string, fn: () => Promise<void>) {
    setLoadingKey(actionKey);
    setErrorMessage("");
    setPaymentStatus("");
    try {
      await fn();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoadingKey("");
    }
  }

  // ── Wallet connections ──────────────────────────────────────────────────────

  async function connectMetaMask() {
    await runAction("connect-evm", async () => {
      if (!window.ethereum) throw new Error("MetaMask not found");
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      setEvmAddress(accounts[0]);
    });
  }

  async function connectPhantom() {
    await runAction("connect-svm", async () => {
      const phantom = window.phantom?.solana ?? window.solana;
      if (!phantom) throw new Error("Phantom wallet not found");
      const { publicKey } = await phantom.connect();
      setSvmAddress(publicKey.toBase58());
    });
  }

  // ── File upload ─────────────────────────────────────────────────────────────

  async function onFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await runAction("file-upload", async () => {
      setRawPayload(await file.text());
    });
  }

  // ── Quote ───────────────────────────────────────────────────────────────────

  async function getQuote() {
    await runAction("quote", async () => {
      const result = await requestJson(`${apiBaseUrl}/v1/quote`, "POST", blobBody, {
        "idempotency-key": idempotencyKey,
      });
      setQuoteResponse(result.json);
    });
  }

  // ── Submit + auto-pay ───────────────────────────────────────────────────────

  async function submitBlob() {
    await runAction("submit", async () => {
      const reqHeaders: Record<string, string> = { "idempotency-key": idempotencyKey };
      const result = await requestJson(`${apiBaseUrl}/v1/blobs`, "POST", blobBody, reqHeaders);

      setSubmitStatus(result.status);
      setSubmitResponse(result.json);

      // No wallet → just show the challenge
      if (result.status !== 402 || (!evmAddress && !svmAddress)) return;

      // ── Build x402 HTTP client ──
      const paymentClient = new x402Client();

      if (evmAddress) {
        const signer = buildEvmSigner(evmAddress);
        paymentClient.register("eip155:*", new ExactEvmScheme(signer));
      }

      if (svmAddress) {
        const phantom = window.phantom?.solana ?? window.solana;
        if (phantom) {
          const svmSigner = await buildSvmSigner(phantom, svmAddress);
          paymentClient.register("solana:*", new ExactSvmScheme(svmSigner));
        }
      }

      const httpClient = new x402HTTPClient(paymentClient);

      // Parse payment requirements from the 402 response
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => result.headers.get(name),
        result.json,
      );

      setPaymentStatus("🔏 Signing payment — approve in your wallet...");

      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

      setPaymentStatus("📡 Submitting paid request...");

      const paidResult = await requestJson(`${apiBaseUrl}/v1/blobs`, "POST", blobBody, {
        ...reqHeaders,
        ...paymentHeaders,
      });

      setSubmitStatus(paidResult.status);
      setSubmitResponse(paidResult.json);

      if (paidResult.ok) {
        setPaymentStatus("✅ Payment successful!");
      } else {
        setPaymentStatus(`❌ Payment failed (${paidResult.status})`);
      }
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function loadNetworkInfo() {
    await runAction("network", async () => {
      const result = await requestJson(`${apiBaseUrl}/v1/network-info`, "GET");
      setNetworkInfo(result.json);
    });
  }

  async function loadPosterStatus() {
    await runAction("poster", async () => {
      const result = await requestJson(`${apiBaseUrl}/v1/poster`, "GET");
      setPosterInfo(result.json);
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <header>
        <h1>x402 + Celestia Blob Submission Demo</h1>
        <p>Pay with USDC (Base Sepolia or Solana Devnet) to post blobs to Celestia Mocha.</p>
      </header>

      {/* ── Wallet ── */}
      <section className="panel">
        <h2>Wallet</h2>
        <div className="row">
          <button type="button" onClick={connectMetaMask} disabled={isBusy("connect-evm")}>
            {evmAddress
              ? `✅ MetaMask: ${evmAddress.slice(0, 6)}…${evmAddress.slice(-4)}`
              : isBusy("connect-evm")
                ? "Connecting…"
                : "Connect MetaMask (EVM)"}
          </button>
          <button type="button" onClick={connectPhantom} disabled={isBusy("connect-svm")}>
            {svmAddress
              ? `✅ Phantom: ${svmAddress.slice(0, 6)}…${svmAddress.slice(-4)}`
              : isBusy("connect-svm")
                ? "Connecting…"
                : "Connect Phantom (Solana)"}
          </button>
        </div>
        {!evmAddress && !svmAddress && (
          <p style={{ color: "#888", fontSize: "0.85em" }}>
            Connect a wallet to auto-pay on 402. Without a wallet, the challenge is shown for inspection.
          </p>
        )}
      </section>

      {/* ── Config ── */}
      <section className="panel">
        <h2>Config</h2>
        <label>
          API Base URL
          <input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:4021"
          />
        </label>
      </section>

      {/* ── Blob Input ── */}
      <section className="panel">
        <h2>Blob Input</h2>
        <label>
          Raw Payload
          <textarea
            value={rawPayload}
            onChange={(e) => setRawPayload(e.target.value)}
            rows={8}
            placeholder="Type text payload"
          />
        </label>
        <label>
          Upload File
          <input type="file" onChange={onFileUpload} />
        </label>
        <label>
          Namespace (base64)
          <input value={namespace} onChange={(e) => setNamespace(e.target.value)} />
        </label>
        <div className="metrics">
          <div>Payload bytes: {payloadBytes}</div>
          <div>Base64 size: {dataBase64.length}</div>
        </div>
      </section>

      {/* ── Idempotency Key ── */}
      <section className="panel">
        <h2>Idempotency Key</h2>
        <label>
          Key
          <input
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
          />
        </label>
        <button type="button" onClick={() => setIdempotencyKey(generateIdempotencyKey())}>
          Regenerate
        </button>
      </section>

      {/* ── Quote ── */}
      <section className="panel">
        <h2>Quote</h2>
        <button type="button" onClick={getQuote} disabled={isBusy("quote")}>
          {isBusy("quote") ? "Loading…" : "Get Quote"}
        </button>
        <pre>{quoteResponse ? pretty(quoteResponse) : "No quote fetched yet."}</pre>
      </section>

      {/* ── Submit ── */}
      <section className="panel">
        <h2>Submit Blob</h2>
        <div className="row">
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            {isBusy("submit") ? "Submitting…" : "Submit Blob"}
          </button>
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            Re-submit (same key)
          </button>
        </div>

        {paymentStatus && (
          <div style={{ marginTop: "0.5rem", fontWeight: 500 }}>{paymentStatus}</div>
        )}

        {submitStatus === 402 && !evmAddress && !svmAddress && (
          <div className="challenge">
            <h3>Payment Challenge (402)</h3>
            <p>Connect MetaMask or Phantom above to auto-pay.</p>
          </div>
        )}

        <pre>{submitResponse ? pretty(submitResponse) : "No submission response yet."}</pre>
      </section>

      {/* ── Network Info ── */}
      <section className="panel">
        <h2>Network Info</h2>
        <button type="button" onClick={loadNetworkInfo} disabled={isBusy("network")}>
          {isBusy("network") ? "Loading…" : "Load Network Info"}
        </button>
        <pre>{networkInfo ? pretty(networkInfo) : "No network info loaded."}</pre>
      </section>

      {/* ── Poster Status ── */}
      <section className="panel">
        <h2>Poster Status</h2>
        <button type="button" onClick={loadPosterStatus} disabled={isBusy("poster")}>
          {isBusy("poster") ? "Loading…" : "Load Poster Status"}
        </button>
        <pre>{posterInfo ? pretty(posterInfo) : "No poster status loaded."}</pre>
      </section>

      {/* ── Explorer Links ── */}
      {explorerLinks && (
        <section className="panel">
          <h2>Explorer Links</h2>
          <ul>
            <li>
              <a href={explorerLinks.celestia} target="_blank" rel="noreferrer">
                Celestia Mocha Tx
              </a>
            </li>
            <li>
              <a href={explorerLinks.solana} target="_blank" rel="noreferrer">
                Solana Devnet Tx
              </a>
            </li>
            <li>
              <a href={explorerLinks.base} target="_blank" rel="noreferrer">
                Base Sepolia Tx
              </a>
            </li>
          </ul>
        </section>
      )}

      {/* ── Error ── */}
      {errorMessage && (
        <section className="panel error">
          <h2>Error</h2>
          <pre>{errorMessage}</pre>
        </section>
      )}
    </div>
  );
}
