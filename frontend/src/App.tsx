import { ChangeEvent, useMemo, useState } from "react";

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

  const rand = Math.random().toString(16).slice(2);
  return `idempo-${Date.now()}-${rand}`;
}

type ApiResult = {
  status: number;
  ok: boolean;
  json: unknown;
};

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

  return {
    status: response.status,
    ok: response.ok,
    json: parsed,
  };
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBase);
  const [rawPayload, setRawPayload] = useState("hello world");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [idempotencyKey, setIdempotencyKey] = useState(() => generateIdempotencyKey());

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

  const paymentChallenge = useMemo(() => {
    if (submitStatus !== 402 || !submitResponse || typeof submitResponse !== "object") {
      return null;
    }

    const json = submitResponse as Record<string, unknown>;

    const options =
      (json.accepts as Array<Record<string, unknown>> | undefined) ||
      (json.acceptedOptions as Array<Record<string, unknown>> | undefined) ||
      [];

    const first = options[0] || {};

    return {
      amount: first.maxAmountRequired || first.amount || "unknown",
      currency: first.asset || first.currency || "unknown",
      network: first.network || "unknown",
      scheme: first.scheme || "unknown",
      raw: json,
    };
  }, [submitResponse, submitStatus]);

  const txHash = useMemo(() => {
    if (!submitResponse || typeof submitResponse !== "object") {
      return "";
    }

    const maybe = (submitResponse as Record<string, unknown>).txHash;
    return typeof maybe === "string" ? maybe : "";
  }, [submitResponse]);

  const explorerLinks = useMemo(() => {
    if (!txHash || submitStatus !== 200) {
      return null;
    }

    return {
      celestia: `https://mocha.celenium.io/tx/${txHash}`,
      solana: `https://explorer.solana.com/tx/${txHash}?cluster=devnet`,
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

  async function onFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await runAction("file-upload", async () => {
      const text = await file.text();
      setRawPayload(text);
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
      const result = await requestJson(`${apiBaseUrl}/v1/blobs`, "POST", blobBody, {
        "idempotency-key": idempotencyKey,
      });

      setSubmitStatus(result.status);
      setSubmitResponse(result.json);
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
        <p>Client for quote, payment challenge handling, blob submit, and idempotent replay testing.</p>
      </header>

      <section className="panel">
        <h2>Config</h2>
        <label>
          API Base URL
          <input
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
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
            onChange={(event) => setRawPayload(event.target.value)}
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
          <input value={namespace} onChange={(event) => setNamespace(event.target.value)} />
        </label>
        <div className="metrics">
          <div>Computed payload byte size: {payloadBytes}</div>
          <div>Computed payload base64 size: {dataBase64.length}</div>
        </div>
      </section>

      <section className="panel">
        <h2>Idempotency Key</h2>
        <label>
          Key
          <input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} />
        </label>
        <button type="button" onClick={() => setIdempotencyKey(generateIdempotencyKey())}>
          Regenerate
        </button>
      </section>

      <section className="panel">
        <h2>Quote</h2>
        <button type="button" onClick={getQuote} disabled={isBusy("quote")}>
          {isBusy("quote") ? "Loading..." : "Get Quote"}
        </button>
        <pre>{quoteResponse ? pretty(quoteResponse) : "No quote fetched yet."}</pre>
      </section>

      <section className="panel">
        <h2>Submit Blob</h2>
        <div className="row">
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            {isBusy("submit") ? "Submitting..." : "Submit Blob"}
          </button>
          <button type="button" onClick={submitBlob} disabled={isBusy("submit")}>
            Re-submit (same key)
          </button>
        </div>

        {submitStatus === 402 && paymentChallenge ? (
          <div className="challenge">
            <h3>Payment Challenge (402)</h3>
            <div>Amount: {String(paymentChallenge.amount)}</div>
            <div>Currency: {String(paymentChallenge.currency)}</div>
            <div>Network: {String(paymentChallenge.network)}</div>
            <div>Scheme: {String(paymentChallenge.scheme)}</div>
          </div>
        ) : null}

        <pre>{submitResponse ? pretty(submitResponse) : "No submission response yet."}</pre>
      </section>

      <section className="panel">
        <h2>Network Info</h2>
        <button type="button" onClick={loadNetworkInfo} disabled={isBusy("network")}>
          {isBusy("network") ? "Loading..." : "Load Network Info"}
        </button>
        <pre>{networkInfo ? pretty(networkInfo) : "No network info loaded."}</pre>
      </section>

      <section className="panel">
        <h2>Poster Status</h2>
        <button type="button" onClick={loadPosterStatus} disabled={isBusy("poster")}>
          {isBusy("poster") ? "Loading..." : "Load Poster Status"}
        </button>
        <pre>{posterInfo ? pretty(posterInfo) : "No poster status loaded."}</pre>
      </section>

      {explorerLinks ? (
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
      ) : null}

      {errorMessage ? (
        <section className="panel error">
          <h2>Error</h2>
          <pre>{errorMessage}</pre>
        </section>
      ) : null}
    </div>
  );
}
