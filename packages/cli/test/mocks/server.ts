import { createServer, type IncomingMessage, type Server } from "node:http";
import unauthorizedFixture from "../fixtures/errors/unauthorized.json";

export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
  serverUrl: string
) => MockResponse | Promise<MockResponse>;

export type MockResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type MockRoute = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** Path pattern with optional :params (e.g., "/api/0/organizations/:orgSlug/") */
  path: string;
  /** Static response body, or handler function for dynamic responses */
  response: unknown | RouteHandler;
  /** HTTP status code (default: 200) */
  status?: number;
};

export type MockServerOptions = {
  /** Valid tokens for authentication. If set, requests without a valid token get 401. */
  validTokens?: string[];
};

type CompiledRoute = {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  response: unknown | RouteHandler;
  status: number;
};

function compilePath(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = path
    .replace(/:[a-zA-Z]+/g, (match) => {
      paramNames.push(match.slice(1));
      return "([^/]+)";
    })
    // Make trailing slash optional
    .replace(/\/$/, "/?");

  return {
    pattern: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

function matchRoute(
  method: string,
  pathname: string,
  routes: CompiledRoute[]
): { route: CompiledRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }

    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i += 1) {
        params[route.paramNames[i]] = match[i + 1];
      }
      return { route, params };
    }
  }
  return null;
}

export type MockServer = {
  readonly url: string;
  start(): Promise<void>;
  stop(): void;
};

function isAuthorized(req: Request, validTokens: string[]): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return false;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  return validTokens.includes(match[1]);
}

/** Convert a Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(
  req: IncomingMessage,
  baseUrl: string
): Promise<Request> {
  const url = `${baseUrl}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  let body: string | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    body = Buffer.concat(chunks).toString("utf-8");
  }
  return new Request(url, { method, headers, body });
}

export function createMockServer(
  routes: MockRoute[],
  options: MockServerOptions = {}
): MockServer {
  let server: Server | null = null;
  let port = 0;
  const { validTokens } = options;
  const compiledRoutes: CompiledRoute[] = routes.map((route) => {
    const { pattern, paramNames } = compilePath(route.path);
    return {
      method: route.method,
      pattern,
      paramNames,
      response: route.response,
      status: route.status ?? 200,
    };
  });

  return {
    get url() {
      return `http://localhost:${port}`;
    },

    async start() {
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: test mock server requires branching for route matching
      server = createServer(async (nodeReq, nodeRes) => {
        const serverUrl = `http://localhost:${port}`;
        const req = await toWebRequest(nodeReq, serverUrl);
        const method = req.method;
        const pathname = new URL(req.url).pathname;

        let status: number;
        let body: string | undefined;
        let headers: Record<string, string> = {
          "Content-Type": "application/json",
        };

        if (validTokens && !isAuthorized(req, validTokens)) {
          status = 401;
          body = JSON.stringify(unauthorizedFixture);
        } else {
          const match = matchRoute(method, pathname, compiledRoutes);
          if (match) {
            const { route, params } = match;
            let responseData: MockResponse;
            if (typeof route.response === "function") {
              responseData = await (route.response as RouteHandler)(
                req,
                params,
                serverUrl
              );
            } else {
              responseData = { body: route.response, status: route.status };
            }

            status = responseData.status ?? route.status;
            if (responseData.body !== undefined) {
              body = JSON.stringify(responseData.body);
            }
            headers = { ...headers, ...responseData.headers };
          } else {
            status = 404;
            body = JSON.stringify({ detail: "Not found" });
          }
        }

        nodeRes.writeHead(status, headers);
        nodeRes.end(body);
      });

      await new Promise<void>((resolve) => {
        server!.listen(0, () => {
          const addr = server!.address();
          port = typeof addr === "object" && addr ? addr.port : 0;
          resolve();
        });
      });
    },

    stop() {
      server?.close();
      server = null;
    },
  };
}
