import { runMigrations } from "@/lib/db/migrate";

runMigrations()
  .then(() => console.log("migrations applied"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
