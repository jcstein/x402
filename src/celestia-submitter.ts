import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export type SubmitBlobInput = {
  namespaceIdB64: string;
  dataB64: string;
  gasPrice?: number;
  keyName?: string;
  signerAddress?: string;
};

export type SubmitBlobResult = {
  mode: "mock" | "rpc" | "go";
  txHash: string;
  height?: number;
  code?: number;
  raw?: unknown;
};

export class CelestiaSubmitError extends Error {
  readonly code?: number;
  readonly raw?: unknown;

  constructor(message: string, code?: number, raw?: unknown) {
    super(message);
    this.name = "CelestiaSubmitError";
    this.code = code;
    this.raw = raw;
  }
}

export interface CelestiaSubmitter {
  submitBlob(input: SubmitBlobInput): Promise<SubmitBlobResult>;
}

export class MockCelestiaSubmitter implements CelestiaSubmitter {
  async submitBlob(input: SubmitBlobInput): Promise<SubmitBlobResult> {
    const digest = createHash("sha256")
      .update(input.namespaceIdB64)
      .update("\n")
      .update(input.dataB64)
      .digest("hex")
      .toUpperCase();

    return {
      mode: "mock",
      txHash: digest,
      height: Math.floor(Date.now() / 1_000),
      code: 0,
      raw: {
        txhash: digest,
        height: Math.floor(Date.now() / 1_000),
        code: 0,
        note: "Mock mode enabled. No real Celestia transaction was submitted.",
      },
    };
  }
}

type RpcSubmitterConfig = {
  rpcUrl: string;
  authToken?: string;
  defaultGasPrice?: number;
  defaultKeyName?: string;
  defaultSignerAddress?: string;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse = {
  id?: number;
  jsonrpc?: string;
  result?: {
    txhash?: string;
    height?: number;
    code?: number;
    raw_log?: string;
    [key: string]: unknown;
  };
  error?: JsonRpcError;
};

export type PosterStatus = {
  address?: string;
  balance?: {
    denom?: string;
    amount?: string;
  };
};

export class RpcCelestiaSubmitter implements CelestiaSubmitter {
  constructor(private readonly config: RpcSubmitterConfig) {}

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const payload = {
      id: 1,
      jsonrpc: "2.0",
      method,
      params,
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.config.authToken) {
      headers.authorization = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(this.config.rpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new CelestiaSubmitError(
        `Celestia RPC returned ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as JsonRpcResponse;
    if (body.error) {
      throw new CelestiaSubmitError(
        `Celestia RPC error ${body.error.code}: ${body.error.message}`,
        body.error.code,
        body.error,
      );
    }

    return body.result;
  }

  async getPosterStatus(): Promise<PosterStatus> {
    const [addressResult, balanceResult] = await Promise.all([
      this.rpcCall("state.AccountAddress", []).catch(() => undefined),
      this.rpcCall("state.Balance", []).catch(() => undefined),
    ]);

    let address: string | undefined;
    if (typeof addressResult === "string") {
      address = addressResult;
    } else if (
      addressResult &&
      typeof addressResult === "object" &&
      "address" in addressResult &&
      typeof (addressResult as { address?: unknown }).address === "string"
    ) {
      address = (addressResult as { address: string }).address;
    }

    let balance: PosterStatus["balance"];
    if (balanceResult && typeof balanceResult === "object") {
      const raw = balanceResult as { denom?: unknown; amount?: unknown };
      const denom = typeof raw.denom === "string" ? raw.denom : undefined;
      const amount =
        typeof raw.amount === "string" || typeof raw.amount === "number"
          ? String(raw.amount)
          : undefined;
      if (denom || amount) {
        balance = { denom, amount };
      }
    }

    return { address, balance };
  }

  async submitBlob(input: SubmitBlobInput): Promise<SubmitBlobResult> {
    const txConfig: Record<string, unknown> = {};
    const gasPrice = input.gasPrice ?? this.config.defaultGasPrice;
    if (gasPrice !== undefined) {
      txConfig.gas_price = gasPrice;
      txConfig.is_gas_price_set = true;
    }
    const keyName = input.keyName ?? this.config.defaultKeyName;
    if (keyName) {
      txConfig.key_name = keyName;
    }
    const signerAddress = input.signerAddress ?? this.config.defaultSignerAddress;
    if (signerAddress) {
      txConfig.signer_address = signerAddress;
    }

    const result = await this.rpcCall("state.SubmitPayForBlob", [
      [{ namespace_id: input.namespaceIdB64, data: input.dataB64 }],
      txConfig,
    ]);
    if (!result || typeof result !== "object") {
      throw new CelestiaSubmitError("Celestia RPC response missing result");
    }
    const bodyResult = result as NonNullable<JsonRpcResponse["result"]>;

    const code = Number(bodyResult.code ?? 0);
    if (!Number.isFinite(code)) {
      throw new CelestiaSubmitError(
        "Celestia RPC returned non-numeric tx code",
        undefined,
        bodyResult,
      );
    }

    if (code !== 0) {
      const rawLog =
        typeof bodyResult.raw_log === "string" && bodyResult.raw_log.length > 0
          ? bodyResult.raw_log
          : "unknown error";
      throw new CelestiaSubmitError(
        `Celestia tx failed with code ${code}: ${rawLog}`,
        code,
        bodyResult,
      );
    }

    const txHash = bodyResult.txhash;
    if (typeof txHash !== "string" || txHash.length === 0) {
      throw new CelestiaSubmitError(
        "Celestia RPC response missing txhash",
        undefined,
        bodyResult,
      );
    }

    return {
      mode: "rpc",
      txHash,
      height: typeof bodyResult.height === "number" ? bodyResult.height : undefined,
      code,
      raw: bodyResult,
    };
  }
}

export type GoPosterSubmitterConfig = {
  command: string[];
  timeoutMs: number;
  env: {
    daUrl: string;
    daAuthToken?: string;
    coreGrpcAddr?: string;
    coreAuthToken?: string;
    network: string;
    keyringDir: string;
    keyringBackend: string;
    keyName: string;
  };
  defaultGasPrice?: number;
  defaultKeyName?: string;
  defaultSignerAddress?: string;
};

type GoPosterRequest = {
  action: "status" | "submit";
  namespace_id_b64?: string;
  data_b64?: string;
  gas_price?: number;
  key_name?: string;
  signer_address?: string;
};

type GoPosterResponse = {
  ok?: boolean;
  mode?: string;
  error?: string;
  poster_address?: string;
  balance?: {
    denom?: string;
    amount?: string;
  };
  tx_hash?: string;
  height?: number;
  code?: number;
  raw_log?: string;
  [key: string]: unknown;
};

const parseGoPosterResponse = (stdout: string): GoPosterResponse | undefined => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as GoPosterResponse;
  } catch {
    const lines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return undefined;
    }

    return JSON.parse(lines[lines.length - 1]) as GoPosterResponse;
  }
};

const optionalString = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const safeProcessEnv = (input: GoPosterSubmitterConfig["env"]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CELESTIA_GO_DA_URL: input.daUrl,
    CELESTIA_GO_NETWORK: input.network,
    CELESTIA_GO_KEYRING_DIR: input.keyringDir,
    CELESTIA_GO_KEYRING_BACKEND: input.keyringBackend,
    CELESTIA_GO_KEY_NAME: input.keyName,
  };

  const optionalPairs: Array<[string, string | undefined]> = [
    ["CELESTIA_GO_DA_AUTH_TOKEN", input.daAuthToken],
    ["CELESTIA_GO_CORE_GRPC_ADDR", input.coreGrpcAddr],
    ["CELESTIA_GO_CORE_AUTH_TOKEN", input.coreAuthToken],
  ];

  for (const [key, value] of optionalPairs) {
    const parsed = optionalString(value);
    if (parsed) {
      env[key] = parsed;
    }
  }

  return env;
};

export class GoPosterSubmitter implements CelestiaSubmitter {
  constructor(private readonly config: GoPosterSubmitterConfig) {
    if (config.command.length === 0) {
      throw new Error("GoPosterSubmitter requires a non-empty command");
    }
  }

  private invoke(request: GoPosterRequest): Promise<GoPosterResponse> {
    const [command, ...args] = this.config.command;

    return new Promise<GoPosterResponse>((resolve, reject) => {
      const child = spawn(command, args, {
        env: safeProcessEnv(this.config.env),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.config.timeoutMs);
      timeoutHandle.unref();

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timeoutHandle);
        reject(
          new CelestiaSubmitError(
            `Failed to start Go poster command: ${error.message}`,
            undefined,
            { command: this.config.command },
          ),
        );
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          return reject(
            new CelestiaSubmitError(
              `Go poster command timed out after ${this.config.timeoutMs}ms`,
              undefined,
              { command: this.config.command },
            ),
          );
        }

        let parsed: GoPosterResponse | undefined;
        try {
          parsed = parseGoPosterResponse(stdout);
        } catch {
          return reject(
            new CelestiaSubmitError("Go poster command returned invalid JSON", undefined, {
              stdout,
              stderr,
              exitCode: code,
              signal,
            }),
          );
        }

        if (code !== 0) {
          return reject(
            new CelestiaSubmitError(
              parsed?.error || stderr.trim() || `Go poster command exited with code ${code}`,
              code ?? undefined,
              parsed ?? { stdout, stderr, signal },
            ),
          );
        }

        if (!parsed) {
          return reject(
            new CelestiaSubmitError("Go poster command returned empty response", undefined, {
              stdout,
              stderr,
              signal,
            }),
          );
        }

        if (parsed.ok === false) {
          return reject(
            new CelestiaSubmitError(
              parsed.error || "Go poster command returned error",
              Number.isFinite(parsed.code) ? parsed.code : undefined,
              parsed,
            ),
          );
        }

        return resolve(parsed);
      });

      child.stdin.end(JSON.stringify(request));
    });
  }

  async getPosterStatus(): Promise<PosterStatus> {
    const response = await this.invoke({
      action: "status",
      key_name: this.config.defaultKeyName,
      signer_address: this.config.defaultSignerAddress,
    });

    return {
      address:
        typeof response.poster_address === "string" && response.poster_address.length > 0
          ? response.poster_address
          : undefined,
      balance:
        response.balance && typeof response.balance === "object"
          ? {
              denom:
                typeof response.balance.denom === "string"
                  ? response.balance.denom
                  : undefined,
              amount:
                typeof response.balance.amount === "string"
                  ? response.balance.amount
                  : undefined,
            }
          : undefined,
    };
  }

  async submitBlob(input: SubmitBlobInput): Promise<SubmitBlobResult> {
    const gasPrice = input.gasPrice ?? this.config.defaultGasPrice;
    const keyName = input.keyName ?? this.config.defaultKeyName;
    const signerAddress = input.signerAddress ?? this.config.defaultSignerAddress;

    const response = await this.invoke({
      action: "submit",
      namespace_id_b64: input.namespaceIdB64,
      data_b64: input.dataB64,
      gas_price: gasPrice,
      key_name: keyName,
      signer_address: signerAddress,
    });

    const code = Number(response.code ?? 0);
    if (!Number.isFinite(code)) {
      throw new CelestiaSubmitError("Go poster returned non-numeric tx code", undefined, response);
    }

    if (code !== 0) {
      const rawLog =
        typeof response.raw_log === "string" && response.raw_log.length > 0
          ? response.raw_log
          : "unknown error";
      throw new CelestiaSubmitError(
        `Celestia tx failed with code ${code}: ${rawLog}`,
        code,
        response,
      );
    }

    const txHash = response.tx_hash;
    if (typeof txHash !== "string" || txHash.length === 0) {
      throw new CelestiaSubmitError("Go poster response missing tx_hash", undefined, response);
    }

    return {
      mode: "go",
      txHash,
      height: typeof response.height === "number" ? response.height : undefined,
      code,
      raw: response,
    };
  }
}

export const parseGoPosterCommand = (raw?: string): string[] => {
  if (!raw) {
    return ["go", "run", "./go/cmd/celestia-poster"];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid CELESTIA_GO_POSTER_CMD_JSON. Expected JSON array. ${
        error instanceof Error ? error.message : "Unable to parse"
      }`,
    );
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
    throw new Error("CELESTIA_GO_POSTER_CMD_JSON must be a non-empty JSON array of strings");
  }

  return parsed;
};
