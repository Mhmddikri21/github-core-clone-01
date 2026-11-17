// The forge's HTTP layer: routing, auth, request ids, response building.
// Transport is the hand-rolled raw-TCP server in raw-http.ts (no node:http):
// it parses each request fully (headers + body) and calls dispatch() once,
// synchronously, per request. All routing/auth/JSON semantics are unchanged
// from the node:http version — only the wire changed.
//
// Auth model: the suite presents Authorization: Bearer $MAKEFUN_SHOP_TOKEN on every
// API call. When MAKEFUN_SHOP_TOKEN is set, only that token authenticates; when it is
// unset (local practice), any non-empty Bearer token authenticates. GET /healthz,
// GET /api/v3/ and GET /api/v3/meta are public; git smart HTTP carries no auth.
import { RawTcpServer, type RawRequest, type RawResponse } from './raw-http.ts';
import { handleRest } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { createStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Build a complete response: head (status line + headers + blank line) + body. */
function buildResponse(
  status: number,
  contentType: string | null,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): RawResponse {
  const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? ''}`];
  if (contentType !== null) lines.push(`content-type: ${contentType}`);
  if (status !== 204 && status !== 304) lines.push(`content-length: ${body.length}`);
  lines.push(`x-github-request-id: ${nextRequestId()}`);
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return {
    head: Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
    body: status === 204 ? Buffer.alloc(0) : body,
  };
}

function sendJson(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): RawResponse {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  return buildResponse(status, JSON_TYPE, Buffer.from(text, 'utf8'), headers);
}

function sendRaw(
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): RawResponse {
  return buildResponse(status, contentType, body, headers);
}

/** The bearer token on the request, or null. */
function bearerToken(headers: Map<string, string>): string | null {
  const auth = headers.get('authorization');
  if (auth === undefined) return null;
  const match = /^Bearer (.+)$/.exec(auth.trim());
  return match === null ? null : match[1]!;
}

/** Whether the request is authenticated under the token rule. */
function isAuthed(headers: Map<string, string>): boolean {
  const token = bearerToken(headers);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

/** Parse the request target once; path and query share the parse. */
function parseUrl(target: string): URL {
  try {
    return new URL(target, 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): RawTcpServer {
  const store = createStore();
  return new RawTcpServer((req) => {
    try {
      return dispatch(store, req);
    } catch (err) {
      return sendJson(500, { message: err instanceof Error ? err.message : 'internal error' });
    }
  });
}

/**
 * One request, fully read, dispatched synchronously. Routing order mirrors the
 * old node:http version: health probe, git smart HTTP, GraphQL, MCP, REST v3,
 * then the GitHub 404 body. Bodies arrive pre-read, so there is no async
 * wrapper and no readBody wait anywhere in this file.
 */
function dispatch(
  store: ReturnType<typeof createStore>,
  req: RawRequest,
): RawResponse {
  const method = req.method;
  const url = parseUrl(req.target);
  const path = url.pathname;
  const query = url.searchParams;

  // Health probe (public, GET only — a POST here 404s, as before).
  if (method === 'GET' && path === '/healthz') {
    return sendJson(200, { ok: true });
  }

  // Git smart HTTP: /<owner>/<repo>.git/... (also tolerated without .git).
  // GETs carry an empty body; other methods carry the pre-read body.
  const gitMatch = /^\/([^/]+)\/([^/]+?)(\.git)?(\/.*)?$/.exec(path);
  if (gitMatch !== null && gitMatch[1] !== 'api') {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repoName = decodeURIComponent(gitMatch[2]!);
    const subpath = gitMatch[4] ?? '/';
    const body = method === 'GET' ? Buffer.alloc(0) : req.body;
    const out = handleGit(store, owner, repoName, subpath, query, method, body);
    return sendRaw(out.status, out.headers['content-type'] ?? JSON_TYPE, out.body);
  }

  // GraphQL v4 (POST only).
  if (path === '/api/graphql' && method === 'POST') {
    if (!isAuthed(req.headers)) return sendJson(401, { message: 'Requires authentication' });
    const out = handleGraphQL(store, req.body.toString('utf8'));
    return sendJson(out.status, out.body, out.headers ?? {});
  }

  // MCP (POST only).
  if (path === '/mcp' && method === 'POST') {
    if (!isAuthed(req.headers)) {
      return sendJson(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    }
    const out = handleMcp(store, req.body.toString('utf8'));
    return sendJson(out.status, out.body, out.headers ?? {});
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const publicRoute =
      method === 'GET' &&
      (path === '/api/v3' || path === '/api/v3/' || path === '/api/v3/meta');
    if (!publicRoute && !isAuthed(req.headers)) {
      return sendJson(401, { message: 'Requires authentication' });
    }
    let parsed: unknown;
    let parseError = false;
    if (req.body.length > 0) {
      try {
        parsed = JSON.parse(req.body.toString('utf8'));
      } catch {
        parseError = true;
      }
    }
    const after = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
    const segments = after === '' ? [] : after.split('/').filter((s) => s !== '').map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    const origin = `http://${req.headers.get('host') ?? '127.0.0.1'}`;
    const ctx: RestCtx = {
      store,
      method,
      segments,
      query,
      origin,
      body: parsed,
      bodyParseError: parseError,
    };
    const out = handleRest(ctx);
    if (out.status === 204) {
      return buildResponse(204, null, Buffer.alloc(0), out.headers ?? {});
    }
    return sendJson(out.status, out.body, out.headers ?? {});
  }

  // Everything else: GitHub's 404 body.
  return sendJson(404, { message: 'Not Found' });
}
