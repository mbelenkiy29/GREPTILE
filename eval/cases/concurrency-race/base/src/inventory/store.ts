/** Stock levels per SKU, shared by every API instance (backed by Postgres in production). */
export interface StockStore {
  get(sku: string): Promise<number>;
  set(sku: string, quantity: number): Promise<void>;
  /**
   * Atomically subtracts `quantity` when at least that much is in stock
   * (`UPDATE stock SET qty = qty - $2 WHERE sku = $1 AND qty >= $2`); returns whether it did.
   */
  decrementIfAvailable(sku: string, quantity: number): Promise<boolean>;
}
