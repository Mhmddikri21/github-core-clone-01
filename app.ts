// The forge's HTTP server: routing, auth, request ids, body reading.
// Auth model: the suite presents Authorization: Bearer $MAKEFUN_SHOP_TOKEN on every
// API call. When MAKEFUN_SHOP_TOKEN is set, only that token authenticates; when it is
// unset (local practice), any non-empty Bearer token authenticates. GET /healthz,
// GET /api/v3/ and GET /api/v3/meta are public; git smart HTTP carries no auth.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import type { RestCtx } from './rest.ts';
import { handleGit } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { createStore } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooBig = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** The bearer token on the request, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(auth.trim());
  return match === null ? null : match[1]!;
}

/** Whether the request is authenticated under the token rule. */
function isAuthed(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = createStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // Health probe (public).
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /<owner>/<repo>.git/... (also tolerated without .git).
        const gitMatch = /^\/([^/]+)\/([^/]+?)(\.git)?(\/.*)?$/.exec(path);
        if (gitMatch !== null && gitMatch[1] !== 'api') {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const subpath = gitMatch[4] ?? '/';
          const body = (await readBody(req)) ?? Buffer.alloc(0);
          const out = handleGit(store, owner, repoName, subpath, queryOf(req), method, body);
          sendRaw(res, out.status, out.headers['content-type'] ?? JSON_TYPE, out.body);
          return;
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          const raw = await readBody(req);
          const out = handleGraphQL(store, raw === null ? '' : raw.toString('utf8'));
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }

        // MCP.
        if (path === '/mcp' && method === 'POST') {
          if (!isAuthed(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
            return;
          }
          const raw = await readBody(req);
          const out = handleMcp(store, raw === null ? '' : raw.toString('utf8'));
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const publicRoute =
            (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) ||
            (method === 'GET' && path === '/api/v3/meta');
          if (!publicRoute && !isAuthed(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          let parseError = false;
          if (raw !== null && raw.length > 0) {
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              parseError = true;
            }
          }
          const after = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = after === '' ? [] : after.split('/').filter((s) => s !== '').map((s) => {
            try { return decodeURIComponent(s); } catch { return s; }
          });
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const ctx: RestCtx = {
            store,
            method,
            segments,
            query: queryOf(req),
            origin,
            body: parsed,
            bodyParseError: parseError,
          };
          const out = handleRest(ctx);
          if (out.status === 204) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(out.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body, out.headers ?? {});
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The peer went away.
        }
      }
    })();
  });
}
