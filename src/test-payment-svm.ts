import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSvmScheme, toClientSvmSigner } from "@x402/svm";
import { base58 } from "@scure/base";
import {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
} from "@solana/kit";

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const getString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

const headersToObject = (headers: Headers): Record<string, string> => {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
};

const getPayloadDataB64 = (): string => {
  const explicitPayloadB64 = process.env.TEST_DATA_B64?.trim();
  if (explicitPayloadB64) {
    return explicitPayloadB64;
  }

  const payloadBytesRaw = process.env.TEST_PAYLOAD_BYTES?.trim();
  if (!payloadBytesRaw) {
    return Buffer.from("x402 svm payment flow test").toString("base64");
  }

  const payloadBytes = Number.parseInt(payloadBytesRaw, 10);
  if (!Number.isInteger(payloadBytes) || payloadBytes <= 0) {
    throw new Error("TEST_PAYLOAD_BYTES must be a positive integer");
  }

  return Buffer.alloc(payloadBytes, 0x78).toString("base64");
};

const parseNumberArray = (raw: string): Uint8Array | undefined => {
  if (!raw.trim().startsWith("[")) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "number")) {
    throw new Error("SVM private key JSON format must be an array of numbers");
  }

  return Uint8Array.from(parsed as number[]);
};

const parseHexBytes = (raw: string): Uint8Array | undefined => {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]+$/u.test(hex)) {
    return undefined;
  }
  if (hex.length % 2 !== 0) {
    throw new Error("SVM private key hex must have even length");
  }

  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const parseSvmPrivateKeyBytes = (raw: string): Uint8Array => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("PAYER_SVM_PRIVATE_KEY is required");
  }

  const fromArray = parseNumberArray(trimmed);
  if (fromArray) {
    return fromArray;
  }

  const fromHex = parseHexBytes(trimmed);
  if (fromHex) {
    return fromHex;
  }

  return base58.decode(trimmed);
};

const main = async (): Promise<void> => {
  const endpoint = process.env.TEST_BLOB_ENDPOINT ?? "http://127.0.0.1:4021/v1/blobs";
  const payloadDataB64 = getPayloadDataB64();
  const namespaceIdB64 = process.env.TEST_NAMESPACE_ID_B64;
  const idempotencyKey =
    process.env.TEST_IDEMPOTENCY_KEY ?? `payflow-svm-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  const privateKeyBytes = parseSvmPrivateKeyBytes(process.env.PAYER_SVM_PRIVATE_KEY ?? "");
  const keySigner =
    privateKeyBytes.length === 64
      ? await createKeyPairSignerFromBytes(privateKeyBytes)
      : privateKeyBytes.length === 32
        ? await createKeyPairSignerFromPrivateKeyBytes(privateKeyBytes)
        : (() => {
            throw new Error(
              `PAYER_SVM_PRIVATE_KEY must decode to 32 or 64 bytes (got ${privateKeyBytes.length})`,
            );
          })();

  const signer = toClientSvmSigner(keySigner);
  const rpcUrl = process.env.SVM_RPC_URL?.trim();
  const paymentClient = new x402Client().register(
    "solana:*",
    new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined),
  );
  const httpClient = new x402HTTPClient(paymentClient);

  const body = {
    data: payloadDataB64,
    ...(namespaceIdB64 ? { namespace_id: namespaceIdB64 } : {}),
  };

  const firstResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  const firstBody = await parseJson(firstResponse);
  if (firstResponse.status !== 402) {
    throw new Error(
      `Expected initial 402, got ${firstResponse.status}. Body:\n${getString(firstBody)}`,
    );
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => firstResponse.headers.get(name),
    firstBody,
  );

  console.log("Initial challenge received:");
  console.log(
    JSON.stringify(
      {
        idempotencyKey,
        acceptedOptions: paymentRequired.accepts.map((accept) => ({
          network: accept.network,
          amount: accept.amount,
          asset: accept.asset,
          payTo: accept.payTo,
        })),
      },
      null,
      2,
    ),
  );

  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paidResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      ...httpClient.encodePaymentSignatureHeader(paymentPayload),
    },
    body: JSON.stringify(body),
  });

  const paidBody = await parseJson(paidResponse);
  if (paidResponse.status >= 400) {
    let followupChallenge: unknown;
    try {
      followupChallenge = httpClient.getPaymentRequiredResponse(
        (name) => paidResponse.headers.get(name),
        paidBody,
      );
    } catch {
      followupChallenge = undefined;
    }

    throw new Error(
      [
        `Paid request failed with ${paidResponse.status}.`,
        `Response headers:\n${getString(headersToObject(paidResponse.headers))}`,
        `Response body:\n${getString(paidBody)}`,
        followupChallenge
          ? `Decoded follow-up payment challenge:\n${getString(followupChallenge)}`
          : "No decodable follow-up payment challenge found.",
      ].join("\n\n"),
    );
  }

  const settleResponse = httpClient.getPaymentSettleResponse((name) => paidResponse.headers.get(name));

  console.log("Paid request succeeded:");
  console.log(
    JSON.stringify(
      {
        status: paidResponse.status,
        body: paidBody,
        settlement: settleResponse,
      },
      null,
      2,
    ),
  );

  const replayResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const replayBody = await parseJson(replayResponse);

  console.log("Replay check (should be cached response / no re-charge):");
  console.log(
    JSON.stringify(
      {
        status: replayResponse.status,
        body: replayBody,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
