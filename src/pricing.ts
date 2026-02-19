import { CeleniumClient } from "./celenium-client.js";

export type PricingQuote = {
  payloadBytes: number;
  mainnetReference: {
    estimatedGas: number;
    gasPriceUtia: number;
    estimatedTia: number;
    tiaUsd: number;
    estimatedUsd: number;
  };
  chargedUsd: number;
  chargedPriceString: string;
};

type PricingConfig = {
  markupBps: number;
  fixedUsd: number;
  minUsd: number;
  tiaUsdFallback: number;
  tiaUsdSource: "coingecko" | "fallback";
};

type CachedTiaUsd = {
  value: number;
  fetchedAtMs: number;
};

const roundToUsdPrice = (value: number): number => Math.ceil(value * 10_000) / 10_000;

export class PricingEngine {
  private cachedTiaUsd?: CachedTiaUsd;

  constructor(
    private readonly celeniumClient: CeleniumClient,
    private readonly config: PricingConfig,
  ) {}

  private async loadTiaUsd(): Promise<number> {
    if (this.config.tiaUsdSource === "fallback") {
      return this.config.tiaUsdFallback;
    }

    const now = Date.now();
    if (this.cachedTiaUsd && now - this.cachedTiaUsd.fetchedAtMs < 60_000) {
      return this.cachedTiaUsd.value;
    }

    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=celestia&vs_currencies=usd",
      );
      if (!response.ok) {
        throw new Error(`CoinGecko returned ${response.status}`);
      }

      const body = (await response.json()) as { celestia?: { usd?: number } };
      const usd = body.celestia?.usd;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
        throw new Error("CoinGecko returned invalid TIA/USD");
      }

      this.cachedTiaUsd = { value: usd, fetchedAtMs: now };
      return usd;
    } catch {
      return this.config.tiaUsdFallback;
    }
  }

  async quote(payloadBytes: number): Promise<PricingQuote> {
    const [estimatedGas, gasPriceUtia, tiaUsd] = await Promise.all([
      this.celeniumClient.estimateGasForPfb("mainnet", payloadBytes),
      this.celeniumClient.getGasPriceUtia("mainnet"),
      this.loadTiaUsd(),
    ]);

    const estimatedTia = (estimatedGas * gasPriceUtia) / 1_000_000;
    const estimatedUsd = estimatedTia * tiaUsd;
    const withMarkup =
      estimatedUsd * (1 + this.config.markupBps / 10_000) + this.config.fixedUsd;
    const chargedUsd = Math.max(this.config.minUsd, roundToUsdPrice(withMarkup));

    return {
      payloadBytes,
      mainnetReference: {
        estimatedGas,
        gasPriceUtia,
        estimatedTia,
        tiaUsd,
        estimatedUsd,
      },
      chargedUsd,
      chargedPriceString: `$${chargedUsd.toFixed(4)}`,
    };
  }
}
