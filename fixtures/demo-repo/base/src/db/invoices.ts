import type { Db, InvoiceRow } from "./client.js";

export function insertInvoice(db: Db, row: InvoiceRow): InvoiceRow {
  db.invoices.push(row);
  return row;
}

/** Invoices of one account, newest first. */
export function listInvoices(db: Db, accountId: string): InvoiceRow[] {
  return db.invoices
    .filter((i) => i.accountId === accountId)
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
}
