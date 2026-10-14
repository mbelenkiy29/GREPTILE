import { z } from "zod";

// Keep native shelf identity intact; never manufacture a Git SHA for execution evidence.
export const runtimeRevisionSchema=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|p4:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{64})$/);
