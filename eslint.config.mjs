import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  { ignores: [".claude/**", ".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts", ".parity/**"] },
];

export default config;
