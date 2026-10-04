// The typed client for the worker's REST API. Request and response types come
// from openapi.json through src/openapi.ts (pnpm run generate); nothing here
// restates them. Runs wherever fetch does: the browser and Node.
import createClient from "openapi-fetch";
import type { components, paths } from "./openapi.ts";

export type Session = components["schemas"]["Session"];
export type CreateSession = components["schemas"]["CreateSession"];

// The API at `baseUrl` ("" for same-origin). `fetch` replaces the global one,
// e.g. to call a worker in-process.
export function apiClient(baseUrl: string, fetch?: (request: Request) => Promise<Response>) {
  const api = createClient<paths>({ baseUrl, fetch });
  return {
    listSessions: async () => ok(await api.GET("/api/sessions")),
    createSession: async (body: CreateSession) => ok(await api.POST("/api/sessions", { body })),
  };
}

// The data, or the worker's { error } as a thrown Error.
function ok<T>({ data, error, response }: { data?: T; error?: unknown; response: Response }): T {
  if (error !== undefined || data === undefined) {
    const message = (error as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === "string" ? message : `${response.url}: ${response.status}`);
  }
  return data;
}
