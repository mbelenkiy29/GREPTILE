import type { Db } from "./db/client.js";
import { listMembersRoute } from "./routes/accounts.js";
import { createInvoiceRoute, listInvoicesRoute, type Request, type Response } from "./routes/billing.js";

type Handler = (req: Request) => Response;

/** The service's routes, keyed by `METHOD /path` with `:id` parameters. */
export function routes(db: Db, secret: string): Record<string, Handler> {
  return {
    "GET /accounts/:id/members": listMembersRoute(db, secret),
    "POST /accounts/:id/invoices": createInvoiceRoute(db, secret),
    "GET /accounts/:id/invoices": listInvoicesRoute(db, secret),
  };
}
