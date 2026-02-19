import { createHash } from "node:crypto";
import { z } from "zod";

const BLOBS_REQUEST_SCHEMA = z.object({
  data: z.string().min(1),
  namespace_id: z.string().optional(),
  namespaceId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type ParsedBlobRequest = {
  namespaceIdB64: string;
  dataB64: string;
  payloadBytes: number;
  metadata?: Record<string, unknown>;
  fingerprint: string;
};

const isBase64CharCode = (code: number): boolean => {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2b || // +
    code === 0x2f // /
  );
};

const decodeStrictBase64 = (value: string, fieldName: string): Buffer => {
  if (value.length % 4 !== 0) {
    throw new Error(`${fieldName} must be base64 encoded`);
  }

  let encounteredPadding = false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x3d) {
      // '=' padding can only appear in the last 2 positions and only after payload chars.
      if (i < value.length - 2) {
        throw new Error(`${fieldName} must be base64 encoded`);
      }
      encounteredPadding = true;
      continue;
    }

    if (encounteredPadding || !isBase64CharCode(code)) {
      throw new Error(`${fieldName} must be base64 encoded`);
    }
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    throw new Error(`${fieldName} must not decode to empty data`);
  }

  if (decoded.toString("base64") !== value) {
    throw new Error(`${fieldName} is not valid canonical base64`);
  }

  return decoded;
};

export const parseBlobRequest = (
  body: unknown,
  defaultNamespaceIdB64: string,
): ParsedBlobRequest => {
  const parsed = BLOBS_REQUEST_SCHEMA.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid request body: ${details}`);
  }

  const rawNamespaceId = parsed.data.namespace_id ?? parsed.data.namespaceId;
  const namespaceIdB64 = rawNamespaceId ?? defaultNamespaceIdB64;

  decodeStrictBase64(namespaceIdB64, "namespace_id");
  const payloadBuffer = decodeStrictBase64(parsed.data.data, "data");
  const dataB64 = payloadBuffer.toString("base64");

  const fingerprint = createHash("sha256")
    .update(namespaceIdB64)
    .update("\n")
    .update(dataB64)
    .digest("hex");

  return {
    namespaceIdB64,
    dataB64,
    payloadBytes: payloadBuffer.length,
    metadata: parsed.data.metadata,
    fingerprint,
  };
};
