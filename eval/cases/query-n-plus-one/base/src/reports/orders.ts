import type { Sql } from "../db/client";

export interface OrderRow {
  id: string;
  totalCents: number;
  customer: string;
}

/** Orders created since `since`, with their customer's name (the daily sales report). */
export async function ordersWithCustomers(sql: Sql, since: Date): Promise<OrderRow[]> {
  return sql.query<OrderRow>(
    `SELECT o.id, o.total_cents AS "totalCents", c.name AS customer
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.created_at >= $1
      ORDER BY o.created_at`,
    [since],
  );
}
