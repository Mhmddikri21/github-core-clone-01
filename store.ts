// In-memory Git forge store
import {
  ZERO_OID,
  hashObject,
  parseCommit,
  buildCommit,
  parseTree,
  buildTree,
  mergeBase,
  walkCommits,
  isObjectId,
} from './git.ts';
import type { ObjType, GitObject, ObjectGetter, TreeEntry } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FIXED_DATE = '2025-01-01T00:00:00Z';
export const FIXED_TS = 1735689600;
export const DEFAULT_BRANCH = 'main';
export const AUTHOR_STRING = 'ada iversen <adaiversen@example.invalid>';
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
];

function encodeGlobal(prefix: string, value: string): string {
  return prefix + Buffer.from(value, 'utf8').toString('base64url');
}

export function repoGlobalId(owner: string, name: string): string {
  return encodeGlobal('R_', `repo:${owner}/${name}`);
}

export function issueGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobal('I_', `issue:${owner}/${name}#${number}`);
}

export function pullGlobalId(owner: string, name: string, number: number): string {
  return encodeGlobal('P_', `pr:${owner}/${name}#${number}`);
}

export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return encodeGlobal('C_', `comment:${owner}/${name}#${issueNumber}:${commentId}`);
}

export function decodeGlobalId(
  id: string,
): { kind: 'repo' | 'issue' | 'pr' | 'comment'; owner: string; name: string; number?: number; commentId?: number } | null {
  if (typeof id !== 'string') return null;
  const prefixes: Record<string, string> = { R_: 'repo', I_: 'issue', P_: 'pr', C_: 'comment' };
  const prefix = id.slice(0, 2);
  const expectedKind = prefixes[prefix];
  if (!expectedKind || id.length <= 2) return null;
  try {
    const encoded = id.slice(2);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return null;
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const namespace = decoded.slice(0, colon);
    if (namespace !== expectedKind && !(namespace === 'pr' && expectedKind === 'pr')) return null;
    const payload = decoded.slice(colon + 1);
    if (expectedKind === 'repo') {
      const slash = payload.indexOf('/');
      if (slash <= 0 || slash === payload.length - 1) return null;
      return { kind: 'repo', owner: payload.slice(0, slash), name: payload.slice(slash + 1) };
    }
    const hash = payload.lastIndexOf('#');
    if (hash <= 0 || hash === payload.length - 1) return null;
    const fullName = payload.slice(0, hash);
    const slash = fullName.indexOf('/');
    if (slash <= 0 || slash === fullName.length - 1) return null;
    const owner = fullName.slice(0, slash);
    const name = fullName.slice(slash + 1);
    const suffix = payload.slice(hash + 1);
    if (expectedKind === 'comment') {
      const separator = suffix.lastIndexOf(':');
      if (separator <= 0 || separator === suffix.length - 1) return null;
      const number = Number(suffix.slice(0, separator));
      const commentId = Number(suffix.slice(separator + 1));
      if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(commentId) || commentId < 1) return null;
      return { kind: 'comment', owner, name, number, commentId };
    }
    const number = Number(suffix);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return { kind: expectedKind as 'issue' | 'pr', owner, name, number };
  } catch {
    return null;
  }
}

export interface RepoLabel {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  userLogin: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: RepoLabel[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextLabelId: number;
  shallow: Set<string>;
  createdAt: string;
  updatedAt: string;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

type TreeValue = { oid: string; mode: string };

function sameTreeValue(a: TreeValue | undefined, b: TreeValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

export function mergeTrees(
  base: Map<string, { oid: string; mode: string }>,
  ours: Map<string, { oid: string; mode: string }>,
  theirs: Map<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }>; conflicts: string[] } {
  const merged = new Map<string, TreeValue>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let chosen: TreeValue | undefined;
    if (sameTreeValue(o, t)) chosen = o;
    else if (sameTreeValue(o, b)) chosen = t;
    else if (sameTreeValue(t, b)) chosen = o;
    else {
      conflicts.push(path);
      chosen = o;
    }
    if (chosen !== undefined) merged.set(path, { oid: chosen.oid, mode: chosen.mode });
  }
  conflicts.sort();
  return { merged, conflicts };
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  const newCounts = new Map<string, number>();
  for (const line of splitLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  for (const line of splitLines(newText)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

function blobBytes(get: ObjectGetter, oid: string | undefined): Buffer | null {
  if (!oid) return null;
  const obj = get(oid);
  if (!obj || obj.type !== 'blob') return null;
  const data = (obj as GitObject & { data?: Buffer }).data;
  return Buffer.isBuffer(data) ? data : null;
}

export function diffFileChanges(get: ObjectGetter, baseTree: string | null, headTree: string | null): FileChange[] {
  const flatten = (treeOid: string | null): Map<string, TreeValue> => {
    const result = new Map<string, TreeValue>();
    if (treeOid === null) return result;
    const visit = (oid: string, prefix: string): void => {
      const object = get(oid);
      if (!object || object.type !== 'tree') return;
      const data = (object as GitObject & { data?: Buffer }).data;
      if (!Buffer.isBuffer(data)) return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (String(entry.mode).replace(/^0+/, '').startsWith('40000') || String(entry.mode) === '040000') {
          visit(entry.oid, path);
        } else {
          result.set(path, { oid: entry.oid, mode: String(entry.mode) });
        }
      }
    };
    visit(treeOid, '');
    return result;
  };

  const base = flatten(baseTree);
  const head = flatten(headTree);
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const filename of paths) {
    const before = base.get(filename);
    const after = head.get(filename);
    if (before && after && before.oid === after.oid) continue;
    const oldBytes = before ? blobBytes(get, before.oid) : null;
    const newBytes = after ? blobBytes(get, after.oid) : null;
    let status: FileChange['status'];
    let additions = 0;
    let deletions = 0;
    if (!before && after) {
      status = 'added';
      if (newBytes?.includes(0)) additions = 1;
      else additions = newBytes ? splitLines(newBytes.toString('utf8')).length : 0;
    } else if (before && !after) {
      status = 'removed';
      if (oldBytes?.includes(0)) deletions = 1;
      else deletions = oldBytes ? splitLines(oldBytes.toString('utf8')).length : 0;
    } else {
      status = 'modified';
      if (oldBytes?.includes(0) || newBytes?.includes(0)) {
        additions = 0;
        deletions = 0;
      } else {
        const counts = lineDiffCounts(oldBytes?.toString('utf8') ?? '', newBytes?.toString('utf8') ?? '');
        additions = counts.additions;
        deletions = counts.deletions;
      }
    }
    changes.push({ filename, status, additions, deletions, changes: additions + deletions });
  }
  changes.sort((a, b) => a.filename.localeCompare(b.filename));
  return changes;
}

function objectData(object: GitObject | undefined): Buffer | null {
  if (!object) return null;
  const data = (object as GitObject & { data?: Buffer }).data;
  return Buffer.isBuffer(data) ? data : null;
}

function isTreeMode(mode: string): boolean {
  return mode.replace(/^0+/, '').startsWith('40000') || mode === '040000';
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 1;
  nextCommentId = 1;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  key(owner: string, name: string): string {
    return Store.key(owner, name);
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data } as GitObject);
    return oid;
  }

  objectGetter(): ObjectGetter {
    return (oid: string) => this.objects.get(oid);
  }

  createRepo(owner: string, name: string, opts: { description?: string; isPrivate?: boolean }): Repo | null {
    const key = Store.key(owner, name);
    if (this.repos.has(key)) return null;
    const labels = DEFAULT_LABELS.map((label, index) => ({
      id: index + 1,
      name: label.name,
      color: label.color,
      description: '',
    }));
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      fullName: key,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      issues: [],
      pulls: [],
      labels,
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextLabelId: 7,
      shallow: new Set(),
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    let full = ref;
    if (ref === 'HEAD') full = `refs/heads/${repo.defaultBranch}`;
    else if (!ref.startsWith('refs/')) full = `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    repo.refs.set(full, oid);
    repo.updatedAt = FIXED_DATE;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const deleted = repo.refs.delete(full);
    if (deleted) repo.updatedAt = FIXED_DATE;
    return deleted;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    return [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), sha }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  headSymrefTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  createCommit(repo: Repo, opts: { tree: string; parents: readonly string[]; message: string }): string {
    if (typeof opts?.tree !== 'string' || !opts.tree) throw new Error('Invalid tree field: expected an object id');
    if (!Array.isArray(opts.parents)) throw new Error('Invalid parents field: expected an array of object ids');
    if (!isObjectId(opts.tree)) throw new Error(`Invalid tree field: ${String(opts.tree)}`);
    for (let index = 0; index < opts.parents.length; index++) {
      const parent = opts.parents[index];
      if (typeof parent !== 'string' || !parent) throw new Error(`Invalid parents[${index}] field: expected an object id`);
      if (!isObjectId(parent)) throw new Error(`Invalid parents[${index}] field: ${parent}`);
    }
    const input = {
      tree: opts.tree,
      parents: [...opts.parents],
      author: AUTHOR_STRING,
      committer: AUTHOR_STRING,
      authorTimestamp: FIXED_TS,
      committerTimestamp: FIXED_TS,
      timestamp: FIXED_TS,
      message: opts.message,
    };
    const builder = buildCommit as unknown as (...args: unknown[]) => Buffer;
    let data: Buffer;
    if (buildCommit.length <= 1) {
      data = builder(input);
    } else {
      data = builder(opts.tree, [...opts.parents], AUTHOR_STRING, AUTHOR_STRING, opts.message, FIXED_TS);
    }
    if (!Buffer.isBuffer(data)) throw new Error('buildCommit did not return commit data');
    return this.putObject('commit' as ObjType, data);
  }

  commitTree(_repo: Repo, commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    const data = objectData(object);
    if (!object || object.type !== 'commit' || !data) return null;
    try {
      const parsed = parseCommit(data) as { tree?: string };
      return typeof parsed.tree === 'string' ? parsed.tree : null;
    } catch {
      return null;
    }
  }

  walkRepoCommits(repo: Repo, tip: string, opts?: { maxDepth?: number; stopAt?: ReadonlySet<string> }): string[] {
    return walkCommits(this.objectGetter(), tip, opts) as string[];
  }

  flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
    const result = new Map<string, TreeValue>();
    if (treeOid === null) return result;
    const visit = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      const data = objectData(object);
      if (!data) return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const mode = String(entry.mode);
        if (isTreeMode(mode)) visit(entry.oid, path);
        else result.set(path, { oid: entry.oid, mode });
      }
    };
    visit(treeOid, '');
    return result;
  }

  buildTreeFromMap(entries: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Array<{ name: string; oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: [], dirs: new Map() };
    for (const [path, value] of entries) {
      if (!path || typeof value?.oid !== 'string' || !value.oid) continue;
      const segments = path.split('/').filter((segment) => segment.length > 0);
      if (segments.length === 0) continue;
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (!child) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.push({ name: segments[segments.length - 1], oid: value.oid, mode: value.mode || '100644' });
    }
    const build = (node: Node): string => {
      const treeEntries: TreeEntry[] = [];
      for (const file of node.files) treeEntries.push({ mode: file.mode, name: file.name, oid: file.oid });
      for (const [name, child] of node.dirs) {
        const oid = build(child);
        treeEntries.push({ mode: '40000', name, oid });
      }
      const data = buildTree(treeEntries);
      if (!Buffer.isBuffer(data)) throw new Error('buildTree did not return tree data');
      return this.putObject('tree' as ObjType, data);
    };
    return build(root);
  }

  getPathBlob(treeOid: string | null, path: string): { oid: string; mode: string } | null {
    if (!treeOid || !path) return null;
    const normalized = path.split('/').filter(Boolean);
    if (normalized.length === 0) return null;
    let current = treeOid;
    for (let index = 0; index < normalized.length; index++) {
      const object = this.objects.get(current);
      const data = objectData(object);
      if (!object || object.type !== 'tree' || !data) return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(data);
      } catch {
        return null;
      }
      const entry = entries.find((candidate) => candidate.name === normalized[index]);
      if (!entry) return null;
      if (index === normalized.length - 1) {
        if (isTreeMode(String(entry.mode))) return null;
        return { oid: entry.oid, mode: String(entry.mode) };
      }
      if (!isTreeMode(String(entry.mode))) return null;
      current = entry.oid;
    }
    return null;
  }

  setPathBlob(treeOid: string | null, path: string, blobOid: string | null): string {
    const entries = this.flattenTree(treeOid);
    const normalized = path.split('/').filter(Boolean).join('/');
    if (!normalized) return this.buildTreeFromMap(entries);
    if (blobOid === null) entries.delete(normalized);
    else entries.set(normalized, { oid: blobOid, mode: '100644' });
    return this.buildTreeFromMap(entries);
  }

  putContent(
    repo: Repo,
    opts: { path: string; content: Buffer; message: string; branch?: string },
  ): { commitSha: string; blobSha: string } {
    const branch = opts.branch ?? repo.defaultBranch;
    const parent = this.resolveRef(repo, branch);
    const parentTree = parent ? this.commitTree(repo, parent) : null;
    const blobSha = this.putObject('blob' as ObjType, opts.content);
    const tree = this.setPathBlob(parentTree, opts.path, blobSha);
    if (!tree || !isObjectId(tree)) throw new Error('Invalid tree field produced by setPathBlob');
    const commitSha = this.createCommit(repo, { tree, parents: parent ? [parent] : [], message: opts.message });
    this.setRef(repo, branch, commitSha);
    return { commitSha, blobSha };
  }

  deleteContent(repo: Repo, opts: { path: string; message: string; branch?: string }): { commitSha: string } | null {
    const branch = opts.branch ?? repo.defaultBranch;
    const parent = this.resolveRef(repo, branch);
    if (!parent) return null;
    const tree = this.commitTree(repo, parent);
    if (!tree || !this.getPathBlob(tree, opts.path)) return null;
    const newTree = this.setPathBlob(tree, opts.path, null);
    if (!newTree || !isObjectId(newTree)) throw new Error('Invalid tree field produced by setPathBlob');
    const commitSha = this.createCommit(repo, { tree: newTree, parents: [parent], message: opts.message });
    this.setRef(repo, branch, commitSha);
    return { commitSha };
  }

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    const labels = opts.labels ?? [];
    for (const label of labels) {
      if (!repo.labels.some((item) => item.name === label)) return { error: `unknown label: ${label}` };
    }
    const id = this.nextIssueId++;
    const issue: Issue = {
      id,
      number: repo.nextIssueNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels: [...labels],
      comments: [],
      userLogin: VIEWER_LOGIN,
      seq: id,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      closedAt: null,
    };
    repo.issues.push(issue);
    repo.updatedAt = FIXED_DATE;
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, opts?: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' }): Issue[] {
    const state = opts?.state ?? 'open';
    const direction = opts?.direction ?? 'desc';
    return repo.issues
      .filter((issue) => state === 'all' || issue.state === state)
      .slice()
      .sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }

  patchIssue(repo: Repo, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string }): Issue | null {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined && patch.state !== issue.state) {
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? FIXED_DATE : null;
    }
    issue.updatedAt = FIXED_DATE;
    repo.updatedAt = FIXED_DATE;
    return issue;
  }

  addIssueComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const comment: IssueComment = {
      id: this.nextCommentId++,
      body,
      userLogin: VIEWER_LOGIN,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
    };
    issue.comments.push(comment);
    issue.updatedAt = FIXED_DATE;
    repo.updatedAt = FIXED_DATE;
    return comment;
  }

  createLabel(repo: Repo, opts: { name: string; color?: string; description?: string }): RepoLabel | { error: string } {
    if (repo.labels.some((label) => label.name === opts.name)) return { error: 'label already exists' };
    const label: RepoLabel = {
      id: repo.nextLabelId++,
      name: opts.name,
      color: opts.color ?? 'ededed',
      description: opts.description ?? '',
    };
    repo.labels.push(label);
    repo.updatedAt = FIXED_DATE;
    return label;
  }

  getLabel(repo: Repo, name: string): RepoLabel | undefined {
    return repo.labels.find((label) => label.name === name);
  }

  createPull(repo: Repo, opts: { title: string; body?: string; head: string; base: string }): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, opts.head);
    if (!headSha) return { error: 'unknown head branch' };
    const baseSha = this.resolveRef(repo, opts.base);
    if (!baseSha) return { error: 'unknown base branch' };
    const id = this.nextIssueId++;
    const pull: PullRequest = {
      id,
      number: repo.nextPullNumber++,
      title: opts.title,
      body: opts.body ?? '',
      headRef: opts.head,
      baseRef: opts.base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: VIEWER_LOGIN,
      seq: id,
      createdAt: FIXED_DATE,
      updatedAt: FIXED_DATE,
      closedAt: null,
    };
    repo.pulls.push(pull);
    repo.updatedAt = FIXED_DATE;
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, opts?: { state?: 'open' | 'closed' | 'all' }): PullRequest[] {
    const state = opts?.state ?? 'open';
    return repo.pulls
      .filter((pull) => state === 'all' || pull.state === state)
      .slice()
      .sort((a, b) => a.seq - b.seq);
  }

  mergeBaseOf(repo: Repo, pr: PullRequest): string | null {
    if (!this.objects.has(pr.headSha) || !this.objects.has(pr.baseSha)) return null;
    try {
      const result = mergeBase(this.objectGetter(), pr.headSha, pr.baseSha);
      return typeof result === 'string' && result !== ZERO_OID ? result : null;
    } catch {
      return null;
    }
  }

  pullFiles(repo: Repo, pr: PullRequest): FileChange[] {
    const base = this.mergeBaseOf(repo, pr);
    const baseTree = base ? this.commitTree(repo, base) : null;
    const headTree = this.commitTree(repo, pr.headSha);
    return diffFileChanges(this.objectGetter(), baseTree, headTree);
  }

  pullMergeable(repo: Repo, pr: PullRequest): boolean {
    const headTree = this.commitTree(repo, pr.headSha);
    const baseTip = this.resolveRef(repo, pr.baseRef) ?? pr.baseSha;
    const baseTree = this.commitTree(repo, baseTip);
    const mergeBaseOid = this.objects.has(baseTip) && this.objects.has(pr.headSha)
      ? (() => {
          try {
            const result = mergeBase(this.objectGetter(), baseTip, pr.headSha);
            return typeof result === 'string' && result !== ZERO_OID ? result : null;
          } catch {
            return null;
          }
        })()
      : null;
    if (!mergeBaseOid) return true;
    const ancestorTree = this.commitTree(repo, mergeBaseOid);
    if (ancestorTree === null || baseTree === null || headTree === null) return false;
    const result = mergeTrees(
      this.flattenTree(ancestorTree),
      this.flattenTree(baseTree),
      this.flattenTree(headTree),
    );
    return result.conflicts.length === 0;
  }

  squashMerge(repo: Repo, pr: PullRequest, opts?: { message?: string }): { sha: string; message: string } | { error: string } {
    if (pr.state !== 'open') return { error: 'pull request is not open' };
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (!baseTip) return { error: 'unknown base branch' };
    const headTree = this.commitTree(repo, pr.headSha);
    const baseTree = this.commitTree(repo, baseTip);
    if (headTree === null || baseTree === null) return { error: 'merge conflict' };

    const mergeBaseOid = this.objects.has(baseTip) && this.objects.has(pr.headSha)
      ? (() => {
          try {
            const result = mergeBase(this.objectGetter(), baseTip, pr.headSha);
            return typeof result === 'string' && result !== ZERO_OID ? result : null;
          } catch {
            return null;
          }
        })()
      : null;

    let mergedTree: string;
    if (!mergeBaseOid) {
      mergedTree = headTree;
    } else {
      const ancestorTree = this.commitTree(repo, mergeBaseOid);
      if (ancestorTree === null) return { error: 'merge conflict' };
      const merged = mergeTrees(
        this.flattenTree(ancestorTree),
        this.flattenTree(baseTree),
        this.flattenTree(headTree),
      );
      if (merged.conflicts.length > 0) return { error: 'merge conflict' };
      mergedTree = this.buildTreeFromMap(merged.merged);
    }
    if (!mergedTree || !isObjectId(mergedTree)) return { error: 'merge conflict' };
    const message = opts?.message ?? `Merge pull request #${pr.number} from ${pr.headRef}`;
    const sha = this.createCommit(repo, { tree: mergedTree, parents: [baseTip], message });
    this.setRef(repo, pr.baseRef, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_DATE;
    pr.mergeCommitSha = sha;
    pr.closedAt = FIXED_DATE;
    pr.updatedAt = FIXED_DATE;
    repo.updatedAt = FIXED_DATE;
    return { sha, message };
  }
}

export function createStore(): Store {
  return new Store();
}
