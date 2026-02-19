import { z } from "zod";

const optionalEnv = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "string" && value.trim().length === 0) {
      return undefined;
    }
    return value;
  }, schema.optional());

const ENV_SCHEMA = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4021),
  X402_FACILITATOR_URL: z.string().url().default("https://x402.org/facilitator"),
  X402_EVM_NETWORK: z.string().default("eip155:84532"),
  X402_SVM_NETWORK: z.string().default("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"),
  X402_EVM_PAY_TO: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .default("0x0000000000000000000000000000000000000001"),
  X402_SVM_PAY_TO: z.string().min(32).default("11111111111111111111111111111111"),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(8_192_000),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(24 * 60 * 60),
  MAINNET_CELENIUM_API: z.string().url().default("https://api-mainnet.celenium.io"),
  MOCHA_CELENIUM_API: z.string().url().default("https://api-mocha.celenium.io"),
  PRICING_MARKUP_BPS: z.coerce.number().int().min(0).max(100_000).default(2_500),
  PRICING_FIXED_USD: z.coerce.number().min(0).default(0),
  PRICING_MIN_USD: z.coerce.number().positive().default(0.01),
  TIA_USD_FALLBACK: z.coerce.number().positive().default(0.5),
  PRICING_TIA_USD_SOURCE: z.enum(["coingecko", "fallback"]).default("coingecko"),
  CELESTIA_SUBMIT_MODE: z.enum(["mock", "rpc", "go"]).default("mock"),
  CELESTIA_RPC_URL: optionalEnv(z.string().url()),
  CELESTIA_RPC_AUTH_TOKEN: optionalEnv(z.string()),
  CELESTIA_TX_KEY_NAME: optionalEnv(z.string().min(1)),
  CELESTIA_SIGNER_ADDRESS: optionalEnv(z.string().min(10)),
  CELESTIA_GO_POSTER_CMD_JSON: optionalEnv(z.string()),
  CELESTIA_GO_POSTER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CELESTIA_GO_DA_URL: optionalEnv(z.string().url()),
  CELESTIA_GO_DA_AUTH_TOKEN: optionalEnv(z.string()),
  CELESTIA_GO_CORE_GRPC_ADDR: optionalEnv(z.string()),
  CELESTIA_GO_CORE_AUTH_TOKEN: optionalEnv(z.string()),
  CELESTIA_GO_NETWORK: z.string().min(1).default("mocha-4"),
  CELESTIA_GO_KEYRING_DIR: z.string().min(1).default(".celestia-poster-keys"),
  CELESTIA_GO_KEYRING_BACKEND: z.string().min(1).default("test"),
  CELESTIA_GO_KEY_NAME: z.string().min(1).default("x402_poster"),
  CELESTIA_NAMESPACE_ID_B64: z
    .string()
    .min(8)
    .default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAwn/EaU0x0Q=="),
  CELESTIA_TX_GAS_PRICE: optionalEnv(z.coerce.number().positive()),
});

export type AppConfig = {
  port: number;
  x402FacilitatorUrl: string;
  x402EvmNetwork: string;
  x402SvmNetwork: string;
  x402EvmPayTo: string;
  x402SvmPayTo: string;
  maxPayloadBytes: number;
  idempotencyTtlMs: number;
  mainnetCeleniumApi: string;
  mochaCeleniumApi: string;
  pricingMarkupBps: number;
  pricingFixedUsd: number;
  pricingMinUsd: number;
  tiaUsdFallback: number;
  pricingTiaUsdSource: "coingecko" | "fallback";
  celestiaSubmitMode: "mock" | "rpc" | "go";
  celestiaRpcUrl?: string;
  celestiaRpcAuthToken?: string;
  celestiaTxKeyName?: string;
  celestiaSignerAddress?: string;
  celestiaGoPosterCmdJson?: string;
  celestiaGoPosterTimeoutMs: number;
  celestiaGoDaUrl?: string;
  celestiaGoDaAuthToken?: string;
  celestiaGoCoreGrpcAddr?: string;
  celestiaGoCoreAuthToken?: string;
  celestiaGoNetwork: string;
  celestiaGoKeyringDir: string;
  celestiaGoKeyringBackend: string;
  celestiaGoKeyName: string;
  celestiaNamespaceIdB64: string;
  celestiaTxGasPrice?: number;
};

export const loadConfig = (): AppConfig => {
  const parsed = ENV_SCHEMA.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const env = parsed.data;
  return {
    port: env.PORT,
    x402FacilitatorUrl: env.X402_FACILITATOR_URL,
    x402EvmNetwork: env.X402_EVM_NETWORK,
    x402SvmNetwork: env.X402_SVM_NETWORK,
    x402EvmPayTo: env.X402_EVM_PAY_TO,
    x402SvmPayTo: env.X402_SVM_PAY_TO,
    maxPayloadBytes: env.MAX_PAYLOAD_BYTES,
    idempotencyTtlMs: env.IDEMPOTENCY_TTL_SECONDS * 1_000,
    mainnetCeleniumApi: env.MAINNET_CELENIUM_API,
    mochaCeleniumApi: env.MOCHA_CELENIUM_API,
    pricingMarkupBps: env.PRICING_MARKUP_BPS,
    pricingFixedUsd: env.PRICING_FIXED_USD,
    pricingMinUsd: env.PRICING_MIN_USD,
    tiaUsdFallback: env.TIA_USD_FALLBACK,
    pricingTiaUsdSource: env.PRICING_TIA_USD_SOURCE,
    celestiaSubmitMode: env.CELESTIA_SUBMIT_MODE,
    celestiaRpcUrl: env.CELESTIA_RPC_URL,
    celestiaRpcAuthToken: env.CELESTIA_RPC_AUTH_TOKEN,
    celestiaTxKeyName: env.CELESTIA_TX_KEY_NAME,
    celestiaSignerAddress: env.CELESTIA_SIGNER_ADDRESS,
    celestiaGoPosterCmdJson: env.CELESTIA_GO_POSTER_CMD_JSON,
    celestiaGoPosterTimeoutMs: env.CELESTIA_GO_POSTER_TIMEOUT_MS,
    celestiaGoDaUrl: env.CELESTIA_GO_DA_URL,
    celestiaGoDaAuthToken: env.CELESTIA_GO_DA_AUTH_TOKEN,
    celestiaGoCoreGrpcAddr: env.CELESTIA_GO_CORE_GRPC_ADDR,
    celestiaGoCoreAuthToken: env.CELESTIA_GO_CORE_AUTH_TOKEN,
    celestiaGoNetwork: env.CELESTIA_GO_NETWORK,
    celestiaGoKeyringDir: env.CELESTIA_GO_KEYRING_DIR,
    celestiaGoKeyringBackend: env.CELESTIA_GO_KEYRING_BACKEND,
    celestiaGoKeyName: env.CELESTIA_GO_KEY_NAME,
    celestiaNamespaceIdB64: env.CELESTIA_NAMESPACE_ID_B64,
    celestiaTxGasPrice: env.CELESTIA_TX_GAS_PRICE,
  };
};
