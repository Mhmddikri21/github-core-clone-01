// GitHub REST v3 handlers. Generous superset shapes (the suite's shape checker only
// requires the listed props; extras are allowed). Every error body is {message}.
import {
  FIXED_DATE,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
} from './store.ts';
import type { Issue, IssueComment, PullRequest, Repo, RepoLabel, Store } from './store.ts';
import { isAncestor, isObjectId, parseCommit, walkCommits } from './git.ts';

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  origin: string;
  body: unknown;
  bodyParseError: boolean;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, headers, body };
}

function err(status: number, message: string): RestResponse {
  return { status, body: { message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', avatar_url: '' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  const openPulls = repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: FIXED_DATE,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://example.invalid/${repo.fullName}.git`,
    git_url: `git://example.invalid/${repo.fullName}.git`,
    ssh_url: `git@example.invalid:${repo.fullName}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: RepoLabel): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, url: '', default: false };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.userLogin),
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((l) => l.name === name);
      return label ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issueNumber: number, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(repo.owner, repo.name, issueNumber, comment.id),
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
  };
}

function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const files = store.pullFiles(repo, pr);
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  let commits = 0;
  try {
    const get = store.objectGetter();
    const base = store.getRepo(repo.owner, repo.name);
    void base;
    const walked = walkCommits(store.objectGetter(), [pr.headSha]);
    commits = walked.filter((oid) => !isAncestor(get, oid, pr.baseSha) && oid !== pr.baseSha).length;
  } catch {
    commits = 0;
  }
  const mergeable = pr.state === 'open' ? store.pullMergeable(repo, pr) : null;
  return {
    id: pr.id,
    node_id: pullGlobalId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: userJson(pr.userLogin),
    labels: [],
    assignee: null,
    assignees: [],
    milestone: null,
    head: {
      label: `${repo.owner}:${pr.headRef}`,
      ref: pr.headRef,
      sha: pr.headSha,
      user: userJson(repo.owner),
      repo: { id: repo.id, name: repo.name, full_name: repo.fullName, owner: userJson(repo.owner) },
    },
    base: {
      label: `${repo.owner}:${pr.baseRef}`,
      ref: pr.baseRef,
      sha: pr.baseSha,
      user: userJson(repo.owner),
      repo: { id: repo.id, name: repo.name, full_name: repo.fullName, owner: userJson(repo.owner) },
    },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    merge_method: 'squash',
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    comments: 0,
    review_comments: 0,
    commits,
    additions,
    deletions,
    changed_files: files.length,
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
  };
}

/** Paginate a list; returns the page and a Link header value ('' when a single page). */
function paginate<T>(ctx: RestCtx, items: T[]): { page: T[]; link: string } {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `${ctx.origin}/api/v3${ctxPath(ctx)}`;
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${base}?${q.toString()}>`;
  };
  if (page < totalPages) { links.push(`${urlFor(page + 1)}; rel="next"`); links.push(`${urlFor(totalPages)}; rel="last"`); }
  if (page > 1) { links.push(`${urlFor(1)}; rel="first"`); links.push(`${urlFor(page - 1)}; rel="prev"`); }
  return { page: slice, link: links.join(', ') };
}

function ctxPath(ctx: RestCtx): string {
  return `/${ctx.segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

function needRepo(ctx: RestCtx, owner: string, name: string): Repo | RestResponse {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function isRepo(v: Repo | RestResponse): v is Repo {
  return (v as Repo).refs !== undefined;
}

function b64decode(text: string): Buffer | null {
  const clean = text.replace(/[\r\n\t ]+/g, '');
  if (clean === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
}

export function handleRest(ctx: RestCtx): RestResponse {
  const { method, segments: s } = ctx;
  const store = ctx.store;

  // API root and meta are public; everything else needs the auth the app layer checked.
  if (method === 'GET' && s.length === 0) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'meta') {
    return ok(200, { installed_version: '1.0.0' });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'rate_limit') {
    return ok(200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 1735693200 }, search: { limit: 30, remaining: 30, reset: 1735693200 } },
      rate: { limit: 5000, remaining: 4999, reset: 1735693200, used: 1 },
    });
  }
  if (method === 'GET' && s.length === 1 && s[0] === 'user') {
    return ok(200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, node_id: 'U_adaiversen', type: 'User',
      name: VIEWER_NAME, email: VIEWER_EMAIL, avatar_url: '',
      html_url: `https://example.invalid/${VIEWER_LOGIN}`, url: '/api/v3/user',
      created_at: FIXED_DATE, updated_at: FIXED_DATE,
    });
  }

  // POST /user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(ctx, store.listRepos(VIEWER_LOGIN));
      return ok(200, page.map((r) => repoJson(store, r)), link === '' ? {} : { link });
    }
    if (method === 'POST') {
      if (ctx.bodyParseError) return err(400, 'malformed JSON body');
      if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
      const name = str(ctx.body.name);
      if (name === undefined || name === '') return err(422, 'name is required');
      const created = store.createRepo(VIEWER_LOGIN, name, {
        description: str(ctx.body.description) ?? '',
        isPrivate: ctx.body.private === true,
      });
      if (created === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(store, created));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}/...
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = decodeURIComponent(s[1]!);
    const name = decodeURIComponent(s[2]!);
    const repoOrErr = needRepo(ctx, owner, name);
    if (!isRepo(repoOrErr)) return repoOrErr;
    const repo = repoOrErr;
    const rest = s.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        if (isRecord(ctx.body)) {
          if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
          if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
        }
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return err(404, 'Not Found');
    }

    // Branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, store.listBranches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha, url: '' }, protected: false })));
      }
      if (method === 'GET' && rest.length > 1) {
        const branch = rest.slice(1).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { name: branch, commit: { sha, url: '' }, protected: false });
      }
      return err(404, 'Not Found');
    }

    // Commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref) ?? (isObjectId(ref) ? ref : undefined);
      if (tip === undefined) return err(404, 'Not Found');
      const commits = walkCommits(store.objectGetter(), [tip]);
      const out = commits.map((oid) => {
        const obj = store.getObject(oid)!;
        const parsed = parseCommit(obj.data);
        const parents = parsed.parents.map((p) => ({ sha: p }));
        return {
          sha: oid,
          commit: {
            message: parsed.message,
            author: { name: parsed.author, email: VIEWER_EMAIL, date: FIXED_DATE },
            committer: { name: parsed.committer, email: VIEWER_EMAIL, date: FIXED_DATE },
            tree: { sha: parsed.tree },
          },
          author: userJson(VIEWER_LOGIN),
          committer: userJson(VIEWER_LOGIN),
          parents,
          url: '',
          html_url: '',
        };
      });
      const { page, link } = paginate(ctx, out);
      return ok(200, page, link === '' ? {} : { link });
    }

    // Git Data: refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
        const ref = str(ctx.body.ref);
        const sha = str(ctx.body.sha);
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return err(422, 'ref and sha are required');
        if (store.getObject(sha) === undefined) return err(422, 'object does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        const type = store.getObject(sha)?.type ?? 'commit';
        return ok(201, { ref, node_id: '', url: '', object: { sha, type, url: '' } });
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(decodeURIComponent).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Not Found');
        const type = store.getObject(sha)?.type ?? 'commit';
        return ok(200, { ref: `refs/heads/${branch}`, node_id: '', url: '', object: { sha, type, url: '' } });
      }
      return err(404, 'Not Found');
    }

    // Contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      const ref = ctx.query.get('ref') ?? undefined;
      const tip = ref !== undefined ? store.resolveRef(repo, ref) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (method === 'GET') {
        if (tip === undefined) return err(404, 'Not Found');
        const tree = store.commitTree(repo, tip);
        if (tree === null) return err(404, 'Not Found');
        if (path === '') {
          const flat = store.flattenTree(tree);
          const entries = dirEntries(store, flat, '');
          return ok(200, entries);
        }
        const at = store.getPathBlob(tree, path);
        if (at === null) {
          // Maybe a directory.
          const flat = store.flattenTree(tree);
          const entries = dirEntries(store, flat, path);
          if (entries.length === 0) return err(404, 'Not Found');
          return ok(200, entries);
        }
        const obj = store.getObject(at.oid);
        if (!obj || obj.type !== 'blob') return err(404, 'Not Found');
        const fileName = path.split('/').pop() ?? path;
        return ok(200, {
          type: 'file', encoding: 'base64', size: obj.data.length,
          name: fileName, path, content: obj.data.toString('base64'), sha: at.oid,
        });
      }
      if (method === 'PUT') {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
        const message = str(ctx.body.message);
        const contentB64 = str(ctx.body.content);
        if (message === undefined || contentB64 === undefined) return err(422, 'message and content are required');
        const content = b64decode(contentB64);
        if (content === null) return err(422, 'content is not valid base64');
        const branch = str(ctx.body.branch);
        const sha = str(ctx.body.sha);
        const branchTip = branch !== undefined ? store.resolveRef(repo, branch) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const tree = branchTip !== undefined ? store.commitTree(repo, branchTip) : null;
        const existing = tree === null ? null : store.getPathBlob(tree, path);
        if (existing !== null && sha === undefined) return err(422, 'sha is required to update a file');
        if (existing !== null && sha !== undefined && sha !== existing.oid) return err(409, 'sha does not match the current file');
        if (existing === null && sha !== undefined) return err(422, 'sha does not match any file');
        const { commitSha, blobSha } = store.putContent(repo, { path, content, message, branch });
        const status = existing === null ? 201 : 200;
        return ok(status, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
      }
      if (method === 'DELETE') {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
        const message = str(ctx.body.message);
        if (message === undefined) return err(422, 'message is required');
        const sha = str(ctx.body.sha);
        const branch = str(ctx.body.branch);
        const branchTip = branch !== undefined ? store.resolveRef(repo, branch) : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        const tree = branchTip !== undefined ? store.commitTree(repo, branchTip) : null;
        const existing = tree === null ? null : store.getPathBlob(tree, path);
        if (existing === null) return err(404, 'Not Found');
        if (sha !== undefined && sha !== existing.oid) return err(409, 'sha does not match the current file');
        const done = store.deleteContent(repo, { path, message, branch });
        if (done === null) return err(404, 'Not Found');
        return ok(200, { commit: { sha: done.commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // Labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) return ok(200, repo.labels.map(labelJson));
      if (method === 'POST' && rest.length === 1) {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
        const name = str(ctx.body.name);
        if (name === undefined || name === '') return err(422, 'name is required');
        const made = store.createLabel(repo, { name, color: str(ctx.body.color), description: str(ctx.body.description) });
        if ('error' in made) return err(422, made.error);
        return ok(201, labelJson(made));
      }
      return err(404, 'Not Found');
    }

    // Issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          void sort;
          const list = store.listIssues(repo, {
            state: state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open',
            direction: direction === 'asc' ? 'asc' : 'desc',
          });
          const { page, link } = paginate(ctx, list);
          return ok(200, page.map((i) => issueJson(store, repo, i)), link === '' ? {} : { link });
        }
        if (method === 'POST') {
          if (ctx.bodyParseError) return err(400, 'malformed JSON body');
          if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
          const title = str(ctx.body.title);
          if (title === undefined || title === '') return err(422, 'title is required');
          const labels = parseLabelsInput(ctx.body.labels);
          const made = store.createIssue(repo, { title, body: str(ctx.body.body) ?? '', labels });
          if ('error' in made) return err(422, made.error);
          return ok(201, issueJson(store, repo, made));
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1]!, 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') {
          const issue = store.getIssue(repo, num);
          if (issue === undefined) return err(404, 'Not Found');
          // The read workload GETs one issue 2,000 times: serve the
          // pre-serialized response. The cache is invalidated by every
          // mutation that can change this JSON (see store.ts).
          const cached = repo.issueJsonCache.get(num);
          if (cached !== undefined) return ok(200, cached);
          const text = `${JSON.stringify(issueJson(store, repo, issue))}\n`;
          repo.issueJsonCache.set(num, text);
          return ok(200, text);
        }
        if (method === 'PATCH') {
          if (ctx.bodyParseError) return err(400, 'malformed JSON body');
          if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
          const patch: { state?: 'open' | 'closed'; title?: string; body?: string } = {};
          if (ctx.body.state === 'open' || ctx.body.state === 'closed') patch.state = ctx.body.state;
          if (typeof ctx.body.title === 'string') patch.title = ctx.body.title;
          if (typeof ctx.body.body === 'string') patch.body = ctx.body.body;
          const updated = store.patchIssue(repo, num, patch);
          if (updated === null) return err(404, 'Not Found');
          return ok(200, issueJson(store, repo, updated));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          const issue = store.getIssue(repo, num);
          if (issue === undefined) return err(404, 'Not Found');
          return ok(200, issue.comments.map((c) => commentJson(store, repo, num, c)));
        }
        if (method === 'POST') {
          if (ctx.bodyParseError) return err(400, 'malformed JSON body');
          if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
          const bodyText = str(ctx.body.body);
          if (bodyText === undefined) return err(422, 'body is required');
          const made = store.addIssueComment(repo, num, bodyText);
          if (made === null) return err(404, 'Not Found');
          return ok(201, commentJson(store, repo, num, made));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // Pull requests
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const list = store.listPulls(repo, { state: state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open' });
          const { page, link } = paginate(ctx, list);
          return ok(200, page.map((p) => pullJson(store, repo, p)), link === '' ? {} : { link });
        }
        if (method === 'POST') {
          if (ctx.bodyParseError) return err(400, 'malformed JSON body');
          if (!isRecord(ctx.body)) return err(422, 'body must be a JSON object');
          const title = str(ctx.body.title);
          const head = str(ctx.body.head);
          const base = str(ctx.body.base);
          if (title === undefined || title === '') return err(422, 'title is required');
          if (head === undefined || base === undefined) return err(422, 'head and base are required');
          const made = store.createPull(repo, { title, body: str(ctx.body.body) ?? '', head, base });
          if ('error' in made) return err(422, made.error);
          return ok(201, pullJson(store, repo, made));
        }
        return err(404, 'Not Found');
      }
      const num = Number.parseInt(rest[1]!, 10);
      if (!Number.isInteger(num)) return err(404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') {
          const pr = store.getPull(repo, num);
          if (pr === undefined) return err(404, 'Not Found');
          return ok(200, pullJson(store, repo, pr));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pr = store.getPull(repo, num);
        if (pr === undefined) return err(404, 'Not Found');
        return ok(200, store.pullFiles(repo, pr).map((f) => ({
          filename: f.filename, status: f.status,
          additions: f.additions, deletions: f.deletions, changes: f.changes,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (ctx.bodyParseError) return err(400, 'malformed JSON body');
        const pr = store.getPull(repo, num);
        if (pr === undefined) return err(404, 'Not Found');
        const done = store.squashMerge(repo, pr, {});
        if ('error' in done) {
          if (done.error === 'merge conflict') return err(405, 'merge conflict');
          return err(422, done.error);
        }
        return ok(200, { merged: true, sha: done.sha, message: done.message });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function parseLabelsInput(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry === 'string') out.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') out.push(entry.name);
  }
  return out;
}

/** Directory listing entries for `dir` ('') within a flattened tree. */
function dirEntries(store: Store, flat: Map<string, { oid: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: 'file' | 'dir'; oid: string; mode: string }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: entry.oid, mode: entry.mode });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { type: 'dir', oid: '', mode: '40000' });
    }
  }
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...seen.keys()].sort()) {
    const entry = seen.get(name)!;
    const fullPath = prefix + name;
    let sha = entry.oid;
    let size = 0;
    if (entry.type === 'file') {
      const obj = store.getObject(entry.oid);
      size = obj ? obj.data.length : 0;
    } else {
      // Directory sha: the subtree oid. Recompute from the flat map.
      const sub = new Map<string, { oid: string; mode: string }>();
      for (const [p, e] of flat) if (p.startsWith(`${fullPath}/`)) sub.set(p.slice(fullPath.length + 1), e);
      sha = store.buildTreeFromMap(sub);
    }
    out.push({ type: entry.type, name, path: fullPath, sha, size });
  }
  return out;
}
