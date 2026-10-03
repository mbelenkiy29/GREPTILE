/**
 * The OpenAPI 3.1 document for REST API v1 (R6.18), generated from the route table: paths, methods, scopes, and the
 * JSON Schemas of path parameters, query parameters, request bodies, and responses all come from the routes' zod
 * schemas, so the document cannot drift from what the handlers accept.
 */
import { z } from "zod";
import { APP_VERSION } from "@/lib/version";
import { API_SCOPES, SCOPE_LABEL } from "./keys";
import { routeId, type AnyRoute } from "./router";
import { V1_BASE_PATH, V1_ROUTES } from "./v1";

type JsonSchema = Record<string, unknown>;

function jsonSchema(schema: z.ZodType): JsonSchema {
  const out = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as JsonSchema;
  delete out.$schema;
  return out;
}

/** Path or query parameters from an object schema's properties. */
function parameters(schema: z.ZodType | undefined, where: "path" | "query"): JsonSchema[] {
  if (!schema) return [];
  const s = jsonSchema(schema);
  const props = (s.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((s.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, prop]) => ({
    name,
    in: where,
    required: where === "path" ? true : required.has(name) && !("default" in prop),
    schema: prop,
  }));
}

function operation(route: AnyRoute): JsonSchema {
  const responses: JsonSchema = {};
  for (const [status, doc] of Object.entries(route.responses)) {
    responses[status] = {
      description: doc.description,
      ...(doc.schema ? { content: { [doc.contentType ?? "application/json"]: { schema: jsonSchema(doc.schema) } } } : {}),
    };
  }
  return {
    operationId: routeId(route).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: [route.tag],
    ...(route.public ? { security: [] } : { security: [{ apiKey: route.scope ? [route.scope] : [] }], "x-required-scope": route.scope }),
    parameters: [...parameters(route.params, "path"), ...parameters(route.query, "query")],
    ...(route.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(route.body) } } } } : {}),
    responses,
  };
}

/** The OpenAPI document; `serverUrl` is the app's origin. */
export function openApiDocument(serverUrl: string, routes: readonly AnyRoute[] = V1_ROUTES): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const r of routes) {
    const item = (paths[r.path] ??= {});
    item[r.method.toLowerCase()] = operation(r);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenReview API",
      version: APP_VERSION,
      description:
        "REST API for OpenReview. Authenticate with an API key from Settings → API keys: `Authorization: Bearer or_live_…`. Keys act as their organization, limited to their scopes. Errors are `{ \"error\": { \"code\", \"message\" } }`; lists are paginated with `page` and `pageSize`.",
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: `${serverUrl.replace(/\/$/, "")}${V1_BASE_PATH}` }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "or_live_<token>",
          description: `Scopes: ${API_SCOPES.map((s) => `\`${s}\` (${SCOPE_LABEL[s]})`).join(", ")}.`,
        },
      },
    },
    paths,
  };
}
