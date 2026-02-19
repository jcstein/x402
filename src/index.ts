import "dotenv/config";
import express, { type Request, type Response } from "express";
import { paymentMiddlewareFromHTTPServer } from "@x402/express";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { parseBlobRequest, type ParsedBlobRequest } from "./blob-request.js";
import { CeleniumClient } from "./celenium-client.js";
import {
  CelestiaSubmitError,
  GoPosterSubmitter,
  MockCelestiaSubmitter,
  parseGoPosterCommand,
  type PosterStatus,
  type CelestiaSubmitter,
  RpcCelestiaSubmitter,
} from "./celestia-submitter.js";
import { loadConfig } from "./config.js";
import { IdempotencyStore } from "./idempotency-store.js";
import { PricingEngine } from "./pricing.js";

const config = loadConfig();
const celeniumClient = new CeleniumClient(config.mainnetCeleniumApi, config.mochaCeleniumApi);
const pricingEngine = new PricingEngine(celeniumClient, {
  markupBps: config.pricingMarkupBps,
  fixedUsd: config.pricingFixedUsd,
  minUsd: config.pricingMinUsd,
  tiaUsdFallback: config.tiaUsdFallback,
  tiaUsdSource: config.pricingTiaUsdSource,
});
const idempotencyStore = new IdempotencyStore(config.idempotencyTtlMs);
type QuoteResult = Awaited<ReturnType<PricingEngine["quote"]>>;
type QuoteCacheEntry = {
  fingerprint: string;
  quote: QuoteResult;
  expiresAt: number;
};
const quoteByIdempotencyKey = new Map<string, QuoteCacheEntry>();
const quotePromiseByAdapter = new WeakMap<object, Promise<QuoteResult>>();

const celestiaSubmitter: CelestiaSubmitter = (() => {
  if (config.celestiaSubmitMode === "rpc") {
    return new RpcCelestiaSubmitter({
      rpcUrl: config.celestiaRpcUrl ?? "",
      authToken: config.celestiaRpcAuthToken,
      defaultGasPrice: config.celestiaTxGasPrice,
      defaultKeyName: config.celestiaTxKeyName,
      defaultSignerAddress: config.celestiaSignerAddress,
    });
  }

  if (config.celestiaSubmitMode === "go") {
    const daUrl = config.celestiaGoDaUrl ?? config.celestiaRpcUrl ?? "";
    return new GoPosterSubmitter({
      command: parseGoPosterCommand(config.celestiaGoPosterCmdJson),
      timeoutMs: config.celestiaGoPosterTimeoutMs,
      env: {
        daUrl,
        daAuthToken: config.celestiaGoDaAuthToken ?? config.celestiaRpcAuthToken,
        coreGrpcAddr: config.celestiaGoCoreGrpcAddr,
        coreAuthToken: config.celestiaGoCoreAuthToken ?? config.celestiaRpcAuthToken,
        network: config.celestiaGoNetwork,
        keyringDir: config.celestiaGoKeyringDir,
        keyringBackend: config.celestiaGoKeyringBackend,
        keyName: config.celestiaTxKeyName ?? config.celestiaGoKeyName,
      },
      defaultGasPrice: config.celestiaTxGasPrice,
      defaultKeyName: config.celestiaTxKeyName ?? config.celestiaGoKeyName,
      defaultSignerAddress: config.celestiaSignerAddress,
    });
  }

  return new MockCelestiaSubmitter();
})();

let posterStatus: PosterStatus | undefined;

if (config.celestiaSubmitMode === "rpc" && !config.celestiaRpcUrl) {
  throw new Error("CELESTIA_RPC_URL is required when CELESTIA_SUBMIT_MODE=rpc");
}

if (config.celestiaSubmitMode === "go" && !(config.celestiaGoDaUrl ?? config.celestiaRpcUrl)) {
  throw new Error(
    "CELESTIA_GO_DA_URL (or CELESTIA_RPC_URL fallback) is required when CELESTIA_SUBMIT_MODE=go",
  );
}

const app = express();

// CORS — allow browser clients (e.g. local frontend dev server) to reach the API
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-PAYMENT, X-PAYMENT-RESPONSE, Payment-Signature, Idempotency-Key, Authorization",
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "PAYMENT-REQUIRED, X-PAYMENT-RESPONSE, Payment-Response",
  );
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Request JSON contains base64 data, which is ~4/3 the raw payload size.
const jsonBodyLimitBytes = Math.ceil((config.maxPayloadBytes * 4) / 3) + 256 * 1024;
app.use(express.json({ limit: jsonBodyLimitBytes }));

const facilitatorClient = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });
const resourceServer = new x402ResourceServer(facilitatorClient);
registerExactEvmScheme(resourceServer, { networks: [config.x402EvmNetwork as `${string}:${string}`] });
registerExactSvmScheme(resourceServer, { networks: [config.x402SvmNetwork as `${string}:${string}`] });

const getOrCreateQuote = async (
  parsed: ParsedBlobRequest,
  idempotencyKey?: string,
): Promise<QuoteResult> => {
  const normalizedKey = idempotencyKey?.trim();
  if (normalizedKey) {
    const existing = quoteByIdempotencyKey.get(normalizedKey);
    if (existing && existing.fingerprint === parsed.fingerprint && existing.expiresAt > Date.now()) {
      return existing.quote;
    }
  }

  const quote = await pricingEngine.quote(parsed.payloadBytes);
  if (normalizedKey) {
    quoteByIdempotencyKey.set(normalizedKey, {
      fingerprint: parsed.fingerprint,
      quote,
      expiresAt: Date.now() + config.idempotencyTtlMs,
    });
  }

  return quote;
};

const quoteForRequest = async (context: {
  adapter: {
    getBody?: () => unknown;
    getHeader?: (name: string) => string | undefined;
  };
}): Promise<QuoteResult> => {
  const adapterRef = context.adapter as object;
  const existing = quotePromiseByAdapter.get(adapterRef);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const parsed = parseBlobRequest(context.adapter.getBody?.(), config.celestiaNamespaceIdB64);
    if (parsed.payloadBytes > config.maxPayloadBytes) {
      throw new Error(
        `Payload exceeds MAX_PAYLOAD_BYTES (${parsed.payloadBytes} > ${config.maxPayloadBytes})`,
      );
    }

    const idempotencyKey = context.adapter.getHeader?.("idempotency-key");
    return getOrCreateQuote(parsed, idempotencyKey);
  })();

  quotePromiseByAdapter.set(adapterRef, promise);
  return promise;
};

const quoteForBody = async (body: unknown, idempotencyKey?: string) => {
  const parsed = parseBlobRequest(body, config.celestiaNamespaceIdB64);
  if (parsed.payloadBytes > config.maxPayloadBytes) {
    throw new Error(
      `Payload exceeds MAX_PAYLOAD_BYTES (${parsed.payloadBytes} > ${config.maxPayloadBytes})`,
    );
  }
  return getOrCreateQuote(parsed, idempotencyKey);
};

const routes = {
  "POST /v1/blobs": {
    description: "Pay with x402 to submit a blob to Celestia Mocha",
    mimeType: "application/json",
    accepts: [
      {
        scheme: "exact",
        network: config.x402EvmNetwork as `${string}:${string}`,
        payTo: config.x402EvmPayTo,
        price: async (context: {
          adapter: {
            getBody?: () => unknown;
            getHeader?: (name: string) => string | undefined;
          };
        }) => {
          try {
            const quote = await quoteForRequest(context);
            return quote.chargedPriceString;
          } catch {
            return `$${config.pricingMinUsd.toFixed(4)}`;
          }
        },
      },
      {
        scheme: "exact",
        network: config.x402SvmNetwork as `${string}:${string}`,
        payTo: config.x402SvmPayTo,
        price: async (context: {
          adapter: {
            getBody?: () => unknown;
            getHeader?: (name: string) => string | undefined;
          };
        }) => {
          try {
            const quote = await quoteForRequest(context);
            return quote.chargedPriceString;
          } catch {
            return `$${config.pricingMinUsd.toFixed(4)}`;
          }
        },
      },
    ],
    unpaidResponseBody: async (context: {
      adapter: {
        getBody?: () => unknown;
        getHeader?: (name: string) => string | undefined;
      };
    }) => {
      try {
        const quote = await quoteForRequest(context);
        return {
          contentType: "application/json",
          body: {
            error: "Payment Required",
            hint: "Retry the same request with x402 payment headers. Keep the same Idempotency-Key.",
            quote,
          },
        };
      } catch (error) {
        return {
          contentType: "application/json",
          body: {
            error: "Payment Required",
            hint: "Request body must include base64 `data` and optional base64 `namespace_id`.",
            details: error instanceof Error ? error.message : "Unable to compute quote for this request",
          },
        };
      }
    },
  },
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);
let x402Ready = false;

const syncFacilitatorSupport = async (): Promise<void> => {
  try {
    await httpServer.initialize();
    x402Ready = true;
    console.log("x402 facilitator sync complete");
  } catch (error) {
    x402Ready = false;
    console.error(
      `x402 facilitator sync failed, retrying in 10s: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    setTimeout(() => {
      void syncFacilitatorSupport();
    }, 10_000).unref();
  }
};

void syncFacilitatorSupport();

const refreshPosterStatus = async (): Promise<void> => {
  if (
    !(celestiaSubmitter instanceof RpcCelestiaSubmitter) &&
    !(celestiaSubmitter instanceof GoPosterSubmitter)
  ) {
    return;
  }
  try {
    posterStatus = await celestiaSubmitter.getPosterStatus();
  } catch {
    posterStatus = undefined;
  }
};

void refreshPosterStatus();
setInterval(() => {
  void refreshPosterStatus();
}, 30_000).unref();

httpServer.onProtectedRequest(async (context) => {
  const hasPayment = !!(context.adapter.getHeader?.("payment-signature") || context.adapter.getHeader?.("x-payment"));
  console.log(`[onProtectedRequest] hasPayment=${hasPayment} x402Ready=${x402Ready}`);

  if (!x402Ready) {
    console.log("[onProtectedRequest] aborting: not ready");
    return {
      abort: true,
      reason: "Payment backend not ready yet. Retry in a few seconds.",
    };
  }

  const key = context.adapter.getHeader("idempotency-key")?.trim();
  if (!key) {
    return { abort: true, reason: "Idempotency-Key header is required" as const };
  }

  if (key.length > 120) {
    return {
      abort: true,
      reason: "Idempotency-Key must be 120 characters or fewer" as const,
    };
  }

  let parsed;
  try {
    parsed = parseBlobRequest(context.adapter.getBody?.(), config.celestiaNamespaceIdB64);
  } catch (error) {
    return {
      abort: true,
      reason: error instanceof Error ? error.message : "Invalid request body",
    };
  }

  if (parsed.payloadBytes > config.maxPayloadBytes) {
    return {
      abort: true,
      reason: `Payload exceeds MAX_PAYLOAD_BYTES (${parsed.payloadBytes} > ${config.maxPayloadBytes})`,
    };
  }

  const existing = idempotencyStore.get(key);
  if (!existing) {
    return;
  }

  if (existing.fingerprint !== parsed.fingerprint) {
    return {
      abort: true,
      reason: "Idempotency-Key already used with different payload",
    };
  }

  return { grantAccess: true };
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get("/v1/network-info", async (_req: Request, res: Response) => {
  try {
    const [mainnet, mocha] = await Promise.all([
      celeniumClient.getConstants("mainnet"),
      celeniumClient.getConstants("mocha"),
    ]);
    res.json({
      source: "Celenium API",
      mainnet,
      mocha,
      configuredMaxPayloadBytes: config.maxPayloadBytes,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to fetch network constants",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/v1/poster", async (_req: Request, res: Response) => {
  if (
    !(celestiaSubmitter instanceof RpcCelestiaSubmitter) &&
    !(celestiaSubmitter instanceof GoPosterSubmitter)
  ) {
    return res.json({
      mode: "mock",
      message: "Poster account is only available when CELESTIA_SUBMIT_MODE=rpc|go",
    });
  }

  await refreshPosterStatus();
  return res.json({
    mode: config.celestiaSubmitMode,
    keyName: config.celestiaTxKeyName ?? config.celestiaGoKeyName,
    signerAddressOverride: config.celestiaSignerAddress,
    posterStatus: posterStatus ?? null,
  });
});

app.post("/v1/quote", async (req: Request, res: Response) => {
  try {
    const parsed = parseBlobRequest(req.body, config.celestiaNamespaceIdB64);
    if (parsed.payloadBytes > config.maxPayloadBytes) {
      return res.status(413).json({
        error: "Payload too large",
        maxPayloadBytes: config.maxPayloadBytes,
        payloadBytes: parsed.payloadBytes,
      });
    }

    const quote = await pricingEngine.quote(parsed.payloadBytes);
    return res.json({
      payloadBytes: parsed.payloadBytes,
      quote,
    });
  } catch (error) {
    return res.status(400).json({
      error: "Invalid quote request",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Lazy facilitator sync avoids hard-failing server startup if facilitator is temporarily unreachable.
app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));

app.post("/v1/blobs", async (req: Request, res: Response) => {
  const idempotencyKey = req.header("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return res.status(400).json({ error: "Idempotency-Key header is required" });
  }

  let parsed;
  try {
    parsed = parseBlobRequest(req.body, config.celestiaNamespaceIdB64);
  } catch (error) {
    return res.status(400).json({
      error: "Invalid blob payload",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }

  if (parsed.payloadBytes > config.maxPayloadBytes) {
    return res.status(413).json({
      error: "Payload too large",
      maxPayloadBytes: config.maxPayloadBytes,
      payloadBytes: parsed.payloadBytes,
    });
  }

  const existing = idempotencyStore.get(idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== parsed.fingerprint) {
      return res.status(409).json({
        error: "Idempotency-Key already used with different payload",
        idempotency: {
          key: idempotencyKey,
          replayed: true,
          status: existing.status,
        },
      });
    }

    if (existing.status === "processing") {
      return res.status(409).json({
        error: "Request with this Idempotency-Key is still processing",
        idempotency: {
          key: idempotencyKey,
          replayed: true,
          status: existing.status,
        },
      });
    }

    return res.status(existing.responseStatus ?? 200).json({
      ...(existing.responseBody as object),
      idempotency: {
        key: idempotencyKey,
        replayed: true,
        status: existing.status,
      },
    });
  }

  idempotencyStore.begin(idempotencyKey, parsed.fingerprint);

  try {
    const [quote, mochaGasPriceUtia] = await Promise.all([
      getOrCreateQuote(parsed, idempotencyKey),
      config.celestiaTxGasPrice
        ? Promise.resolve(config.celestiaTxGasPrice)
        : celeniumClient.getGasPriceUtia("mocha").catch(() => undefined),
    ]);

    const submitResult = await celestiaSubmitter.submitBlob({
      namespaceIdB64: parsed.namespaceIdB64,
      dataB64: parsed.dataB64,
      gasPrice: mochaGasPriceUtia,
      keyName: config.celestiaTxKeyName,
      signerAddress: config.celestiaSignerAddress,
    });

    const responseBody = {
      status: "submitted",
      mode: submitResult.mode,
      namespaceId: parsed.namespaceIdB64,
      payloadBytes: parsed.payloadBytes,
      txHash: submitResult.txHash,
      height: submitResult.height,
      code: submitResult.code,
      quote,
      refundPolicy:
        "If Celestia submit fails, this endpoint returns >=400 so x402 settlement does not execute (no charge).",
      idempotency: {
        key: idempotencyKey,
        replayed: false,
        status: "completed",
      },
    };

    idempotencyStore.complete(idempotencyKey, 200, responseBody);
    return res.status(200).json(responseBody);
  } catch (error) {
    const responseStatus =
      error instanceof CelestiaSubmitError && error.code === 21
        ? 413
        : error instanceof CelestiaSubmitError
          ? 502
          : 500;
    const responseBody = {
      error: "Failed to submit blob to Celestia",
      details: error instanceof Error ? error.message : "Unknown error",
      charged: false,
      hint:
        error instanceof CelestiaSubmitError && error.code === 21
          ? "Celestia rejected the blob transaction as too large. Reduce payload size."
          : undefined,
      refundPolicy:
        "No settlement is executed because this request failed (status >= 400), so no refund transfer is needed.",
      idempotency: {
        key: idempotencyKey,
        replayed: false,
        status: "failed",
      },
    };

    idempotencyStore.fail(idempotencyKey, responseStatus, responseBody);
    return res.status(responseStatus).json(responseBody);
  }
});

setInterval(() => {
  idempotencyStore.cleanup();
  const now = Date.now();
  for (const [key, value] of quoteByIdempotencyKey.entries()) {
    if (value.expiresAt <= now) {
      quoteByIdempotencyKey.delete(key);
    }
  }
}, 60_000).unref();

app.listen(config.port, () => {
  console.log(
    JSON.stringify(
      {
        message: "x402 Celestia demo server started",
        port: config.port,
        facilitator: config.x402FacilitatorUrl,
        networks: {
          evm: config.x402EvmNetwork,
          svm: config.x402SvmNetwork,
        },
        celestiaSubmitMode: config.celestiaSubmitMode,
        maxPayloadBytes: config.maxPayloadBytes,
      },
      null,
      2,
    ),
  );
});
