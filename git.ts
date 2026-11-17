// Pure Git wire-format and object core
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export type ObjectGetter = (oid: string) => GitObject | undefined;

const TYPE_TO_CODE: Record<ObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

function fail(message: string): never {
  throw new Error(message);
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  if (!(type in TYPE_TO_CODE)) fail(`Invalid Git object type: ${String(type)}`);
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

function oidToBuffer(oid: string): Buffer {
  if (!isObjectId(oid)) fail(`Invalid object id: ${oid}`);
  return Buffer.from(oid, 'hex');
}

function readOid(buf: Buffer, offset: number): string {
  if (offset < 0 || offset + 20 > buf.length) fail('Truncated object id');
  return buf.subarray(offset, offset + 20).toString('hex');
}

export function encodePktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) fail('Pkt-line payload is too large');
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, body]);
}

export function encodePktLines(
  items: ReadonlyArray<Buffer | string | 'flush' | 'delim'>,
): Buffer {
  const encoded: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') encoded.push(Buffer.from('0000', 'ascii'));
    else if (item === 'delim') encoded.push(Buffer.from('0001', 'ascii'));
    else encoded.push(encodePktLine(item));
  }
  return Buffer.concat(encoded);
}

export function decodePktLines(
  buf: Buffer,
): Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> {
  const lines: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) fail('Truncated pkt-line length');
    const prefix = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(prefix)) fail('Malformed pkt-line length');
    const length = Number.parseInt(prefix, 16);
    offset += 4;
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      continue;
    }
    if (length === 2) fail('Reserved pkt-line length 0002');
    if (length < 4) fail('Invalid pkt-line length');
    const payloadLength = length - 4;
    if (offset + payloadLength > buf.length) fail('Truncated pkt-line payload');
    lines.push({
      kind: 'data',
      payload: buf.subarray(offset, offset + payloadLength),
    });
    offset += payloadLength;
  }
  return lines;
}

function readPackVarint(buf: Buffer, state: { offset: number }, firstBits: number): number {
  let value = firstBits;
  let shift = 4;
  let byte = buf[state.offset - 1];
  while (byte & 0x80) {
    if (state.offset >= buf.length) fail('Truncated pack entry size');
    byte = buf[state.offset++];
    const part = byte & 0x7f;
    if (shift > 49 || part > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** shift)) {
      fail('Pack entry size exceeds the safe integer range');
    }
    value += part * 2 ** shift;
    if (!Number.isSafeInteger(value)) fail('Pack entry size exceeds the safe integer range');
    shift += 7;
  }
  return value;
}

function readDeltaVarint(buf: Buffer, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (true) {
    if (state.offset >= buf.length) fail('Truncated delta size');
    const byte = buf[state.offset++];
    const part = byte & 0x7f;
    if (shift > 49 || part > Math.floor(Number.MAX_SAFE_INTEGER / 2 ** shift)) {
      fail('Delta size exceeds the safe integer range');
    }
    value += part * 2 ** shift;
    if (!Number.isSafeInteger(value)) fail('Delta size exceeds the safe integer range');
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
}

function findInflatedEntry(
  buf: Buffer,
  start: number,
  limit: number,
  expectedLength: number,
): { data: Buffer; compressedLength: number } {
  const available = limit - start;
  if (available <= 0) fail('Missing compressed pack entry data');

  // Fast path: one inflate of the remainder. Node's inflateSync ignores bytes
  // past the end of the zlib stream, and with { info: true } the engine
  // reports exactly how many input bytes the stream consumed
  // (engine.bytesWritten) — that is the compressed length, with no trial
  // inflation. The legacy binary search below stays as the fallback for
  // runtimes where the info path is unavailable or disagrees.
  try {
    const out = inflateSync(buf.subarray(start, limit), { info: true }) as unknown as {
      buffer: Buffer;
      engine?: { bytesWritten?: unknown };
    };
    const consumed = out.engine?.bytesWritten;
    if (
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed > 0 &&
      consumed <= available &&
      out.buffer.length === expectedLength
    ) {
      return { data: out.buffer, compressedLength: consumed };
    }
  } catch {
    // Fall through to the legacy search.
  }

  let low = 0;
  let high = 1;
  let inflated: Buffer | undefined;

  while (high <= available) {
    try {
      inflated = inflateSync(buf.subarray(start, start + high));
      break;
    } catch {
      low = high;
      if (high === available) break;
      high = Math.min(available, high * 2);
    }
  }
  if (!inflated) fail('Invalid or truncated zlib stream in pack entry');

  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    try {
      const candidate = inflateSync(buf.subarray(start, start + middle));
      high = middle;
      inflated = candidate;
    } catch {
      low = middle;
    }
  }

  if (inflated.length !== expectedLength) {
    fail(`Pack entry size mismatch: expected ${expectedLength}, got ${inflated.length}`);
  }
  return { data: inflated, compressedLength: high };
}

function readOfsDeltaOffset(buf: Buffer, state: { offset: number }): number {
  if (state.offset >= buf.length) fail('Truncated ofs-delta offset');
  let byte = buf[state.offset++];
  let offset = byte & 0x7f;
  while (byte & 0x80) {
    if (state.offset >= buf.length) fail('Truncated ofs-delta offset');
    byte = buf[state.offset++];
    offset = (offset + 1) * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(offset)) fail('Ofs-delta offset exceeds the safe integer range');
  }
  return offset;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { offset: 0 };
  const sourceSize = readDeltaVarint(delta, state);
  const targetSize = readDeltaVarint(delta, state);
  if (sourceSize !== base.length) {
    fail(`Delta source size mismatch: expected ${sourceSize}, got ${base.length}`);
  }

  const chunks: Buffer[] = [];
  let outputLength = 0;
  while (state.offset < delta.length) {
    const opcode = delta[state.offset++];
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (opcode & (1 << bit)) {
          if (state.offset >= delta.length) fail('Truncated delta copy offset');
          copyOffset += delta[state.offset++] * 2 ** (8 * bit);
        }
      }
      for (let bit = 0; bit < 3; bit++) {
        if (opcode & (0x10 << bit)) {
          if (state.offset >= delta.length) fail('Truncated delta copy size');
          copySize += delta[state.offset++] * 2 ** (8 * bit);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) fail('Delta copy exceeds source object');
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      outputLength += copySize;
    } else {
      if (opcode === 0) fail('Invalid zero-length delta insert');
      if (state.offset + opcode > delta.length) fail('Truncated delta insert');
      chunks.push(delta.subarray(state.offset, state.offset + opcode));
      state.offset += opcode;
      outputLength += opcode;
    }
    if (outputLength > targetSize) fail('Delta output exceeds declared target size');
  }

  if (outputLength !== targetSize) {
    fail(`Delta target size mismatch: expected ${targetSize}, got ${outputLength}`);
  }
  return Buffer.concat(chunks, targetSize);
}

export function readPack(
  buf: Buffer,
  resolveBase?: ObjectGetter,
): { objects: Map<string, GitObject>; deltaCount: number } {
  if (buf.length < 32) fail('Packfile is too short');
  if (buf.toString('ascii', 0, 4) !== 'PACK') fail('Invalid packfile signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) fail(`Unsupported packfile version: ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerOffset = buf.length - 20;
  const expectedTrailer = buf.subarray(trailerOffset).toString('hex');
  const actualTrailer = sha1Hex(buf.subarray(0, trailerOffset));
  if (expectedTrailer !== actualTrailer) fail('Packfile trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  const state = { offset: 12 };
  let deltaCount = 0;

  for (let index = 0; index < count; index++) {
    const entryStart = state.offset;
    if (state.offset >= trailerOffset) fail('Truncated pack entry header');
    const first = buf[state.offset++];
    const typeCode = (first >> 4) & 0x07;
    const declaredSize = readPackVarint(buf, state, first & 0x0f);
    let baseObject: GitObject | undefined;
    let refBaseOid: string | undefined;

    if (typeCode === 6) {
      const distance = readOfsDeltaOffset(buf, state);
      const baseOffset = entryStart - distance;
      if (distance <= 0 || baseOffset < 12) fail('Invalid ofs-delta base offset');
      baseObject = byOffset.get(baseOffset)?.object;
      if (!baseObject) fail(`Missing ofs-delta base at pack offset ${baseOffset}`);
    } else if (typeCode === 7) {
      refBaseOid = readOid(buf, state.offset);
      state.offset += 20;
      const earlier = objects.get(refBaseOid);
      baseObject = earlier ?? resolveBase?.(refBaseOid);
      if (!baseObject) fail(`Missing ref-delta base object ${refBaseOid}`);
    } else if (!CODE_TO_TYPE[typeCode]) {
      fail(`Invalid pack entry type ${typeCode}`);
    }

    if (state.offset > trailerOffset) fail('Truncated pack entry header');
    const inflated = findInflatedEntry(buf, state.offset, trailerOffset, declaredSize);
    state.offset += inflated.compressedLength;

    let object: GitObject;
    if (typeCode === 6 || typeCode === 7) {
      if (!baseObject) fail('Missing delta base object');
      object = { type: baseObject.type, data: applyDelta(baseObject.data, inflated.data) };
      deltaCount++;
    } else {
      object = { type: CODE_TO_TYPE[typeCode], data: inflated.data };
    }

    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryStart, { oid, object });
  }

  if (state.offset !== trailerOffset) fail('Unexpected data between pack entries and trailer');
  return { objects, deltaCount };
}

function encodePackSize(typeCode: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0) fail('Invalid pack object size');
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: ReadonlyArray<{ type: ObjType; data: Buffer }>): Buffer {
  if (objects.length > 0xffffffff) fail('Too many objects for a packfile');
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);

  for (const object of objects) {
    const typeCode = TYPE_TO_CODE[object.type];
    if (!typeCode) fail(`Invalid Git object type: ${String(object.type)}`);
    chunks.push(encodePackSize(typeCode, object.data.length));
    chunks.push(deflateSync(object.data));
  }

  const body = Buffer.concat(chunks);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

function parsePersonLine(value: string, label: string): { person: string; timestamp: number } {
  const match = /^(.*) (-?[0-9]+) ([+-][0-9]{4})$/.exec(value);
  if (!match) fail(`Malformed ${label} header`);
  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp)) fail(`Invalid ${label} timestamp`);
  return { person: match[1], timestamp };
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const separator = text.indexOf('\n\n');
  if (separator < 0) fail('Commit is missing its header/message separator');
  const headers = text.slice(0, separator).split('\n');
  let tree: string | undefined;
  const parents: string[] = [];
  let author: string | undefined;
  let committer: string | undefined;
  let timestamp: number | undefined;

  for (const line of headers) {
    if (line.startsWith('tree ')) {
      const oid = line.slice(5);
      if (!isObjectId(oid)) fail('Malformed commit tree id');
      tree = oid;
    } else if (line.startsWith('parent ')) {
      const oid = line.slice(7);
      if (!isObjectId(oid)) fail('Malformed commit parent id');
      parents.push(oid);
    } else if (line.startsWith('author ')) {
      author = parsePersonLine(line.slice(7), 'author').person;
    } else if (line.startsWith('committer ')) {
      const parsed = parsePersonLine(line.slice(10), 'committer');
      committer = parsed.person;
      timestamp = parsed.timestamp;
    }
  }

  if (!tree) fail('Commit is missing its tree header');
  if (author === undefined) fail('Commit is missing its author header');
  if (committer === undefined || timestamp === undefined) fail('Commit is missing its committer header');
  return {
    tree,
    parents,
    author,
    committer,
    timestamp,
    message: text.slice(separator + 2),
  };
}

function validateTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp)) fail('Timestamp must be a safe integer');
}

export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  oidToBuffer(opts.tree);
  for (const parent of opts.parents) oidToBuffer(parent);
  validateTimestamp(opts.timestamp);
  const lines = [
    `tree ${opts.tree}\n`,
    ...opts.parents.map((parent) => `parent ${parent}\n`),
    `author ${opts.author} ${opts.timestamp} +0000\n`,
    `committer ${opts.committer} ${opts.timestamp} +0000\n`,
    '\n',
    opts.message,
  ];
  return Buffer.from(lines.join(''), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) fail('Malformed tree entry mode');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) fail('Malformed tree entry name');
    const oidOffset = nul + 1;
    if (oidOffset + 20 > data.length) fail('Truncated tree entry object id');
    const mode = data.toString('ascii', offset, space);
    if (!/^[0-7]+$/.test(mode)) fail('Malformed tree entry mode');
    const name = data.toString('utf8', space + 1, nul);
    if (name.length === 0) fail('Empty tree entry name');
    entries.push({ mode, name, oid: readOid(data, oidOffset) });
    offset = oidOffset + 20;
  }
  return entries;
}

function compareBuffers(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aName = Buffer.from(a.name, 'utf8');
    const bName = Buffer.from(b.name, 'utf8');
    const aKey = Buffer.concat([
      aName,
      a.mode === '40000' ? Buffer.from('/') : Buffer.alloc(0),
    ]);
    const bKey = Buffer.concat([
      bName,
      b.mode === '40000' ? Buffer.from('/') : Buffer.alloc(0),
    ]);
    const common = Math.min(aKey.length, bKey.length);
    for (let i = 0; i < common; i++) {
      if (aKey[i] !== bKey[i]) return aKey[i] - bKey[i];
    }
    if (aKey.length === bKey.length) return 0;
    if (aKey.length < bKey.length) {
      return a.mode === '40000' ? 47 - bKey[aKey.length] : 0 - bKey[aKey.length];
    }
    return aKey[a.length === 0 ? 0 : bKey.length] - (b.mode === '40000' ? 47 : 0);
  });

  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    if (!/^[0-7]+$/.test(entry.mode)) fail(`Invalid tree mode: ${entry.mode}`);
    if (entry.name.length === 0 || entry.name.includes('\0') || entry.name.includes('/')) {
      fail(`Invalid tree entry name: ${entry.name}`);
    }
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    chunks.push(oidToBuffer(entry.oid));
  }
  return Buffer.concat(chunks);
}

export interface ParsedTag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const separator = text.indexOf('\n\n');
  if (separator < 0) fail('Tag is missing its header/message separator');
  let object: string | undefined;
  let type: ObjType | undefined;
  let tag: string | undefined;
  let tagger: string | undefined;

  for (const line of text.slice(0, separator).split('\n')) {
    if (line.startsWith('object ')) {
      object = line.slice(7);
      if (!isObjectId(object)) fail('Malformed tag object id');
    } else if (line.startsWith('type ')) {
      const value = line.slice(5);
      if (!(value in TYPE_TO_CODE)) fail(`Invalid tag object type: ${value}`);
      type = value as ObjType;
    } else if (line.startsWith('tag ')) {
      tag = line.slice(4);
    } else if (line.startsWith('tagger ')) {
      tagger = parsePersonLine(line.slice(7), 'tagger').person;
    }
  }
  if (!object) fail('Tag is missing its object header');
  if (!type) fail('Tag is missing its type header');
  if (tag === undefined) fail('Tag is missing its tag header');
  if (tagger === undefined) fail('Tag is missing its tagger header');
  return { object, type, tag, tagger, message: text.slice(separator + 2) };
}

export function buildTag(opts: {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  timestamp: number;
  message: string;
}): Buffer {
  oidToBuffer(opts.object);
  if (!(opts.type in TYPE_TO_CODE)) fail(`Invalid tag object type: ${String(opts.type)}`);
  validateTimestamp(opts.timestamp);
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${opts.tagger} ${opts.timestamp} +0000\n\n${opts.message}`,
    'utf8',
  );
}

function getCommit(get: ObjectGetter, oid: string): ParsedCommit | undefined {
  const object = get(oid);
  if (!object) return undefined;
  if (object.type !== 'commit') fail(`Object ${oid} is not a commit`);
  return parseCommit(object.data);
}

export function walkCommits(
  get: ObjectGetter,
  tips: readonly string[],
  opts?: { maxDepth?: number; stopAt?: ReadonlySet<string> },
): string[] {
  const maxDepth = opts?.maxDepth ?? Number.POSITIVE_INFINITY;
  if (maxDepth !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxDepth) || maxDepth < 0)) {
    fail('maxDepth must be a non-negative safe integer');
  }
  if (maxDepth === 0) return [];

  const result: string[] = [];
  const emitted = new Set<string>();
  const expandedDepth = new Map<string, number>();

  for (const tip of tips) {
    const stack: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 1 }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const commit = getCommit(get, current.oid);
      if (!commit) continue;

      if (!emitted.has(current.oid)) {
        emitted.add(current.oid);
        result.push(current.oid);
      }
      if (opts?.stopAt?.has(current.oid) || current.depth >= maxDepth) continue;
      const previousDepth = expandedDepth.get(current.oid);
      if (previousDepth !== undefined && previousDepth <= current.depth) continue;
      expandedDepth.set(current.oid, current.depth);

      for (let i = commit.parents.length - 1; i >= 0; i--) {
        stack.push({ oid: commit.parents[i], depth: current.depth + 1 });
      }
    }
  }
  return result;
}

export function collectObjects(
  get: ObjectGetter,
  commits: readonly string[],
  opts?: { excludeCommits?: ReadonlySet<string> },
): Map<string, GitObject> {
  const excluded = new Set<string>();
  const result = new Map<string, GitObject>();

  const addTreeClosure = (root: string, destination: Map<string, GitObject>, blocked?: ReadonlySet<string>): void => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (destination.has(oid) || blocked?.has(oid)) continue;
      const object = get(oid);
      if (!object) continue;
      destination.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  };

  if (opts?.excludeCommits) {
    const pending = [...opts.excludeCommits];
    const seenCommits = new Set<string>();
    while (pending.length > 0) {
      const oid = pending.pop()!;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const object = get(oid);
      if (!object) continue;
      if (object.type !== 'commit') fail(`Object ${oid} is not a commit`);
      excluded.add(oid);
      const parsed = parseCommit(object.data);
      addTreeClosure(parsed.tree, { set: (key: string) => excluded.add(key), has: (key: string) => excluded.has(key) } as Map<string, GitObject>);
      pending.push(...parsed.parents);
    }
  }

  for (const oid of commits) {
    if (excluded.has(oid)) continue;
    const object = get(oid);
    if (!object) continue;
    if (object.type !== 'commit') fail(`Object ${oid} is not a commit`);
    if (!excluded.has(oid)) result.set(oid, object);
    const parsed = parseCommit(object.data);
    addTreeClosure(parsed.tree, result, excluded);
  }
  return result;
}

function commitDistances(get: ObjectGetter, start: string): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: string[] = [start];
  distances.set(start, 0);
  let index = 0;
  while (index < queue.length) {
    const oid = queue[index++];
    const parsed = getCommit(get, oid);
    if (!parsed) continue;
    const distance = distances.get(oid)! + 1;
    for (const parent of parsed.parents) {
      if (distances.has(parent)) continue;
      distances.set(parent, distance);
      queue.push(parent);
    }
  }
  return distances;
}

export function isAncestor(get: ObjectGetter, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  let index = 0;
  while (index < queue.length) {
    const oid = queue[index++];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(get, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return false;
}

export function mergeBase(get: ObjectGetter, a: string, b: string): string | null {
  const distancesA = commitDistances(get, a);
  const distancesB = commitDistances(get, b);
  let best: string | null = null;
  let bestSum = Number.POSITIVE_INFINITY;
  let bestA = Number.POSITIVE_INFINITY;
  for (const [oid, distanceA] of distancesA) {
    const distanceB = distancesB.get(oid);
    if (distanceB === undefined) continue;
    const sum = distanceA + distanceB;
    if (sum < bestSum || (sum === bestSum && distanceA < bestA)) {
      best = oid;
      bestSum = sum;
      bestA = distanceA;
    }
  }
  return best;
}
