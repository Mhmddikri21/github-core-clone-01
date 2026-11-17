import {
  FIXED_DATE,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_EMAIL,
  VIEWER_NAME,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
} from './store.ts';
import type { Store, Repo, Issue, IssueComment, PullRequest } from './store.ts';

type GqlError = { message: string; path?: (string | number)[] };
type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type FieldNode = {
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selection?: FieldNode[];
  inlineType?: string;
};
type Operation = {
  kind: 'query' | 'mutation';
  name?: string;
  variables: { name: string; type: TypeNode; defaultValue?: ValueNode }[];
  selection: FieldNode[];
};
type TypeNode = { name?: string; list?: TypeNode; nonNull?: boolean };

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function decodeGlobalId(id: unknown): { kind: string; payload: string } | null {
  if (typeof id !== 'string') return null;
  const i = id.indexOf('_');
  if (i < 1) return null;
  const payload = b64urlDecode(id.slice(i + 1));
  if (payload === null) return null;
  const kind = id.slice(0, i);
  const prefix: Record<string, string> = {
    R: 'repo:',
    I: 'issue:',
    P: 'pr:',
    C: 'comment:',
    U: 'user:',
  };
  if (!prefix[kind] || !payload.startsWith(prefix[kind])) return null;
  return { kind, payload: payload.slice(prefix[kind].length) };
}

function lex(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c) || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      out.push('...');
      i += 3;
      continue;
    }
    if (c === '"') {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('Unterminated string');
      out.push(source.slice(start, i));
      continue;
    }
    if ('!$():=@[]{|}&'.includes(c)) {
      out.push(c);
      i++;
      continue;
    }
    const number = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      out.push(number[0]);
      i += number[0].length;
      continue;
    }
    const name = source.slice(i).match(/^[_A-Za-z][_0-9A-Za-z]*/);
    if (name) {
      out.push(name[0]);
      i += name[0].length;
      continue;
    }
    throw new Error(`Unexpected character "${c}"`);
  }
  return out;
}

class Parser {
  private i = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;}
  private peek(): string | undefined {
    return this.tokens[this.i];
  }
  private take(): string {
    const t = this.tokens[this.i++];
    if (t === undefined) throw new Error('Unexpected end of query');
    return t;
  }
  private expect(expected: string): void {
    const got = this.take();
    if (got !== expected) throw new Error(`Expected "${expected}", found "${got}"`);
  }
  private isName(t: string | undefined): boolean {
    return !!t && /^[_A-Za-z][_0-9A-Za-z]*$/.test(t);
  }
  parse(): { operations: Operation[]; fragments: Record<string, { type: string; selection: FieldNode[] }> } {
    const operations: Operation[] = [];
    const fragments: Record<string, { type: string; selection: FieldNode[] }> = {};
    while (this.peek() !== undefined) {
      if (this.peek() === 'fragment') {
        this.take();
        const name = this.take();
        if (!this.isName(name) || name === 'on') throw new Error('Expected fragment name');
        this.expect('on');
        const type = this.take();
        this.expect('{');
        fragments[name] = { type, selection: this.parseSelectionBody() };
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (!operations.length) throw new Error('A query must contain at least one operation');
    return { operations, fragments };
  }
  private parseOperation(): Operation {
    if (this.peek() === '{') {
      this.take();
      return { kind: 'query', variables: [], selection: this.parseSelectionBody() };
    }
    const keyword = this.take();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new Error(`Unexpected token "${keyword}"`);
    }
    let name: string | undefined;
    if (this.isName(this.peek()) && this.peek() !== 'on') name = this.take();
    const variables: Operation['variables'] = [];
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') {
        this.expect('$');
        const vname = this.take();
        this.expect(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek() === '=') {
          this.take();
          defaultValue = this.parseValue();
        }
        variables.push({ name: vname, type, defaultValue });
      }
      this.expect(')');
    }
    this.expect('{');
    return { kind: keyword, name, variables, selection: this.parseSelectionBody() };
  }
  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.peek() === '[') {
      this.take();
      const list = this.parseType();
      this.expect(']');
      type = { list };
    } else {
      type = { name: this.take() };
    }
    if (this.peek() === '!') {
      this.take();
      type.nonNull = true;
    }
    return type;
  }
  private parseSelectionBody(): FieldNode[] {
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('Expected "}", found end of query');
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') {
          this.take();
          const inlineType = this.take();
          this.expect('{');
          fields.push({ name: '...', args: {}, selection: this.parseSelectionBody(), inlineType });
        } else {
          const name = this.take();
          fields.push({ name: `...${name}`, args: {} });
        }
        continue;
      }
      let first = this.take();
      if (!this.isName(first)) throw new Error(`Expected field name, found "${first}"`);
      let alias: string | undefined;
      let name = first;
      if (this.peek() === ':') {
        this.take();
        alias = first;
        name = this.take();
        if (!this.isName(name)) throw new Error(`Expected field name, found "${name}"`);
      }
      const args: Record<string, ValueNode> = {};
      if (this.peek() === '(') {
        this.take();
        while (this.peek() !== ')') {
          const arg = this.take();
          if (!this.isName(arg)) throw new Error(`Expected argument name, found "${arg}"`);
          this.expect(':');
          args[arg] = this.parseValue();
        }
        this.expect(')');
      }
      let selection: FieldNode[] | undefined;
      if (this.peek() === '{') {
        this.take();
        selection = this.parseSelectionBody();
      }
      fields.push({ name, alias, args, selection });
    }
    this.expect('}');
    return fields;
  }
  private parseValue(): ValueNode {
    const t = this.take();
    if (t === '$') return { kind: 'variable', name: this.take() };
    if (t === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const key = this.take();
        if (!this.isName(key)) throw new Error(`Expected input field name, found "${key}"`);
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) {
      try {
        return { kind: 'scalar', value: JSON.parse(t) };
      } catch {
        throw new Error('Invalid string literal');
      }
    }
    if (t === 'true') return { kind: 'scalar', value: true };
    if (t === 'false') return { kind: 'scalar', value: false };
    if (t === 'null') return { kind: 'scalar', value: null };
    if (/^-?\d+$/.test(t)) return { kind: 'scalar', value: Number(t) };
    if (/^-?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
      return { kind: 'scalar', value: Number(t) };
    }
    if (this.isName(t)) return { kind: 'scalar', value: t };
    throw new Error(`Unexpected value "${t}"`);
  }
}

const enumValues: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'LABEL'],
};

const inputFields: Record<string, Record<string, string>> = {
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  CloseIssueInput: { issueId: 'ID!', clientMutationId: 'String' },
  CreatePullRequestInput: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String', clientMutationId: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
};

const typeFields: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['name', 'prefix'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'inputFields'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const allTypeNames = [
  ...Object.keys(typeFields),
  ...Object.keys(enumValues),
  ...Object.keys(inputFields),
  'String', 'Int', 'Float', 'Boolean', 'ID',
];

const outputTypes: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', description: 'String', isPrivate: 'Boolean', createdAt: 'String', updatedAt: 'String', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'IssueState', createdAt: 'String', updatedAt: 'String', closedAt: 'String', author: 'User', comments: 'IssueCommentConnection', labels: 'Label' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'CommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequest: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', mergeable: 'MergeableState', headRefName: 'String', baseRefName: 'String', headRefOid: 'String', baseRefOid: 'String', files: 'PullRequestChangedFileConnection', createdAt: 'String', updatedAt: 'String', mergedAt: 'String', author: 'User' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changes: 'Int', status: 'String' },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Ref: { name: 'String', prefix: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', subject: 'Issue', clientMutationId: 'String' },
  CommentEdge: { node: 'IssueComment', cursor: 'String' },
  __Type: { kind: 'String', name: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue' },
  __Field: { name: 'String', description: 'String', args: '__InputValue', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

const allowedArgs: Record<string, string[]> = {
  'Query.repository': ['owner', 'name'],
  'Query.node': ['id'],
  'Query.__type': ['name'],
  'Repository.issue': ['number'],
  'Repository.issues': ['first', 'states', 'orderBy', 'after'],
  'Repository.pullRequests': ['first', 'after', 'states'],
  'Repository.pullRequest': ['number'],
  'Issue.comments': ['first'],
  'PullRequest.files': ['first'],
  'Mutation.createIssue': ['input'],
  'Mutation.closeIssue': ['input'],
  'Mutation.createPullRequest': ['input'],
  'Mutation.mergePullRequest': ['input'],
  'Mutation.addComment': ['input'],
  '__Type.fields': ['includeDeprecated'],
  '__Type.enumValues': ['includeDeprecated'],
  '__Type.inputFields': ['includeDeprecated'],
};

type RuntimeValue = any;
type ResolveResult = { value: RuntimeValue; type?: string; repo?: Repo; idOverride?: string };

function typeKind(name: string): string {
  if (enumValues[name]) return 'ENUM';
  if (inputFields[name]) return 'INPUT_OBJECT';
  if (typeFields[name]) return 'OBJECT';
  return 'SCALAR';
}
function introspectionTypeRef(spec: string): any {
  let s = spec;
  if (s.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: introspectionTypeRef(s.slice(0, -1)) };
  if (s.startsWith('[') && s.endsWith(']')) return { kind: 'LIST', name: null, ofType: introspectionTypeRef(s.slice(1, -1)) };
  return { kind: typeKind(s), name: s, ofType: null };
}
function typeSpec(parent: string, field: string): string {
  const custom: Record<string, Record<string, string>> = {
    Repository: { issues: 'IssueConnection', pullRequests: 'PullRequestConnection' },
    Issue: { comments: 'IssueCommentConnection', labels: 'Label' },
    PullRequest: { files: 'PullRequestChangedFileConnection' },
  };
  return custom[parent]?.[field] ?? outputTypes[parent]?.[field] ?? 'String';
}
function typeMetadata(name: string): any {
  if (!allTypeNames.includes(name)) return null;
  return {
    kind: typeKind(name),
    name,
    description: null,
    fields: typeFields[name]
      ? typeFields[name].map((field) => ({
          name: field,
          description: null,
          args: [],
          type: introspectionTypeRef(typeSpec(name, field)),
        }))
      : null,
    enumValues: enumValues[name]
      ? enumValues[name].map((value) => ({ name: value, description: null }))
      : null,
    inputFields: inputFields[name]
      ? Object.entries(inputFields[name]).map(([field, spec]) => ({
          name: field,
          description: null,
          type: introspectionTypeRef(spec),
          defaultValue: null,
        }))
      : null,
  };
}

function makeUser(login: string): any {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    name: login === VIEWER_LOGIN ? VIEWER_NAME : login,
    email: login === VIEWER_LOGIN ? VIEWER_EMAIL : '',
  };
}

function resolveNodeId(store: Store, id: unknown): ResolveResult {
  const decoded = decodeGlobalId(id);
  if (!decoded || typeof id !== 'string') return { value: null };
  const { kind, payload } = decoded;
  if (kind === 'R') {
    const [owner, name] = payload.split('/');
    if (!owner || !name) return { value: null };
    const repo = store.getRepo(owner, name);
    return repo ? { value: repo, type: 'Repository', repo, idOverride: id } : { value: null };
  }
  if (kind === 'I' || kind === 'P') {
    const m = payload.match(/^(.+)\/([^/]+)#(\d+)$/);
    if (!m) return { value: null };
    const repo = store.getRepo(m[1], m[2]);
    if (!repo) return { value: null };
    const number = Number(m[3]);
    if (kind === 'I') {
      const issue = store.getIssue(repo, number);
      return issue ? { value: issue, type: 'Issue', repo, idOverride: id } : { value: null };
    }
    const pr = store.getPull(repo, number);
    return pr ? { value: pr, type: 'PullRequest', repo, idOverride: id } : { value: null };
  }
  if (kind === 'C') {
    const m = payload.match(/^(.+)\/([^/]+)#(\d+):(\d+)$/);
    if (!m) return { value: null };
    const repo = store.getRepo(m[1], m[2]);
    const issue = repo && store.getIssue(repo, Number(m[3]));
    const comment = issue?.comments.find((c) => c.id === Number(m[4]));
    return comment
      ? { value: comment, type: 'IssueComment', repo, idOverride: id }
      : { value: null };
  }
  return { value: null };
}

function valueFromNode(node: ValueNode, vars: Record<string, unknown>): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'variable') {
    if (!Object.prototype.hasOwnProperty.call(vars, node.name)) throw new Error(`Variable "$${node.name}" is not defined.`);
    return vars[node.name];
  }
  if (node.kind === 'list') return node.values.map((v) => valueFromNode(v, vars));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.fields)) result[key] = valueFromNode(value, vars);
  return result;
}

function coerceVariable(value: unknown, type: TypeNode, name: string): unknown {
  if (type.nonNull && (value === null || value === undefined)) {
    throw new Error(`Variable "$${name}" of non-null type was not provided.`);
  }
  if (value === null || value === undefined) return value;
  if (type.list) {
    if (!Array.isArray(value)) throw new Error(`Variable "$${name}" must be a list.`);
    return value.map((v) => coerceVariable(v, type.list!, name));
  }
  const t = type.name;
  if (t === 'String' && typeof value !== 'string') throw new Error(`Variable "$${name}" got invalid value; String expected.`);
  if (t === 'Int' && (typeof value !== 'number' || !Number.isInteger(value))) throw new Error(`Variable "$${name}" got invalid value; Int must be an integer.`);
  if (t === 'Float' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Variable "$${name}" got invalid value; Float expected.`);
  if (t === 'Boolean' && typeof value !== 'boolean') throw new Error(`Variable "$${name}" got invalid value; Boolean expected.`);
  if (t === 'ID') {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Variable "$${name}" got invalid value; ID must be a string or integer.`);
    return String(value);
  }
  return value;
}

function toInt(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function makeConnection<T>(all: T[], selected: T[], numberOf: (item: T) => number, hasNext: boolean): any {
  const edges = selected.map((node) => ({
    node,
    cursor: b64urlEncode(`cursor:${numberOf(node)}`),
  }));
  return {
    nodes: selected,
    edges,
    pageInfo: {
      hasNextPage: hasNext,
      hasPreviousPage: false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount: all.length,
  };
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const decoded = b64urlDecode(cursor);
  const match = decoded?.match(/^cursor:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function getFieldValue(
  store: Store,
  parentType: string,
  parent: any,
  field: FieldNode,
  args: Record<string, any>,
  inheritedRepo: Repo | undefined,
  idOverride: string | undefined,
): ResolveResult {
  const repo: Repo | undefined = parentType === 'Repository' ? parent : inheritedRepo;
  const notFound = (): ResolveResult => ({ value: null });
  switch (parentType) {
    case 'Query':
      if (field.name === 'viewer') return { value: makeUser(VIEWER_LOGIN), type: 'User' };
      if (field.name === 'repository') {
        const found = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return found ? { value: found, type: 'Repository', repo: found } : notFound();
      }
      if (field.name === 'node') return resolveNodeId(store, args.id);
      if (field.name === '__type') return { value: args.name ? typeMetadata(String(args.name)) : null, type: '__Type' };
      if (field.name === '__schema') return { value: {}, type: '__Schema' };
      break;
    case 'Repository':
      switch (field.name) {
        case 'id': return { value: idOverride ?? repoGlobalId(parent.owner, parent.name) };
        case 'databaseId': return { value: parent.id };
        case 'name': return { value: parent.name };
        case 'nameWithOwner': return { value: parent.fullName };
        case 'owner': return { value: { login: parent.owner, id: parent.owner === VIEWER_LOGIN ? VIEWER_ID : 0, name: parent.owner === VIEWER_LOGIN ? VIEWER_NAME : parent.owner }, type: 'User' };
        case 'defaultBranchRef':
          return { value: parent.refs.has(`refs/heads/${parent.defaultBranch}`) ? { name: parent.defaultBranch, prefix: 'refs/heads/' } : null, type: 'Ref' };
        case 'viewerPermission': return { value: 'ADMIN' };
        case 'hasIssuesEnabled': return { value: true };
        case 'description': return { value: parent.description };
        case 'isPrivate': return { value: parent.isPrivate };
        case 'createdAt': return { value: parent.createdAt };
        case 'updatedAt': return { value: parent.updatedAt };
        case 'issue': {
          const issue = store.getIssue(parent, Number(args.number));
          return issue ? { value: issue, type: 'Issue', repo: parent } : notFound();
        }
        case 'pullRequest': {
          const pr = store.getPull(parent, Number(args.number));
          return pr ? { value: pr, type: 'PullRequest', repo: parent } : notFound();
        }
        case 'issues': {
          let issues = store.listIssues(parent, { state: 'all', direction: 'desc' });
          if (args.states !== undefined && args.states !== null) {
            const states = Array.isArray(args.states) ? args.states : [args.states];
            issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const order = args.orderBy ?? {};
          const direction = order.direction === 'ASC' ? 1 : -1;
          if (order.field === 'COMMENTS') {
            issues = [...issues].sort((a, b) => (a.comments.length - b.comments.length || a.number - b.number) * direction);
          } else {
            issues = [...issues].sort((a, b) =>
              ((order.field === 'UPDATED_AT' ? a.updatedAt : a.createdAt).localeCompare(order.field === 'UPDATED_AT' ? b.updatedAt : b.createdAt) || a.number - b.number) * direction,
            );
          }
          const all = issues;
          const afterNum = cursorNumber(args.after);
          if (afterNum !== null) {
            const index = issues.findIndex((issue) => issue.number === afterNum);
            if (index >= 0) issues = issues.slice(index + 1);
          }
          const first = toInt(args.first);
          const selected = first === undefined ? issues : issues.slice(0, first);
          return { value: makeConnection(all, selected, (issue) => issue.number, issues.length > selected.length), type: 'IssueConnection', repo: parent };
        }
        case 'pullRequests': {
          const all: PullRequest[] = store.listPulls(parent, { state: 'all' });
          let remaining = all;
          const afterNum = cursorNumber(args.after);
          if (afterNum !== null) {
            const index = remaining.findIndex((pr) => pr.number === afterNum);
            if (index >= 0) remaining = remaining.slice(index + 1);
          }
          const first = toInt(args.first);
          const selected = first === undefined ? remaining : remaining.slice(0, first);
          return { value: makeConnection(all, selected, (pr) => pr.number, remaining.length > selected.length), type: 'PullRequestConnection', repo: parent };
        }
      }
      break;
    case 'Issue':
      switch (field.name) {
        case 'id': return { value: idOverride ?? issueGlobalId(repo!.owner, repo!.name, parent.number) };
        case 'databaseId': return { value: parent.number };
        case 'number': return { value: parent.number };
        case 'title': return { value: parent.title };
        case 'body': return { value: parent.body };
        case 'state': return { value: parent.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'createdAt': return { value: parent.createdAt };
        case 'updatedAt': return { value: parent.updatedAt };
        case 'closedAt': return { value: parent.closedAt };
        case 'author': return { value: makeUser(parent.userLogin), type: 'User' };
        case 'labels':
          return {
            value: parent.labels.map((name: string) => {
              const label = repo?.labels.find((l) => l.name === name);
              return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
            }),
            type: 'Label',
          };
        case 'comments': {
          const all = parent.comments as IssueComment[];
          const first = toInt(args.first);
          const selected = first === undefined ? all : all.slice(0, first);
          return {
            value: {
              nodes: selected,
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: all.length,
            },
            type: 'IssueCommentConnection',
            repo,
          };
        }
      }
      break;
    case 'IssueComment':
      switch (field.name) {
        case 'id': return { value: idOverride ?? commentGlobalId(repo!.owner, repo!.name, parent.issueNumber ?? 0, parent.id) };
        case 'body': return { value: parent.body };
        case 'author': return { value: makeUser(parent.userLogin), type: 'User' };
        case 'createdAt': return { value: parent.createdAt };
        case 'updatedAt': return { value: parent.updatedAt };
      }
      break;
    case 'PullRequest':
      switch (field.name) {
        case 'id': return { value: idOverride ?? pullGlobalId(repo!.owner, repo!.name, parent.number) };
        case 'databaseId': return { value: parent.number };
        case 'number': return { value: parent.number };
        case 'title': return { value: parent.title };
        case 'body': return { value: parent.body };
        case 'state': return { value: parent.merged ? 'MERGED' : parent.state === 'closed' ? 'CLOSED' : 'OPEN' };
        case 'merged': return { value: parent.merged };
        case 'mergeable': {
          if (parent.state !== 'open') return { value: 'UNKNOWN' };
          try {
            return { value: store.pullMergeable(repo!, parent) ? 'MERGEABLE' : 'CONFLICTING' };
          } catch {
            return { value: 'UNKNOWN' };
          }
        }
        case 'headRefName': return { value: parent.headRef };
        case 'baseRefName': return { value: parent.baseRef };
        case 'headRefOid': return { value: parent.headSha };
        case 'baseRefOid': return { value: parent.baseSha };
        case 'createdAt': return { value: parent.createdAt };
        case 'updatedAt': return { value: parent.updatedAt };
        case 'mergedAt': return { value: parent.mergedAt };
        case 'author': return { value: makeUser(parent.userLogin), type: 'User' };
        case 'files': {
          const all = store.pullFiles(repo!, parent).map((f) => ({
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            status: f.status,
          }));
          const first = toInt(args.first);
          return {
            value: {
              nodes: first === undefined ? all : all.slice(0, first),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: all.length,
            },
            type: 'PullRequestChangedFileConnection',
          };
        }
      }
      break;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'IssueCommentConnection':
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return { value: parent.nodes, type: parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : parentType === 'IssueCommentConnection' ? 'IssueComment' : 'PullRequestChangedFile', repo };
      if (field.name === 'edges') return { value: parent.edges ?? [], type: parentType === 'IssueConnection' ? 'IssueEdge' : parentType === 'IssueCommentConnection' ? 'CommentEdge' : 'PullRequestEdge', repo };
      if (field.name === 'pageInfo') return { value: parent.pageInfo, type: 'PageInfo' };
      if (field.name === 'totalCount') return { value: parent.totalCount };
      break;
    case 'IssueEdge':
    case 'CommentEdge':
      if (field.name === 'node') return { value: parent.node, type: parentType === 'IssueEdge' ? 'Issue' : 'IssueComment', repo };
      if (field.name === 'cursor') return { value: parent.cursor };
      break;
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
      if (field.name === 'node') return { value: parent.node, type: parentType === 'PullRequestEdge' ? 'PullRequest' : 'PullRequestChangedFile', repo };
      if (field.name === 'cursor') return { value: parent.cursor };
      break;
    case 'PullRequestChangedFile':
      if (['path', 'additions', 'deletions', 'changes', 'status'].includes(field.name)) return { value: parent[field.name] };
      break;
    case 'User':
      if (field.name === 'id') return { value: 'U_' + b64urlEncode(`user:${parent.login}`) };
      if (field.name === 'login') return { value: parent.login };
      if (field.name === 'name') return { value: parent.name ?? (parent.login === VIEWER_LOGIN ? VIEWER_NAME : parent.login) };
      if (field.name === 'email') return { value: parent.email ?? (parent.login === VIEWER_LOGIN ? VIEWER_EMAIL : '') };
      break;
    case 'Ref':
      if (field.name === 'name') return { value: parent.name };
      if (field.name === 'prefix') return { value: parent.prefix };
      break;
    case 'PageInfo':
      if (['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'].includes(field.name)) return { value: parent[field.name] };
      break;
    case 'Label':
      if (['name', 'color', 'description'].includes(field.name)) return { value: parent[field.name] };
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field.name === 'issue') return { value: parent.issue, type: 'Issue', repo: parent.repo };
      if (field.name === 'clientMutationId') return { value: parent.clientMutationId };
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return { value: parent.pullRequest, type: 'PullRequest', repo: parent.repo };
      if (field.name === 'clientMutationId') return { value: parent.clientMutationId };
      break;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') return { value: parent.commentEdge, type: 'CommentEdge', repo: parent.repo };
      if (field.name === 'subject') return { value: parent.subject, type: 'Issue', repo: parent.repo };
      if (field.name === 'clientMutationId') return { value: parent.clientMutationId };
      break;
    case '__Type':
      if (field.name === 'kind') return { value: parent.kind };
      if (field.name === 'name') return { value: parent.name };
      if (field.name === 'description') return { value: parent.description ?? null };
      if (field.name === 'fields') return { value: parent.fields ?? null, type: '__Field' };
      if (field.name === 'enumValues') return { value: parent.enumValues ?? null, type: '__EnumValue' };
      if (field.name === 'inputFields') return { value: parent.inputFields ?? null, type: '__InputValue' };
      break;
    case '__Field':
      if (field.name === 'name' || field.name === 'description') return { value: parent[field.name] ?? null };
      if (field.name === 'args') return { value: parent.args ?? [], type: '__InputValue' };
      if (field.name === 'type') return { value: parent.type, type: '__Type' };
      break;
    case '__EnumValue':
      if (field.name === 'name' || field.name === 'description') return { value: parent[field.name] ?? null };
      break;
    case '__InputValue':
      if (field.name === 'name' || field.name === 'description' || field.name === 'defaultValue') return { value: parent[field.name] ?? null };
      if (field.name === 'type') return { value: parent.type, type: '__Type' };
      break;
    case '__Schema':
      if (field.name === 'queryType') return { value: { name: 'Query', kind: 'OBJECT' }, type: '__Type' };
      if (field.name === 'mutationType') return { value: { name: 'Mutation', kind: 'OBJECT' }, type: '__Type' };
      if (field.name === 'types') return { value: allTypeNames.map((name) => ({ name, kind: typeKind(name) })), type: '__Type' };
      break;
  }

  if (parentType === 'Mutation') {
    const input = args.input ?? {};
    const clientMutationId = input.clientMutationId ?? null;
    if (field.name === 'createIssue') {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
      const [owner, name] = decoded.payload.split('/');
      const targetRepo = store.getRepo(owner, name);
      if (!targetRepo) throw new Error('repository not found');
      const created = store.createIssue(targetRepo, { title: String(input.title ?? ''), body: input.body ?? '' });
      if ('error' in created) throw new Error(created.error);
      return { value: { issue: created, clientMutationId, repo: targetRepo }, type: 'CreateIssuePayload' };
    }
    if (field.name === 'closeIssue') {
      const decoded = decodeGlobalId(input.issueId);
      if (!decoded || decoded.kind !== 'I') throw new Error('issue not found');
      const m = decoded.payload.match(/^(.+)\/([^/]+)#(\d+)$/);
      const targetRepo = m && store.getRepo(m[1], m[2]);
      if (!m || !targetRepo) throw new Error('issue not found');
      const issue = store.patchIssue(targetRepo, Number(m[3]), { state: 'closed' });
      if (!issue) throw new Error('issue not found');
      return { value: { issue, clientMutationId, repo: targetRepo }, type: 'CloseIssuePayload' };
    }
    if (field.name === 'createPullRequest') {
      const decoded = decodeGlobalId(input.repositoryId);
      if (!decoded || decoded.kind !== 'R') throw new Error('repository not found');
      const [owner, name] = decoded.payload.split('/');
      const targetRepo = store.getRepo(owner, name);
      if (!targetRepo) throw new Error('repository not found');
      const pr = store.createPull(targetRepo, {
        title: String(input.title ?? ''),
        body: input.body ?? '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { value: { pullRequest: pr, clientMutationId, repo: targetRepo }, type: 'CreatePullRequestPayload' };
    }
    if (field.name === 'mergePullRequest') {
      const decoded = decodeGlobalId(input.pullRequestId);
      if (!decoded || decoded.kind !== 'P') throw new Error('pull request not found');
      const m = decoded.payload.match(/^(.+)\/([^/]+)#(\d+)$/);
      const targetRepo = m && store.getRepo(m[1], m[2]);
      const pr = m && targetRepo && store.getPull(targetRepo, Number(m[3]));
      if (!m || !targetRepo || !pr) throw new Error('pull request not found');
      const method = input.mergeMethod ?? 'MERGE';
      if (method !== 'SQUASH') throw new Error(`merge method ${method} is not supported`);
      if (!store.squashMerge(targetRepo, pr, {})) throw new Error('pull request cannot be merged');
      return { value: { pullRequest: pr, clientMutationId, repo: targetRepo }, type: 'MergePullRequestPayload' };
    }
    if (field.name === 'addComment') {
      const decoded = decodeGlobalId(input.subjectId);
      if (!decoded || decoded.kind !== 'I') throw new Error('subject not found');
      const m = decoded.payload.match(/^(.+)\/([^/]+)#(\d+)$/);
      const targetRepo = m && store.getRepo(m[1], m[2]);
      const issue = m && targetRepo && store.getIssue(targetRepo, Number(m[3]));
      if (!m || !targetRepo || !issue) throw new Error('subject not found');
      const comment = store.addIssueComment(targetRepo, issue.number, String(input.body ?? '') );
      const commentValue = { ...comment, issueNumber: issue.number };
      return {
        value: {
          commentEdge: {
            node: commentValue,
            cursor: b64urlEncode(`cursor:${comment.id}`),
          },
          subject: issue,
          clientMutationId,
          repo: targetRepo,
        },
        type: 'AddCommentPayload',
      };
    }
  }
  return { value: null };
}

function expandSelections(
  selections: FieldNode[],
  type: string,
  fragments: Record<string, { type: string; selection: FieldNode[] }>,
  errors: GqlError[],
  path: (string | number)[],
  stack: Set<string> = new Set(),
): FieldNode[] {
  const result: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.name === '...') {
      if (selection.inlineType && selection.inlineType !== type && selection.inlineType !== 'Node') continue;
      result.push(...expandSelections(selection.selection ?? [], type, fragments, errors, path, stack));
      continue;
    }
    if (selection.name.startsWith('...')) {
      const name = selection.name.slice(3);
      const fragment = fragments[name];
      if (!fragment || stack.has(name)) continue;
      if (fragment.type !== type && fragment.type !== 'Node') continue;
      const next = new Set(stack);
      next.add(name);
      result.push(...expandSelections(fragment.selection, type, fragments, errors, path, next));
      continue;
    }
    result.push(selection);
  }
  return result;
}

function executeSelection(
  store: Store,
  type: string,
  parent: any,
  selections: FieldNode[],
  fragments: Record<string, { type: string; selection: FieldNode[] }>,
  vars: Record<string, unknown>,
  errors: GqlError[],
  path: (string | number)[],
  inheritedRepo?: Repo,
  idOverride?: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const expanded = expandSelections(selections, type, fragments, errors, path);
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      result[key] = type;
      continue;
    }
    const known = field.name.startsWith('__') ? (type === 'Query' ? ['__type', '__schema'].includes(field.name) : typeFields[type]?.includes(field.name)) : typeFields[type]?.includes(field.name);
    if (!known) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${type}".`, path: fieldPath });
      result[key] = null;
      continue;
    }
    const allowed = allowedArgs[`${type}.${field.name}`] ?? [];
    let args: Record<string, any> = {};
    for (const [argName, valueNode] of Object.entries(field.args)) {
      if (!allowed.includes(argName)) {
        errors.push({ message: `Unknown argument "${argName}" on field "${type}.${field.name}".`, path: fieldPath });
        continue;
      }
      try {
        args[argName] = valueFromNode(valueNode, vars);
      } catch (error) {
        errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      }
    }
    try {
      const resolved = getFieldValue(store, type, parent, field, args, inheritedRepo, idOverride);
      const value = resolved.value;
      const childType = resolved.type ?? outputTypes[type]?.[field.name];
      if (field.selection) {
        if (Array.isArray(value)) {
          result[key] = value.map((item, index) =>
            item === null || item === undefined
              ? null
              : executeSelection(store, childType ?? 'String', item, field.selection!, fragments, vars, errors, [...fieldPath, index], resolved.repo ?? inheritedRepo),
          );
        } else if (value === null || value === undefined) {
          result[key] = null;
        } else if (childType && (typeFields[childType] || childType.startsWith('__') || childType === 'Label')) {
          result[key] = executeSelection(store, childType, value, field.selection, fragments, vars, errors, fieldPath, resolved.repo ?? inheritedRepo, resolved.idOverride);
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error), path: fieldPath });
      result[key] = null;
    }
  }
  return result;
}

function executeOne(store: Store, request: any): { response: any; transportError?: boolean } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { response: { errors: [{ message: 'query is required' }] }, transportError: true };
  }
  if (typeof request.query !== 'string' || !request.query.trim()) {
    return { response: { errors: [{ message: 'query is required' }] }, transportError: true };
  }
  let parsed: ReturnType<Parser['parse']>;
  try {
    parsed = new Parser(lex(request.query)).parse();
  } catch (error) {
    return { response: { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  }
  let operation: Operation | undefined;
  if (request.operationName !== undefined && request.operationName !== null) {
    operation = parsed.operations.find((op) => op.name === request.operationName);
    if (!operation) return { response: { data: null, errors: [{ message: `Unknown operation named "${request.operationName}".` }] } };
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  } else {
    return { response: { errors: [{ message: 'operationName is required when a document contains multiple operations.' }] }, transportError: true };
  }

  let variables: Record<string, unknown> = {};
  if (request.variables !== undefined && request.variables !== null) {
    try {
      const raw = typeof request.variables === 'string' ? JSON.parse(request.variables) : request.variables;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Variables must be an object.');
      variables = { ...raw };
    } catch (error) {
      return { response: { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
    }
  }
  try {
    for (const definition of operation!.variables) {
      if (!Object.prototype.hasOwnProperty.call(variables, definition.name) && definition.defaultValue) {
        variables[definition.name] = valueFromNode(definition.defaultValue, variables);
      }
      if (!Object.prototype.hasOwnProperty.call(variables, definition.name) && definition.type.nonNull) {
        throw new Error(`Variable "$${definition.name}" of required type was not provided.`);
      }
      if (Object.prototype.hasOwnProperty.call(variables, definition.name)) {
        variables[definition.name] = coerceVariable(variables[definition.name], definition.type, definition.name);
      }
    }
  } catch (error) {
    return { response: { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  }

  const errors: GqlError[] = [];
  const rootType = operation!.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(store, rootType, {}, operation!.selection, parsed.fragments, variables, errors, []);
  return { response: errors.length ? { data, errors } : { data } };
}

export function handleGraphQL(
  store: Store,
  rawBody: string,
): { status: number; body: unknown; headers?: Record<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    return {
      status: 400,
      body: { errors: [{ message: error instanceof Error ? error.message : 'Invalid JSON' }] },
    };
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed.map((item) => executeOne(store, item));
    return {
      status: outcomes.some((outcome) => outcome.transportError) ? 400 : 200,
      body: outcomes.map((outcome) => outcome.response),
    };
  }
  const outcome = executeOne(store, parsed);
  return { status: outcome.transportError ? 400 : 200, body: outcome.response };
}
