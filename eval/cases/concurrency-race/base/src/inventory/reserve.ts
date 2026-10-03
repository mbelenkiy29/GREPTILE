import type { StockStore } from "./store";

/** Reserves `quantity` units of `sku` for an order; false when not enough is in stock. */
export async function reserve(store: StockStore, sku: string, quantity: number): Promise<boolean> {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError("quantity must be a positive integer");
  return store.decrementIfAvailable(sku, quantity);
}
