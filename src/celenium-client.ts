type CeleniumNetwork = "mainnet" | "mocha";

type GasPriceResponse = {
  slow: string;
  median: string;
  fast: string;
};

type ConstantsResponse = {
  module?: {
    consensus?: {
      block_max_bytes?: string;
    };
    blob?: {
      gas_per_blob_byte?: string;
      gov_max_square_size?: string;
    };
  };
};

export type NetworkConstants = {
  blockMaxBytes?: number;
  gasPerBlobByte?: number;
  govMaxSquareSize?: number;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
};

export class CeleniumClient {
  private readonly baseUrls: Record<CeleniumNetwork, string>;

  constructor(mainnetBaseUrl: string, mochaBaseUrl: string) {
    this.baseUrls = {
      mainnet: mainnetBaseUrl.replace(/\/+$/u, ""),
      mocha: mochaBaseUrl.replace(/\/+$/u, ""),
    };
  }

  private async requestJson<T>(network: CeleniumNetwork, path: string): Promise<T> {
    const url = `${this.baseUrls[network]}${path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Celenium ${network} request failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  async getGasPriceUtia(network: CeleniumNetwork): Promise<number> {
    const response = await this.requestJson<GasPriceResponse>(network, "/v1/gas/price");
    const median = asNumber(response.median);
    if (median === undefined) {
      throw new Error(`Celenium ${network} returned invalid median gas price`);
    }
    return median;
  }

  async estimateGasForPfb(network: CeleniumNetwork, payloadBytes: number): Promise<number> {
    const url = `/v1/gas/estimate_for_pfb?sizes=${payloadBytes}`;
    const response = await fetch(`${this.baseUrls[network]}${url}`);
    if (!response.ok) {
      throw new Error(
        `Celenium ${network} estimate_for_pfb failed: ${response.status} ${response.statusText}`,
      );
    }

    const text = (await response.text()).trim();
    const estimate = Number(text);
    if (!Number.isFinite(estimate)) {
      throw new Error(`Celenium ${network} returned invalid gas estimate: ${text}`);
    }
    return estimate;
  }

  async getConstants(network: CeleniumNetwork): Promise<NetworkConstants> {
    const response = await this.requestJson<ConstantsResponse>(network, "/v1/constants");

    return {
      blockMaxBytes: asNumber(response.module?.consensus?.block_max_bytes),
      gasPerBlobByte: asNumber(response.module?.blob?.gas_per_blob_byte),
      govMaxSquareSize: asNumber(response.module?.blob?.gov_max_square_size),
    };
  }
}
