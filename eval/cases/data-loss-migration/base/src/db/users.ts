export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
}

export async function findUserByEmail(sql: Sql, email: string): Promise<UserRow | null> {
  const [row] = await sql.query<UserRow>("SELECT id, email, name FROM users WHERE email = $1", [email.toLowerCase()]);
  return row ?? null;
}
