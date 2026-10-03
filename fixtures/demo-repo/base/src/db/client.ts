/**
 * The data layer's contract. Production wires a Postgres pool; tests use `MemoryDb`.
 */
export interface Account {
  id: string;
  name: string;
  region: string;
}

export interface Member {
  accountId: string;
  userId: string;
  role: "owner" | "admin" | "viewer";
}

export interface InvoiceRow {
  id: string;
  accountId: string;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  couponCode: string | null;
  issuedAt: Date;
}

export interface Db {
  accounts: Map<string, Account>;
  members: Member[];
  invoices: InvoiceRow[];
}

export function createMemoryDb(seed: Partial<Db> = {}): Db {
  return {
    accounts: seed.accounts ?? new Map(),
    members: seed.members ?? [],
    invoices: seed.invoices ?? [],
  };
}
