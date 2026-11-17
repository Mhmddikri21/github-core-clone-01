// Hand-rolled HTTP/1.1 server over raw TCP (node:net), no node:http.
//
// Why: session 2 proved the entry sits AT the node:http floor (read 0.30-0.36
// ms/req vs a 0.29-0.32 floor). A minimal raw-TCP server measured 0.240 vs
// 0.290 ms/req warm on the same floor harness (~17% faster, consistent
// direction in all 4 rounds), so the transport is the remaining lever.
//
// Contract: this file owns ONLY the wire. It parses requests (request line +
// headers + Content-Length or chunked body), answers `Expect: 100-continue`,
// keeps sockets alive per HTTP/1.1 rules, and calls one synchronous handler
// per complete request. All routing/auth/JSON semantics live in app.ts.
// The handler returns the complete response as { head, body }; the transport
// writes head, then body (concatenated into one write when small).
//
// Interface compatibility: RawTcpServer exposes listen(port[, host][, cb]),
// address(), close([cb]) and once('error', fn), the four members main.ts and
// dev-server.mts use on a node:http Server.
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

export interface RawRequest {
  method: string;
  /** Raw request-target, exactly as sent (usually origin-form). */
  target: string;
  /** '1.1' or '1.0'. */
  version: string;
  /** Lowercased header names; duplicates joined with ', ' like node:http. */
  headers: Map<string, string>;
  /** Full request body (empty Buffer when none). */
  body: Buffer;
}

export interface RawResponse {
  /** Status line + headers + blank line, latin1 bytes. */
  head: Buffer;
  /** Response body bytes (empty Buffer for 204/HEAD). */
  body: Buffer;
}

export type RawHandler = (req: RawRequest) => RawResponse;

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
/** Pause reading when the kernel-bound write queue passes this. */
const PAUSE_AT_BYTES = 1024 * 1024;
/** One write when head+body fit; two writes above this (large packs). */
const SINGLE_WRITE_BYTES = 64 * 1024;

const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');

type ParseResult =
  | { status: 'need-more' }
  | { status: 'error' }
  | { status: 'complete'; req: RawRequest; consumed: number; closeAfter: boolean };

/**
 * Parse ONE request from the front of `buf`, or say more bytes are needed.
 * Never throws for malformed input: it returns 'error' instead.
 */
function parseOne(buf: Buffer): ParseResult {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    return buf.length > MAX_HEAD_BYTES ? { status: 'error' } : { status: 'need-more' };
  }
  const headText = buf.subarray(0, headEnd).toString('latin1');
  const lines = headText.split('\r\n');
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace <= 0 || lastSpace <= firstSpace) return { status: 'error' };
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const versionToken = requestLine.slice(lastSpace + 1);
  if (target.length === 0 || (versionToken !== 'HTTP/1.1' && versionToken !== 'HTTP/1.0')) {
    return { status: 'error' };
  }
  const version = versionToken === 'HTTP/1.1' ? '1.1' : '1.0';
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon <= 0) return { status: 'error' };
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers.get(name);
    headers.set(name, prev === undefined ? value : `${prev}, ${value}`);
  }

  const connection = headers.get('connection') ?? '';
  const closeAfter =
    connection.toLowerCase().includes('close') ||
    (version === '1.0' && !connection.toLowerCase().includes('keep-alive'));

  const transferEncoding = headers.get('transfer-encoding') ?? '';
  const bodyStart = headEnd + 4;
  if (transferEncoding.toLowerCase().includes('chunked')) {
    // Chunked framing: <hex-size>[;ext]\r\n<bytes>\r\n ... 0\r\n<trailers>\r\n\r\n
    let pos = bodyStart;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) return { status: 'need-more' };
      const sizeText = buf.subarray(pos, lineEnd).toString('latin1').split(';')[0]!.trim();
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isSafeInteger(size) || size < 0) return { status: 'error' };
      pos = lineEnd + 2;
      if (size === 0) {
        // Trailers end at the next empty line. No trailers at all is the
        // common case: the bytes are just one CRLF — check that FIRST,
        // before searching for a blank line (which could match inside a
        // pipelined next request).
        if (buf.length < pos + 2) return { status: 'need-more' };
        if (buf[pos] === 13 && buf[pos + 1] === 10) {
          pos += 2;
        } else {
          const trailerEnd = buf.indexOf('\r\n\r\n', pos);
          if (trailerEnd === -1) return { status: 'need-more' };
          pos = trailerEnd + 4;
        }
        const body = total === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, total);
        return {
          status: 'complete',
          req: { method, target, version, headers, body },
          consumed: pos,
          closeAfter,
        };
      }
      total += size;
      if (total > MAX_BODY_BYTES) return { status: 'error' };
      if (buf.length < pos + size + 2) return { status: 'need-more' };
      chunks.push(buf.subarray(pos, pos + size));
      pos += size + 2; // skip the chunk data and its trailing CRLF
    }
  }

  const lengthRaw = headers.get('content-length');
  if (lengthRaw !== undefined) {
    const length = Number(lengthRaw);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
      return { status: 'error' };
    }
    if (buf.length < bodyStart + length) return { status: 'need-more' };
    return {
      status: 'complete',
      req: { method, target, version, headers, body: buf.subarray(bodyStart, bodyStart + length) },
      consumed: bodyStart + length,
      closeAfter,
    };
  }
  return {
    status: 'complete',
    req: { method, target, version, headers, body: Buffer.alloc(0) },
    consumed: bodyStart,
    closeAfter,
  };
}

/** A node:http-Server-shaped wrapper around a net.Server. */
export class RawTcpServer extends EventEmitter {
  private readonly tcp: TcpServer;
  private readonly handler: RawHandler;
  private readonly sockets = new Set<Socket>();

  constructor(handler: RawHandler) {
    super();
    this.handler = handler;
    this.tcp = createTcpServer((socket) => this.onSocket(socket));
    this.tcp.on('error', (err) => this.emit('error', err));
  }

  listen(port: number, hostOrCb?: string | (() => void), cb?: () => void): this {
    if (typeof hostOrCb === 'function') {
      this.tcp.listen(port, hostOrCb);
    } else if (typeof hostOrCb === 'string') {
      this.tcp.listen(port, hostOrCb, cb);
    } else {
      this.tcp.listen(port, cb);
    }
    return this;
  }

  address(): ReturnType<TcpServer['address']> {
    return this.tcp.address();
  }

  close(cb?: () => void): this {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.tcp.close(cb);
    return this;
  }

  private onSocket(socket: Socket): void {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {
      // The peer went away; destroying is the only response.
      socket.destroy();
    });
    let buf = Buffer.alloc(0);
    let paused = false;
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const parsed = parseOne(buf);
        if (parsed.status === 'need-more') return;
        if (parsed.status === 'error') {
          socket.destroy();
          return;
        }
        const { req, consumed, closeAfter } = parsed;
        buf = buf.subarray(consumed);
        // Answer 100-continue before the handler runs: curl/git wait for it
        // on large pushes, and node:http answers it automatically.
        if ((req.headers.get('expect') ?? '').toLowerCase() === '100-continue') {
          socket.write(CONTINUE_100);
        }
        let out: RawResponse;
        try {
          out = this.handler(req);
        } catch {
          // The handler never throws (app.ts catches), but a transport-level
          // fallback keeps one bad request from killing the socket.
          out = {
            head: Buffer.from(
              'HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 26\r\n\r\n',
              'latin1',
            ),
            body: Buffer.from('{"message":"internal error"}\n', 'utf8'),
          };
        }
        const isHead = req.method === 'HEAD';
        if (isHead) {
          socket.write(out.head);
        } else if (out.body.length === 0) {
          socket.write(out.head);
        } else if (out.head.length + out.body.length <= SINGLE_WRITE_BYTES) {
          socket.write(Buffer.concat([out.head, out.body]));
        } else {
          socket.write(out.head);
          socket.write(out.body);
        }
        if (closeAfter) {
          socket.end();
          return;
        }
        if (!paused && socket.writableLength > PAUSE_AT_BYTES) {
          paused = true;
          socket.pause();
          socket.once('drain', () => {
            paused = false;
            socket.resume();
          });
        }
        if (buf.length === 0) return;
      }
    });
  }
}
