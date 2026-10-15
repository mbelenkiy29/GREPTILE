import type { MetadataRoute } from "next";
import { docPages } from "../src/docs-manifest";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  return [{ url: `${origin}/` }, { url: `${origin}/changelog` }, { url: `${origin}/privacy` }, { url: `${origin}/terms` }, ...docPages.map((d) => ({ url: `${origin}/docs/${d.slug}` }))];
}
