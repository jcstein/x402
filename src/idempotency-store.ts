type IdempotencyStatus = "processing" | "completed" | "failed";

export type IdempotencyRecord = {
  key: string;
  fingerprint: string;
  status: IdempotencyStatus;
  responseStatus?: number;
  responseBody?: unknown;
  createdAtMs: number;
  updatedAtMs: number;
};

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(private readonly ttlMs: number) {}

  private isExpired(record: IdempotencyRecord): boolean {
    return Date.now() - record.createdAtMs > this.ttlMs;
  }

  private pruneKey(key: string): void {
    const record = this.records.get(key);
    if (!record) {
      return;
    }

    if (this.isExpired(record)) {
      this.records.delete(key);
    }
  }

  cleanup(): void {
    for (const [key, record] of this.records.entries()) {
      if (this.isExpired(record)) {
        this.records.delete(key);
      }
    }
  }

  get(key: string): IdempotencyRecord | undefined {
    this.pruneKey(key);
    return this.records.get(key);
  }

  begin(key: string, fingerprint: string): IdempotencyRecord {
    const now = Date.now();
    const existing = this.get(key);
    if (existing) {
      return existing;
    }

    const created: IdempotencyRecord = {
      key,
      fingerprint,
      status: "processing",
      createdAtMs: now,
      updatedAtMs: now,
    };

    this.records.set(key, created);
    return created;
  }

  complete(key: string, responseStatus: number, responseBody: unknown): void {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }

    existing.status = "completed";
    existing.responseStatus = responseStatus;
    existing.responseBody = responseBody;
    existing.updatedAtMs = Date.now();
  }

  fail(key: string, responseStatus: number, responseBody: unknown): void {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }

    existing.status = "failed";
    existing.responseStatus = responseStatus;
    existing.responseBody = responseBody;
    existing.updatedAtMs = Date.now();
  }
}
