/** Runs once per server start: brings the database schema up to date before serving traffic. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.RUN_MIGRATIONS === "false") return;
  const { runMigrations } = await import("./lib/db/migrate");
  await runMigrations();
}
