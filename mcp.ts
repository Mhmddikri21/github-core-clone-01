// Model Context Protocol over streamable HTTP (plain JSON responses).
// Modern era (2026-07-28): server/discover, no handshake, no session.
// Legacy fallback: initialize + notifications/initialized.
import {
  FIXED_DATE,
  VIEWER_LOGIN,
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
} from './store.ts';
import type { Store } from './store.ts';

export interface McpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(store: Store, owner: string, name: string): Record<string, unknown> | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  return {
    id: repo.id,
    node_id: repoGlobalId(owner, name),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: owner, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (def === undefined) return toolErr(`unknown tool: ${name}`);
  for (const required of def.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErr(`missing required argument: ${required}`);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = args.name as string;
      const made = store.createRepo(VIEWER_LOGIN, repoNameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if (made === null) return toolErr('Repository already exists');
      return toolOk(repoJson(store, VIEWER_LOGIN, repoNameArg));
    }
    case 'get_repo': {
      const out = repoJson(store, owner, repoName);
      if (out === null) return toolErr('Not Found');
      return toolOk(out);
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr('Not Found');
      const made = store.createIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in made) return toolErr(made.error);
      return toolOk({
        id: made.id,
        node_id: issueGlobalId(owner, repoName, made.number),
        number: made.number,
        title: made.title,
        body: made.body,
        state: made.state,
        created_at: made.createdAt,
        updated_at: made.updatedAt,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr('Not Found');
      const state = args.state === 'closed' ? 'closed' : args.state === 'all' ? 'all' : 'open';
      const list = store.listIssues(repo, { state });
      return toolOk(list.map((issue) => ({
        id: issue.id,
        node_id: issueGlobalId(owner, repoName, issue.number),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      })));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr('Not Found');
      const made = store.createPull(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head as string,
        base: args.base as string,
      });
      if ('error' in made) return toolErr(made.error);
      return toolOk({
        id: made.id,
        node_id: pullGlobalId(owner, repoName, made.number),
        number: made.number,
        title: made.title,
        body: made.body,
        state: made.state,
        head: { ref: made.headRef, sha: made.headSha },
        base: { ref: made.baseRef, sha: made.baseSha },
        merged: made.merged,
        created_at: made.createdAt,
        updated_at: made.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolErr('Not Found');
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pr = store.getPull(repo, num);
      if (pr === undefined) return toolErr('Not Found');
      const done = store.squashMerge(repo, pr, {});
      if ('error' in done) return toolErr(done.error);
      return toolOk({ merged: true, sha: done.sha, message: done.message, number: pr.number, state: pr.state });
    }
    default:
      return toolErr(`unknown tool: ${name}`);
  }
}

export function handleMcp(store: Store, rawBody: string): McpResponse {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = 'id' in body ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  // Notifications carry no id: answer 202 with an empty body.
  if (id === undefined) {
    return { status: 202, body: {} };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
        ? params.protocolVersion
        : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (TOOLS.find((t) => t.name === toolName) === undefined) {
        return rpcError(id, -32601, `Method not found: ${toolName}`);
      }
      return rpcResult(id, callTool(store, toolName, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function unusedCommentHelper(): string {
  return commentGlobalId(VIEWER_LOGIN, 'x', 1, 1) + FIXED_DATE;
}
