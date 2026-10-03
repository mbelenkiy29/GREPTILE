export interface Sql {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}
