import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const normalizePrivateKey = (raw: string): `0x${string}` => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("PAYER_EVM_PRIVATE_KEY is required");
  }
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
};

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
    return Buffer.from("x402 payment flow test").toString("base64");
  }

  const payloadBytes = Number.parseInt(payloadBytesRaw, 10);
  if (!Number.isInteger(payloadBytes) || payloadBytes <= 0) {
    throw new Error("TEST_PAYLOAD_BYTES must be a positive integer");
  }

  return Buffer.alloc(payloadBytes, 0x78).toString("base64");
};

const main = async (): Promise<void> => {
  const endpoint = process.env.TEST_BLOB_ENDPOINT ?? "http://127.0.0.1:4021/v1/blobs";
  const payloadDataB64 = getPayloadDataB64();
  const namespaceIdB64 = process.env.TEST_NAMESPACE_ID_B64;
  const idempotencyKey =
    process.env.TEST_IDEMPOTENCY_KEY ?? `payflow-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  const payerKey = normalizePrivateKey(process.env.PAYER_EVM_PRIVATE_KEY ?? "");
  const account = privateKeyToAccount(payerKey);
  const signer = toClientEvmSigner(account);
  const paymentClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
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
  const selected = paymentRequired.accepts[0];

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
        selectedNetwork: selected?.network,
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
