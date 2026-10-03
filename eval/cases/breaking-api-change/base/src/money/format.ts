const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** Formats integer cents as a price, e.g. formatPrice(123456, "USD") === "$1,234.56". */
export function formatPrice(cents: number, currency = "USD"): string {
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOLS[currency] ?? `${currency} `}${amount}`;
}
