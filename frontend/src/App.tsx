import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

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

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBase);
  const [rawPayload, setRawPayload] = useState("hello world");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateIdempotencyKey());

  const [evmAddress, setEvmAddress] = useState<string | null>(null);

  const [quoteResponse, setQuoteResponse] = useState<unknown>(null);
  const [submitResponse, setSubmitResponse] = useState<unknown>(null);
  const [submitStatus, setSubmitStatus] = useState<number | null>(null);
  const [networkInfo, setNetworkInfo] = useState<unknown>(null);
  const [posterInfo, setPosterInfo] = useState<unknown>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [loadingKey, setLoadingKey] = useState<string>("");

  const dataBase64 = useMemo(() => toBase64FromText(rawPayload), [rawPayload]);
  const payloadBytes = useMemo(() => encoder.encode(rawPayload).byteLength, [rawPayload]);
  const blobBody = useMemo(() => ({ data: dataBase64, namespace }), [dataBase64, namespace]);

  // Sync MetaMask account changes
  useEffect(() => {
    const handler = (accounts: unknown) => {
      const list = accounts as string[];
      setEvmAddress(list.length > 0 ? list[0] : null);
    };
    window.ethereum?.on("accountsChanged", handler);
    return () => window.ethereum?.removeListener("accountsChanged", handler);
  }, []);

  const txHash = useMemo(() => {
    if (!submitResponse || typeof submitResponse !== "object") return "";
    const maybe = (submitResponse as Record<string, unknown>).txHash;
    return typeof maybe === "string" ? maybe : "";
  }, [submitResponse]);

  const explorerLinks = useMemo(() => {
    if (!txHash || submitStatus !== 200) return null;
    return {
      celestia: `https://mocha.celenium.io/tx/${txHash}`,
      base: `https://sepolia.basescan.org/tx/${txHash}`,
    };
  }, [submitStatus, txHash]);

  async function runAction(actionKey: string, fn: () => Promise<void>) {
    setLoadingKey(actionKey);
    setErrorMessage("");
    try {
      await fn();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoadingKey("");
    }
  }

  async function connectMetaMask() {
    await runAction("connect", async () => {
      if (!window.ethereum) throw new Error("MetaMask not detected");
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      setEvmAddress(accounts[0] ?? null);
    });
  }

  async function onFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    await runAction("file-upload", async () => {
      setRawPayload(await file.text());
    });
  }

  async function getQuote() {
    await runAction("quote", async () => {
      const result = await requestJson(`${apiBaseUrl}/v1/quote`, "POST", blobBody, {
        "idempotency-key": idempotencyKey,
      });
      setQuoteResponse(result.json);
    });
  }

  async function submitBlob() {
    await runAction("submit", async () => {
      // Step 1: initial request — expect 402
      const first = await requestJson(`${apiBaseUrl}/v1/blobs`, "POST", blobBody, {
        "idempotency-key": idempotencyKey,
      });

      if (first.status !== 402 || !evmAddress) {
        // No 402 (maybe cached/replayed), or no wallet connected — just show result
        setSubmitStatus(first.status);
        setSubmitResponse(first.json);
        return;
      }

      console.log("[x402] Got 402, evmAddress:", evmAddress);
      console.log("[x402] Response headers:", Object.fromEntries(first.headers.entries()));
      console.log("[x402] Response body:", first.json);

      // Step 2: parse payment requirements
      const signer = {
        address: evmAddress as `0x${string}`,
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
            params: [evmAddress, JSON.stringify({ domain, types, primaryType, message })],
          }) as Promise<`0x${string}`>,
      };

      const paymentClient = new x402Client().register(
        "eip155:*",
        new ExactEvmScheme(toClientEvmSigner(signer)),
      );
      const httpClient = new x402HTTPClient(paymentClient);

      const paymentRequired = httpClient.getPaymentRequiredResponse(
        (name) => first.headers.get(name),
        first.json,
      );

      console.log("[x402] paymentRequired:", paymentRequired);

      // Step 3: sign + build payment payload
      console.log("[x402] calling createPaymentPayload — MetaMask should prompt now");
      let paymentPayload;
      try {
        paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
        console.log("[x402] paymentPayload created:", paymentPayload);
      } catch (err) {
        console.error("[x402] createPaymentPayload FAILED:", err);
        throw err;
      }

      // Step 4: retry with payment
      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload!);
      console.log("[x402] retrying with payment headers:", paymentHeaders);
      const paid = await requestJson(`${apiBaseUrl}/v1/blobs`, "POST", blobBody, {
        "idempotency-key": idempotencyKey,
        ...paymentHeaders,
      });

      setSubmitStatus(paid.status);
      setSubmitResponse(paid.json);
    });
  }

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

  const isBusy = (key: string) => loadingKey === key;

  return (
    <div className="page">
      <header>
        <h1>x402 + Celestia Blob Submission Demo</h1>
        <p>Pay with USDC on Base Sepolia to submit blobs to Celestia Mocha.</p>
      </header>

      <section className="panel">
        <h2>Wallet</h2>
        {evmAddress ? (
          <div>
            <span style={{ color: "#4caf50" }}>✓ MetaMask connected: </span>
            <code>{shortAddr(evmAddress)}</code>
          </div>
        ) : (
          <button type="button" onClick={connectMetaMask} disabled={isBusy("connect")}>
            {isBusy("connect") ? "Connecting…" : "Connect MetaMask"}
          </button>
        )}
        {!window.ethereum && (
          <p style={{ color: "#f44336" }}>MetaMask not detected. Install it to pay on-chain.</p>
        )}
      </section>

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

      <section className="panel">
        <h2>Quote</h2>
        <button type="button" onClick={getQuote} disabled={isBusy("quote")}>
          {isBusy("quote") ? "Loading…" : "Get Quote"}
        </button>
        <pre>{quoteResponse ? pretty(quoteResponse) : "No quote fetched yet."}</pre>
      </section>

      <section className="panel">
        <h2>Submit Blob</h2>
        {!evmAddress && (
          <p style={{ color: "#ff9800" }}>⚠ Connect MetaMask above to enable on-chain payment.</p>
        )}
        <div className="row">
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            {isBusy("submit")
              ? "Submitting…"
              : evmAddress
                ? "Pay + Submit Blob"
                : "Submit Blob (mock/cached only)"}
          </button>
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            Re-submit (same key)
          </button>
        </div>

        {submitStatus !== null && (
          <div style={{ marginTop: 8, color: submitStatus === 200 ? "#4caf50" : "#f44336" }}>
            Status: {submitStatus}
          </div>
        )}

        <pre>{submitResponse ? pretty(submitResponse) : "No submission response yet."}</pre>
      </section>

      <section className="panel">
        <h2>Network Info</h2>
        <button type="button" onClick={loadNetworkInfo} disabled={isBusy("network")}>
          {isBusy("network") ? "Loading…" : "Load Network Info"}
        </button>
        <pre>{networkInfo ? pretty(networkInfo) : "No network info loaded."}</pre>
      </section>

      <section className="panel">
        <h2>Poster Status</h2>
        <button type="button" onClick={loadPosterStatus} disabled={isBusy("poster")}>
          {isBusy("poster") ? "Loading…" : "Load Poster Status"}
        </button>
        <pre>{posterInfo ? pretty(posterInfo) : "No poster status loaded."}</pre>
      </section>

      {explorerLinks && (
        <section className="panel">
          <h2>Explorer Links</h2>
          <ul>
            <li>
              <a href={explorerLinks.celestia} target="_blank" rel="noreferrer">
                Celestia Mocha Tx ↗
              </a>
            </li>
            <li>
              <a href={explorerLinks.base} target="_blank" rel="noreferrer">
                Base Sepolia Payment ↗
              </a>
            </li>
          </ul>
        </section>
      )}

      {errorMessage && (
        <section className="panel error">
          <h2>Error</h2>
          <pre>{errorMessage}</pre>
        </section>
      )}
    </div>
  );
}
