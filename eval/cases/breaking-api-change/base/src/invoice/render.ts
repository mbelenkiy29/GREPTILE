import { formatPrice } from "../money/format";

export interface InvoiceLine {
  description: string;
  cents: number;
}

/** Plain-text invoice for email receipts. */
export function renderInvoice(lines: InvoiceLine[], currency: string): string {
  const body = lines.map((l) => `${l.description.padEnd(30)}${formatPrice(l.cents, currency).padStart(12)}`);
  const total = lines.reduce((sum, l) => sum + l.cents, 0);
  return [...body, "-".repeat(42), `${"Total".padEnd(30)}${formatPrice(total, currency).padStart(12)}`].join("\n");
}
