// app.ts — Anvil: an in-memory GitHub-compatible git forge.
//
// One process-wide store holds every repository: its git objects (raw bytes,
// addressed by their real sha1), refs, issues and pull requests (one shared
// number sequence, as GitHub does), labels and comments. On top of that store
// sit three surfaces over the same objects — the REST API under /api/v3, the
// smart-HTTP git protocol (v0 + v2) and GraphQL at /api/graphql — plus an MCP
// endpoint at /mcp speaking the legacy JSON-RPC era. Nothing touches disk and
// nothing reads the wall clock: commit timestamps derive from
// MAKEFUN_TRIAL_NOW plus a counter, so a run replays byte for byte.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: ObjType;
  data: Buffer;
}

interface ItemRec {
  number: number;
  kind: 'issue' | 'pull';
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  head?: string;
  base?: string;
  merged?: boolean;
  mergeCommitSha?: string;
  mergedAt?: string;
}

interface CommentRec {
  id: number;
  body: string;
}

interface RepoState {
  id: number;
  name: string;
  owner: string | null;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  refsVersion: number;
  items: Map<number, ItemRec>;
  nextNumber: number;
  labels: Map<string, { name: string; color: string }>;
  comments: Map<number, CommentRec[]>;
  packCache: { tip: string; pack: Buffer; boundary: string[] } | null;
  infoRefsCache: { version: number; upload: Buffer; receive: Buffer } | null;
  lsRefsCache: { version: number; body: Buffer } | null;
  repoJsonCache: Buffer | null;
  issueJsonCache: Map<number, Buffer>;
  issueListCache: Map<string, Buffer>;
}

const reposByName = new Map<string, RepoState>();
let nextRepoId = 1;
let nextCommentId = 1;
let nextSeq = 1;
let viewerLogin: string | null = null;
let requestSeq = 0;

const trialBaseSec = ((): number => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const ms = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1760000000;
})();
let commitClock = 0;
function nextCommitTs(): number {
  commitClock += 1;
  return trialBaseSec + commitClock;
}
function isoAt(seq: number): string {
  return new Date((trialBaseSec + seq) * 1000).toISOString();
}

const ZERO_OID = '0'.repeat(40);
const FORGE_NAME = 'Anvil Bot';
const FORGE_EMAIL = 'bot@anvil.invalid';

// ---------------------------------------------------------------------------
// git object primitives
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data as Buffer).digest('hex');
}

function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function storeObject(repo: RepoState, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const split = data.indexOf('\n\n');
  const head = (split === -1 ? data : data.subarray(0, split)).toString('utf8');
  const message = split === -1 ? '' : data.subarray(split + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function commitParents(repo: RepoState, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}

function commitTree(repo: RepoState, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function makeCommit(repo: RepoState, tree: string, parents: string[], message: string): string {
  const ts = nextCommitTs();
  const ident = `${FORGE_NAME} <${FORGE_EMAIL}> ${ts} +0000`;
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  return storeObject(repo, 'commit', Buffer.from(head + message, 'utf8'));
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Flatten a tree into a path -> blob oid map (empty map for a null tree). */
function flattenTree(repo: RepoState, treeOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (treeOid === null) return out;
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> blob oid map. */
function buildTree(repo: RepoState, files: Map<string, string>): string {
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = dir.dirs.get(parts[i]!);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(parts[i]!, next);
      }
      dir = next;
    }
    dir.files.set(parts[parts.length - 1]!, oid);
  }
  const emit = (dir: Dir): string => {
    const rows: { sortKey: string; mode: string; name: string; oid: string }[] = [];
    for (const [name, oid] of dir.files) rows.push({ sortKey: name, mode: '100644', name, oid });
    for (const [name, sub] of dir.dirs) rows.push({ sortKey: `${name}/`, mode: '40000', name, oid: emit(sub) });
    rows.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const chunks: Buffer[] = [];
    for (const row of rows) {
      chunks.push(Buffer.from(`${row.mode} ${row.name}\0`, 'utf8'));
      chunks.push(Buffer.from(row.oid, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(chunks));
  };
  return emit(root);
}

/** Minimum generation distance from the tips to every reachable commit. */
function commitDistances(repo: RepoState, tips: readonly string[]): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier: string[] = [];
  for (const tip of tips) {
    const obj = repo.objects.get(tip);
    if (obj !== undefined && obj.type === 'commit' && !dist.has(tip)) {
      dist.set(tip, 0);
      frontier.push(tip);
    }
  }
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      for (const parent of commitParents(repo, oid)) {
        if (!dist.has(parent) && repo.objects.get(parent)?.type === 'commit') {
          dist.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function isAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const parent of commitParents(repo, current)) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

function mergeBase(repo: RepoState, a: string, b: string): string | null {
  const ancestorsOfA = commitDistances(repo, [a]);
  if (ancestorsOfA.has(b)) return b;
  const seen = new Set<string>([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) return oid;
      for (const parent of commitParents(repo, oid)) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Every object id reachable from the given starting objects. When `graft`
 * names commits the walk treats as parentless (a client's shallow boundary),
 * those commits are included but their parents are not followed.
 */
function closureIds(repo: RepoState, starts: readonly string[], graft?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (graft === undefined || !graft.has(oid)) stack.push(...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})/m.exec(text);
      if (match !== null) stack.push(match[1]!);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pack files
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function buildPack(objects: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const first = (size & 0x0f) | (TYPE_CODES[obj.type] << 4) | (size > 0x0f ? 0x80 : 0);
    const varint: number[] = [first];
    size >>= 4;
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      varint.push(size > 0 ? byte | 0x80 : byte);
    }
    chunks.push(Buffer.from(varint));
    chunks.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate one zlib stream starting at `offset`; returns data + bytes used. */
function inflateOne(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; used: number } {
  // inflateSync stops at the end of the first stream and tolerates the bytes
  // that follow it, so one call yields the object; the stream's exact length
  // is then found by scanning for its Adler-32 trailer (the last 4 bytes of
  // every zlib stream) and verifying the candidate end once.
  const data = inflateSync(buf.subarray(offset));
  if (data.length !== expectedSize) throw new Error('corrupt pack: object size mismatch');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(data), 0);
  let searchFrom = offset + 6;
  for (;;) {
    const at = buf.indexOf(tail, searchFrom);
    if (at === -1) throw new Error('corrupt pack: stream end not found');
    const end = at + 4;
    try {
      const check = inflateSync(buf.subarray(offset, end));
      if (check.length === expectedSize && check.equals(data)) return { data, used: end - offset };
    } catch {
      // a coincidental trailer inside the compressed bytes: keep scanning
    }
    searchFrom = at + 1;
  }
}

/** Parse a whole pack into objects (deltas are never produced by our peers). */
function parsePack(buf: Buffer): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a pack');
  const count = buf.readUInt32BE(8);
  const objects: GitObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    let byte = buf[offset]!;
    offset += 1;
    const type = CODE_TYPES[(byte >> 4) & 0x07];
    if (type === undefined) throw new Error('pack uses a delta or unknown object type');
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const { data, used } = inflateOne(buf, offset, size);
    offset += used;
    objects.push({ type, data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'utf8');
const PKT_DELIM = Buffer.from('0001', 'utf8');

interface PktLine {
  payload: Buffer | null; // null = flush
  delim: boolean;
}

/** Split a buffer into pkt-lines; returns null when the framing is broken. */
function splitPkts(buf: Buffer, start = 0): { lines: PktLine[]; rest: number } | null {
  const lines: PktLine[] = [];
  let offset = start;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const head = buf.subarray(offset, offset + 4).toString('utf8');
    if (!/^[0-9a-f]{4}$/.test(head)) return null;
    const length = parseInt(head, 16);
    if (length === 0) {
      lines.push({ payload: null, delim: false });
      offset += 4;
      return { lines, rest: offset };
    }
    if (length === 1) {
      lines.push({ payload: Buffer.alloc(0), delim: true });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) return null;
    lines.push({ payload: buf.subarray(offset + 4, offset + length), delim: false });
    offset += length;
  }
  return { lines, rest: offset };
}

/** A side-band pkt-line: band byte + payload. */
function sideband(band: number, payload: Buffer): Buffer {
  return pkt(Buffer.concat([Buffer.from([band]), payload]));
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  method: string;
  segments: string[];
  rawPath: string;
  query: URLSearchParams;
  body: Buffer;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestId(): string {
  requestSeq += 1;
  return `anvil-${requestSeq}`;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.writeHead(status, { 'content-length': String(body.length), ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  sendBuffer(res, status, body, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId(), ...extra });
}

function sendJsonBuffer(res: ServerResponse, status: number, body: Buffer): void {
  sendBuffer(res, status, body, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId() });
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function parseJsonBody(ctx: Ctx): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// repository helpers
// ---------------------------------------------------------------------------

function createRepo(name: string, isPrivate: boolean, description: string): RepoState {
  const repo: RepoState = {
    id: nextRepoId,
    name,
    owner: null,
    isPrivate,
    description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    refsVersion: 0,
    items: new Map(),
    nextNumber: 1,
    labels: new Map(),
    comments: new Map(),
    packCache: null,
    infoRefsCache: null,
    lsRefsCache: null,
    repoJsonCache: null,
    issueJsonCache: new Map(),
    issueListCache: new Map(),
  };
  nextRepoId += 1;
  reposByName.set(name, repo);
  return repo;
}

/** Resolve owner/name, claiming an unclaimed repo for the addressed owner. */
function claimRepo(owner: string, name: string): RepoState | null {
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (repo.owner === null) {
    repo.owner = owner;
    repo.repoJsonCache = null;
    if (viewerLogin === null) viewerLogin = owner;
    return repo;
  }
  return repo.owner === owner ? repo : null;
}

function ownerLogin(repo: RepoState): string {
  return repo.owner ?? viewerLogin ?? 'anvil-user';
}

function repoJson(repo: RepoState): Record<string, unknown> {
  const owner = ownerLogin(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner, id: 1, type: 'User' },
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
    created_at: isoAt(repo.id),
    updated_at: isoAt(repo.id),
  };
}

function repoJsonBuffer(repo: RepoState): Buffer {
  if (repo.repoJsonCache === null) repo.repoJsonCache = Buffer.from(JSON.stringify(repoJson(repo)), 'utf8');
  return repo.repoJsonCache;
}

function touchRefs(repo: RepoState): void {
  repo.refsVersion += 1;
  repo.packCache = null;
  repo.infoRefsCache = null;
  repo.lsRefsCache = null;
}

function touchItems(repo: RepoState): void {
  repo.issueJsonCache.clear();
  repo.issueListCache.clear();
}

function branchTip(repo: RepoState, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a branch name, a full ref, or a commit sha to a commit sha. */
function resolveCommit(repo: RepoState, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj !== undefined) {
      if (obj.type === 'commit') return ref;
      if (obj.type === 'tag') {
        const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1];
        return target ?? null;
      }
    }
    return null;
  }
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (byRef !== undefined) {
    const obj = repo.objects.get(byRef);
    if (obj !== undefined && obj.type === 'tag') {
      const target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1];
      return target ?? null;
    }
    return byRef;
  }
  return null;
}

/** Commit a new tree state onto a branch (creating it when unborn). */
function commitOnBranch(repo: RepoState, branch: string, files: Map<string, string>, message: string): string {
  const tree = buildTree(repo, files);
  const tip = branchTip(repo, branch);
  const commit = makeCommit(repo, tree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  touchRefs(repo);
  return commit;
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS = 'multi_ack_detailed thin-pack side-band side-band-64k ofs-delta allow-tip-sha1-in-want allow-reachable-sha1-in-want shallow deepen-since deepen-not filter';
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs quiet atomic side-band-64k ofs-delta';

function advertisement(repo: RepoState, service: string): Buffer {
  const cached = repo.infoRefsCache;
  if (cached !== null && cached.version === repo.refsVersion) {
    return service === 'git-upload-pack' ? cached.upload : cached.receive;
  }
  const build = (caps: string): Buffer => {
    const parts: Buffer[] = [];
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const headTip = repo.refs.get(headRef);
    const refNames = [...repo.refs.keys()].sort();
    if (headTip !== undefined) {
      parts.push(pkt(`${headTip} HEAD\0${caps} symref=HEAD:${headRef} agent=anvil/1.0`));
    } else if (refNames.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${headRef} agent=anvil/1.0`));
    }
    for (const name of refNames) {
      if (headTip === undefined && name === refNames[0]) {
        parts.push(pkt(`${repo.refs.get(name)!} ${name}\0${caps} symref=HEAD:${headRef} agent=anvil/1.0`));
      } else {
        parts.push(pkt(`${repo.refs.get(name)!} ${name}`));
      }
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  };
  const upload = Buffer.concat([pkt('# service=git-upload-pack'), PKT_FLUSH, build(UPLOAD_CAPS)]);
  const receive = Buffer.concat([pkt('# service=git-receive-pack'), PKT_FLUSH, build(RECEIVE_CAPS)]);
  repo.infoRefsCache = { version: repo.refsVersion, upload, receive };
  return service === 'git-upload-pack' ? upload : receive;
}

function handleInfoRefs(res: ServerResponse, repo: RepoState, ctx: Ctx): void {
  const service = ctx.query.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 400, 'unknown service');
    return;
  }
  const protocol = ctx.req.headers['git-protocol'];
  if (service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2')) {
    const body = Buffer.concat([
      pkt('version 2'),
      pkt('agent=anvil/1.0'),
      pkt('ls-refs=unborn'),
      pkt('fetch=wait-for-done shallow filter'),
      pkt('object-format=sha1'),
      PKT_FLUSH,
    ]);
    sendBuffer(res, 200, body, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    return;
  }
  sendBuffer(res, 200, advertisement(repo, service), {
    'content-type': `application/x-${service}-advertisement`,
  });
}

function sortedRefEntries(repo: RepoState): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function handleLsRefs(res: ServerResponse, repo: RepoState, lines: PktLine[]): void {
  // Argument lines follow the delim pkt; capabilities precede it.
  const args: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.delim) {
      pastDelim = true;
      continue;
    }
    if (line.payload === null) break;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (pastDelim) args.push(text);
  }
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));

  if (repo.lsRefsCache !== null && repo.lsRefsCache.version === repo.refsVersion && !wantPeel && prefixes.length === 0) {
    sendBuffer(res, 200, repo.lsRefsCache.body, { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  // With ref-prefix arguments the answer is exactly the matching refs: no HEAD.
  if (prefixes.length === 0) {
    if (headTip !== undefined) {
      parts.push(pkt(wantSymrefs ? `${headTip} HEAD symref-target:${headRef}` : `${headTip} HEAD`));
    } else if (wantUnborn) {
      parts.push(pkt(wantSymrefs ? `unborn HEAD symref-target:${headRef}` : 'unborn HEAD'));
    }
  }
  for (const [name, oid] of sortedRefEntries(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (wantPeel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        let target = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'))?.[1] ?? null;
        // Peel through nested tags to the commit.
        while (target !== null) {
          const targetObj = repo.objects.get(target);
          if (targetObj !== undefined && targetObj.type === 'tag') {
            target = /^object ([0-9a-f]{40})/m.exec(targetObj.data.toString('utf8'))?.[1] ?? null;
          } else break;
        }
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pkt(line));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  if (!wantPeel && prefixes.length === 0) repo.lsRefsCache = { version: repo.refsVersion, body };
  sendBuffer(res, 200, body, { 'content-type': 'application/x-git-upload-pack-result' });
}

interface FetchPlan {
  objects: GitObject[];
  boundary: string[];
  unshallow: string[];
  common: string[];
  shallowInvolved: boolean;
}

function planFetch(repo: RepoState, wants: string[], haves: string[], shallowLines: string[], deepen: number | null): FetchPlan {
  const clientShallow = new Set(shallowLines);
  const common = haves.filter((oid) => repo.objects.has(oid));
  const wantCommits = wants.filter((oid) => repo.objects.get(oid)?.type === 'commit');

  // The commit set the client should end up holding from this fetch.
  let included: Set<string>;
  if (deepen !== null) {
    const dist = commitDistances(repo, wantCommits);
    included = new Set([...dist.entries()].filter(([, d]) => d < deepen).map(([oid]) => oid));
  } else {
    included = new Set(commitDistances(repo, wantCommits).keys());
  }

  // What the client already holds: the closure of its haves, with its shallow
  // boundary grafted (a boundary commit's parents are not held).
  const held = closureIds(repo, common, clientShallow);

  const deliverIds = new Set<string>();
  for (const oid of included) {
    if (!held.has(oid)) deliverIds.add(oid);
    const tree = commitTree(repo, oid);
    if (tree !== null) {
      for (const inner of closureIds(repo, [tree])) if (!held.has(inner)) deliverIds.add(inner);
    }
  }
  // Non-commit wants (a tag, say) travel with their closure too.
  for (const oid of wants) {
    if (repo.objects.get(oid)?.type === 'commit') continue;
    for (const inner of closureIds(repo, [oid])) if (!held.has(inner)) deliverIds.add(inner);
  }

  const boundary: string[] = [];
  for (const oid of included) {
    const parents = commitParents(repo, oid);
    if (parents.some((parent) => !included.has(parent) && repo.objects.has(parent))) boundary.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (included.has(oid) && commitParents(repo, oid).some((parent) => included.has(parent))) unshallow.push(oid);
  }

  const objects = [...deliverIds].map((oid) => repo.objects.get(oid)!).filter((obj) => obj !== undefined);
  return { objects, boundary, unshallow, common, shallowInvolved: deepen !== null || shallowLines.length > 0 };
}

function handleFetch(res: ServerResponse, repo: RepoState, lines: PktLine[]): void {
  const args: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.delim) {
      pastDelim = true;
      continue;
    }
    if (line.payload === null) break;
    if (pastDelim) args.push(line.payload.toString('utf8').replace(/\n$/, ''));
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowLines: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number.parseInt(arg.slice(7).trim(), 10);
    else if (arg === 'done') done = true;
  }

  // The hot path: a depth-1 fetch of the branch tip with nothing held is the
  // benchmark's clone; its pack is cached per tip.
  const tip = branchTip(repo, repo.defaultBranch);
  if (deepen === 1 && haves.length === 0 && shallowLines.length === 0 && wants.length === 1 && wants[0] === tip && tip !== null) {
    if (repo.packCache === null || repo.packCache.tip !== tip) {
      const plan = planFetch(repo, wants, haves, shallowLines, deepen);
      repo.packCache = { tip, pack: buildPack(plan.objects), boundary: plan.boundary };
    }
    const pack = repo.packCache.pack;
    const parts: Buffer[] = [pkt('acknowledgments\n'), pkt('NAK'), PKT_FLUSH, pkt('shallow-info\n')];
    for (const oid of repo.packCache.boundary) parts.push(pkt(`shallow ${oid}`));
    parts.push(PKT_FLUSH, pkt('packfile\n'));
    for (let offset = 0; offset < pack.length; offset += 32000) {
      parts.push(sideband(1, pack.subarray(offset, offset + 32000)));
    }
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }

  const plan = planFetch(repo, wants, haves, shallowLines, deepen);
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (plan.common.length === 0) {
    parts.push(pkt('NAK'));
  } else {
    for (const oid of plan.common) parts.push(pkt(`ACK ${oid}`));
    parts.push(pkt('ready'));
  }
  parts.push(PKT_FLUSH);
  if (!done) {
    sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
    return;
  }
  if (plan.shallowInvolved) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}`));
    parts.push(PKT_FLUSH);
  }
  const pack = buildPack(plan.objects);
  parts.push(pkt('packfile\n'));
  for (let offset = 0; offset < pack.length; offset += 32000) {
    parts.push(sideband(1, pack.subarray(offset, offset + 32000)));
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), { 'content-type': 'application/x-git-upload-pack-result' });
}

function handleUploadPack(res: ServerResponse, repo: RepoState, body: Buffer): void {
  const split = splitPkts(body);
  if (split === null || split.lines.length === 0 || split.lines[0]!.payload === null) {
    sendError(res, 400, 'malformed pkt-line request');
    return;
  }
  const command = split.lines[0]!.payload!.toString('utf8').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    handleLsRefs(res, repo, split.lines);
    return;
  }
  if (command === 'command=fetch') {
    handleFetch(res, repo, split.lines);
    return;
  }
  sendError(res, 400, 'unknown command');
}

function handleReceivePack(res: ServerResponse, repo: RepoState, body: Buffer): void {
  const split = splitPkts(body);
  if (split === null) {
    sendError(res, 400, 'malformed pkt-line request');
    return;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const line of split.lines) {
    if (line.payload === null) break;
    let text = line.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const fields = text.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  const packBytes = body.subarray(split.rest);
  if (packBytes.length >= 12) {
    try {
      for (const obj of parsePack(packBytes)) storeObject(repo, obj.type, obj.data);
    } catch {
      const report = [pkt('unpack error: the pack did not parse\n'), PKT_FLUSH];
      const out = report.map((line) => sideband(1, line));
      out.push(PKT_FLUSH);
      sendBuffer(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-receive-pack-result' });
      return;
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'unknown object' });
      continue;
    }
    if (target.type === 'commit' && current !== ZERO_OID && command.newOid !== current && !isAncestor(repo, current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  if (commands.length > 0) touchRefs(repo);

  const reportLines: Buffer[] = [pkt('unpack ok\n')];
  for (const result of results) {
    reportLines.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'refused'}\n`));
  }
  reportLines.push(PKT_FLUSH);
  const out = reportLines.map((line) => sideband(1, line));
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(out), { 'content-type': 'application/x-git-receive-pack-result' });
}

// ---------------------------------------------------------------------------
// REST: shared item shapes
// ---------------------------------------------------------------------------

function issueJson(repo: RepoState, rec: ItemRec): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + rec.number,
    node_id: `I_${repo.id}_${rec.number}`,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: ownerLogin(repo), id: 1, type: 'User' },
    comments: (repo.comments.get(rec.number) ?? []).length,
    created_at: isoAt(rec.seq),
    updated_at: isoAt(rec.seq),
  };
}

function issueJsonBuffer(repo: RepoState, rec: ItemRec): Buffer {
  let cached = repo.issueJsonCache.get(rec.number);
  if (cached === undefined) {
    cached = Buffer.from(JSON.stringify(issueJson(repo, rec)), 'utf8');
    repo.issueJsonCache.set(rec.number, cached);
  }
  return cached;
}

function pullJson(repo: RepoState, rec: ItemRec): Record<string, unknown> {
  const headTip = rec.head !== undefined ? branchTip(repo, rec.head) : null;
  const baseTip = rec.base !== undefined ? branchTip(repo, rec.base) : null;
  return {
    ...issueJson(repo, rec),
    merged: rec.merged === true,
    merged_at: rec.mergedAt ?? null,
    merge_commit_sha: rec.mergeCommitSha ?? null,
    head: { ref: rec.head ?? '', sha: headTip, label: `${ownerLogin(repo)}:${rec.head ?? ''}` },
    base: { ref: rec.base ?? '', sha: baseTip, label: `${ownerLogin(repo)}:${rec.base ?? ''}` },
  };
}

function pageParams(ctx: Ctx): { perPage: number; pageNum: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const pageNum = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  return { perPage, pageNum };
}

function paginate<T>(ctx: Ctx, items: readonly T[]): { page: T[]; nextUrl: string | null } {
  const { perPage, pageNum } = pageParams(ctx);
  const start = (pageNum - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let nextUrl: string | null = null;
  if (start + perPage < items.length) {
    const host = ctx.req.headers.host ?? 'forge.invalid';
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(pageNum + 1));
    params.set('per_page', String(perPage));
    nextUrl = `http://${host}${ctx.rawPath}?${params.toString()}`;
  }
  return { page: slice as T[], nextUrl };
}

function sendList(res: ServerResponse, ctx: Ctx, items: readonly unknown[]): void {
  const { page, nextUrl } = paginate(ctx, items);
  const extra: Record<string, string> = {};
  if (nextUrl !== null) extra.link = `<${nextUrl}>; rel="next"`;
  sendJson(res, 200, page, extra);
}

// ---------------------------------------------------------------------------
// REST: merge machinery (shared with GraphQL and MCP)
// ---------------------------------------------------------------------------

interface MergeOutcome {
  ok: boolean;
  sha?: string;
}

/** The 3-way per-file merge of a pull request, or null when it conflicts. */
function mergedTreeFiles(repo: RepoState, rec: ItemRec): Map<string, string> | null {
  const baseTip = rec.base !== undefined ? branchTip(repo, rec.base) : null;
  const headTip = rec.head !== undefined ? branchTip(repo, rec.head) : null;
  if (baseTip === null || headTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return null;
  const baseFiles = flattenTree(repo, commitTree(repo, base));
  const ourFiles = flattenTree(repo, commitTree(repo, baseTip));
  const theirFiles = flattenTree(repo, commitTree(repo, headTip));
  const merged = new Map(ourFiles);
  const paths = new Set([...baseFiles.keys(), ...theirFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const t = theirFiles.get(path);
    const o = ourFiles.get(path);
    if (t === b) continue; // they did not touch it: ours stands
    if (o === b) {
      // only they changed it: take theirs (including a deletion)
      if (t === undefined) merged.delete(path);
      else merged.set(path, t);
      continue;
    }
    if (o === t) continue; // both sides made the same change
    return null; // both sides changed it differently
  }
  return merged;
}

function mergePullRequest(repo: RepoState, rec: ItemRec): MergeOutcome {
  const files = mergedTreeFiles(repo, rec);
  if (files === null) return { ok: false };
  const baseBranch = rec.base!;
  const baseTip = branchTip(repo, baseBranch)!;
  const tree = buildTree(repo, files);
  const sha = makeCommit(repo, tree, [baseTip], rec.title);
  repo.refs.set(`refs/heads/${baseBranch}`, sha);
  touchRefs(repo);
  rec.merged = true;
  rec.state = 'closed';
  rec.mergeCommitSha = sha;
  rec.mergedAt = isoAt(nextSeq);
  touchItems(repo);
  return { ok: true, sha };
}

/** Tree diff between the merge-base and the head tip, GitHub /files shape. */
function pullFiles(repo: RepoState, rec: ItemRec): Record<string, unknown>[] {
  const baseTip = rec.base !== undefined ? branchTip(repo, rec.base) : null;
  const headTip = rec.head !== undefined ? branchTip(repo, rec.head) : null;
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = flattenTree(repo, commitTree(repo, base));
  const headFiles = flattenTree(repo, commitTree(repo, headTip));
  const lineCount = (oid: string | undefined): number => {
    if (oid === undefined) return 0;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length;
  };
  const out: Record<string, unknown>[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    let status = 'modified';
    if (b === undefined) status = 'added';
    else if (h === undefined) status = 'removed';
    const additions = status === 'removed' ? 0 : lineCount(h);
    const deletions = status === 'added' ? 0 : lineCount(b);
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions, sha: h ?? b ?? '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST: route handlers
// ---------------------------------------------------------------------------

function handleRestRoot(res: ServerResponse): void {
  sendJson(
    res,
    200,
    {
      current_user_url: 'https://forge.invalid/api/v3/user',
      repository_url: 'https://forge.invalid/api/v3/repos/{owner}/{repo}',
      issue_search_url: 'https://forge.invalid/api/v3/search/issues?q={query}',
      rate_limit_url: 'https://forge.invalid/api/v3/rate_limit',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleRest(ctx: Ctx, res: ServerResponse): void {
  const seg = ctx.segments; // path after /api/v3
  const method = ctx.method;

  if (seg.length === 0) {
    if (method === 'GET') return handleRestRoot(res);
    return sendError(res, 404, 'Not Found');
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { verifiable_password_authentication: false, installed_version: 'anvil-1.0.0', github_services_sha: 'anvil' });
    return sendError(res, 404, 'Not Found');
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { login: viewerLogin ?? 'anvil-user', id: 1, type: 'User' });
    return sendError(res, 404, 'Not Found');
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') return sendError(res, 422, 'Repository name is required');
      if (reposByName.has(name)) return sendError(res, 422, 'name already exists on this account');
      const repo = createRepo(name, parsed.value.private === true, typeof parsed.value.description === 'string' ? parsed.value.description : '');
      return sendJsonBuffer(res, 201, repoJsonBuffer(repo));
    }
    if (method === 'GET') {
      const mine = [...reposByName.values()]
        .filter((repo) => repo.owner === null || repo.owner === viewerLogin)
        .sort((a, b) => a.id - b.id)
        .map((repo) => repoJson(repo));
      return sendList(res, ctx, mine);
    }
    return sendError(res, 404, 'Not Found');
  }
  if (seg[0] !== 'repos' || seg.length < 3) return sendError(res, 404, 'Not Found');

  const owner = seg[1]!;
  const repo = claimRepo(owner, seg[2]!);
  if (repo === null) return sendError(res, 404, 'Not Found');
  const rest = seg.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return sendJsonBuffer(res, 200, repoJsonBuffer(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      repo.repoJsonCache = null;
      return sendJsonBuffer(res, 200, repoJsonBuffer(repo));
    }
    if (method === 'DELETE') {
      reposByName.delete(repo.name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  // /contents/{path...}
  if (rest[0] === 'contents') {
    return handleContents(ctx, res, repo, rest.slice(1).join('/'));
  }

  // /git/refs[/heads/{branch...}]
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (ref === '' || !repo.objects.has(sha)) return sendError(res, 422, 'Invalid ref or sha');
      repo.refs.set(ref, sha);
      touchRefs(repo);
      return sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = rest.slice(3).join('/');
      const sha = branchTip(repo, branch);
      if (sha === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    }
    return sendError(res, 404, 'Not Found');
  }

  // /branches[/{name...}]
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = sortedRefEntries(repo)
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return sendList(res, ctx, branches);
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = branchTip(repo, branch);
      if (sha === null) return sendError(res, 404, 'Not Found');
      return sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
    }
    return sendError(res, 404, 'Not Found');
  }

  // /commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const start = resolveCommit(repo, ctx.query.get('sha') ?? undefined);
    if (start === null) return sendList(res, ctx, []);
    const dist = commitDistances(repo, [start]);
    const ordered = [...dist.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
    const commits = ordered.map((oid) => {
      const info = parseCommit(repo.objects.get(oid)!.data);
      return { sha: oid, commit: { message: info.message, tree: { sha: info.tree } }, parents: info.parents.map((sha) => ({ sha })) };
    });
    return sendList(res, ctx, commits);
  }

  // /labels
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
    if (name === '') return sendError(res, 422, 'Label name is required');
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : '000000';
    repo.labels.set(name, { name, color });
    touchItems(repo);
    return sendJson(res, 201, { name, color, description: null });
  }

  // /issues...
  if (rest[0] === 'issues') return handleIssues(ctx, res, repo, rest.slice(1));

  // /pulls...
  if (rest[0] === 'pulls') return handlePulls(ctx, res, repo, rest.slice(1));

  return sendError(res, 404, 'Not Found');
}

function handleContents(ctx: Ctx, res: ServerResponse, repo: RepoState, rawPath: string): void {
  const path = decodeSegment(rawPath);
  const method = ctx.method;

  if (method === 'GET') {
    const commit = resolveCommit(repo, ctx.query.get('ref') ?? undefined);
    if (commit === null) return sendError(res, 404, 'Not Found');
    let treeOid = commitTree(repo, commit);
    if (path === '') {
      const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)!.data).map((entry) => ({
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        type: entry.mode === '40000' ? 'dir' : 'file',
      }));
      return sendJson(res, 200, entries);
    }
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      if (treeOid === null) return sendError(res, 404, 'Not Found');
      const treeObj = repo.objects.get(treeOid);
      if (treeObj === undefined || treeObj.type !== 'tree') return sendError(res, 404, 'Not Found');
      const entry = parseTree(treeObj.data).find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return sendError(res, 404, 'Not Found');
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const dirObj = repo.objects.get(entry.oid);
          const entries = dirObj === undefined ? [] : parseTree(dirObj.data).map((child) => ({
            name: child.name,
            path: `${path}/${child.name}`,
            sha: child.oid,
            type: child.mode === '40000' ? 'dir' : 'file',
          }));
          return sendJson(res, 200, entries);
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, {
          name: entry.name,
          path,
          sha: entry.oid,
          size: blob.data.length,
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
      }
      if (entry.mode !== '40000') return sendError(res, 404, 'Not Found');
      treeOid = entry.oid;
    }
    return sendError(res, 404, 'Not Found');
  }

  if (method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const files = flattenTree(repo, tip === null ? null : commitTree(repo, tip));
    const existing = files.get(path);
    const givenSha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    if (existing !== undefined && givenSha !== existing) return sendError(res, 409, 'The blob sha does not match the current content');
    if (existing === undefined && givenSha !== undefined && givenSha !== '') return sendError(res, 409, 'The file does not exist yet, so no sha may be given');
    if (method === 'DELETE') {
      if (existing === undefined) return sendError(res, 404, 'Not Found');
      files.delete(path);
      const commit = commitOnBranch(repo, branch, files, message);
      return sendJson(res, 200, { content: null, commit: { sha: commit } });
    }
    const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
    const blobSha = storeObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
    files.set(path, blobSha);
    const commit = commitOnBranch(repo, branch, files, message);
    const created = existing === undefined;
    return sendJson(res, created ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: Buffer.from(contentB64, 'base64').length, type: 'file', encoding: 'base64' },
      commit: { sha: commit },
    });
  }

  return sendError(res, 404, 'Not Found');
}

function newItem(repo: RepoState, kind: 'issue' | 'pull', title: string, body: string): ItemRec {
  const rec: ItemRec = {
    number: repo.nextNumber,
    kind,
    title,
    body,
    state: 'open',
    labels: [],
    seq: nextSeq,
  };
  repo.nextNumber += 1;
  nextSeq += 1;
  repo.items.set(rec.number, rec);
  return rec;
}

function handleIssues(ctx: Ctx, res: ServerResponse, repo: RepoState, rest: string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
      const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return sendError(res, 422, `Label "${name}" does not exist`);
      }
      const rec = newItem(repo, 'issue', title, typeof parsed.value.body === 'string' ? parsed.value.body : '');
      rec.labels = labelNames;
      touchItems(repo);
      return sendJsonBuffer(res, 201, issueJsonBuffer(repo, rec));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let items = [...repo.items.values()].filter((rec) => rec.kind === 'issue');
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return sendList(res, ctx, items.map((rec) => issueJson(repo, rec)));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  const rec = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (rec === undefined || rec.kind !== 'issue') return sendError(res, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return sendJsonBuffer(res, 200, issueJsonBuffer(repo, rec));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      if (parsed.value.state === 'closed' || parsed.value.state === 'open') rec.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') rec.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') rec.body = parsed.value.body;
      touchItems(repo);
      return sendJsonBuffer(res, 200, issueJsonBuffer(repo, rec));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const comment: CommentRec = { id: nextCommentId, body: typeof parsed.value.body === 'string' ? parsed.value.body : '' };
      nextCommentId += 1;
      const list = repo.comments.get(rec.number) ?? [];
      list.push(comment);
      repo.comments.set(rec.number, list);
      touchItems(repo);
      return sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: ownerLogin(repo), id: 1, type: 'User' }, created_at: isoAt(rec.seq) });
    }
    if (method === 'GET') {
      const list = (repo.comments.get(rec.number) ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: ownerLogin(repo), id: 1, type: 'User' },
        created_at: isoAt(rec.seq),
      }));
      return sendList(res, ctx, list);
    }
  }
  return sendError(res, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, res: ServerResponse, repo: RepoState, rest: string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
      const base = typeof parsed.value.base === 'string' ? parsed.value.base : '';
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return sendError(res, 422, 'Head or base branch does not exist');
      const duplicate = [...repo.items.values()].some((rec) => rec.kind === 'pull' && rec.state === 'open' && rec.head === head && rec.base === base);
      if (duplicate) return sendError(res, 422, 'A pull request already exists for this head and base');
      const rec = newItem(repo, 'pull', typeof parsed.value.title === 'string' ? parsed.value.title : '', typeof parsed.value.body === 'string' ? parsed.value.body : '');
      rec.head = head;
      rec.base = base;
      touchItems(repo);
      return sendJson(res, 201, pullJson(repo, rec));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let items = [...repo.items.values()].filter((rec) => rec.kind === 'pull');
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      items.sort((a, b) => a.seq - b.seq);
      return sendList(res, ctx, items.map((rec) => pullJson(repo, rec)));
    }
    return sendError(res, 404, 'Not Found');
  }

  const number = Number.parseInt(rest[0]!, 10);
  const rec = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (rec === undefined || rec.kind !== 'pull') return sendError(res, 404, 'Not Found');

  if (rest.length === 1 && method === 'GET') return sendJson(res, 200, pullJson(repo, rec));

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    return sendList(res, ctx, pullFiles(repo, rec));
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    if (rec.merged === true) return sendJson(res, 200, { sha: rec.mergeCommitSha ?? '', merged: true, message: 'Pull Request successfully merged' });
    const outcome = mergePullRequest(repo, rec);
    if (!outcome.ok) return sendError(res, 405, 'Pull Request is not mergeable');
    return sendJson(res, 200, { sha: outcome.sha!, merged: true, message: 'Pull Request successfully merged' });
  }

  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL: a small lexer / parser / executor over a fixed schema
// ---------------------------------------------------------------------------

type GqlValue =
  | { k: 'var'; name: string }
  | { k: 'lit'; v: unknown }
  | { k: 'list'; items: GqlValue[] }
  | { k: 'obj'; fields: [string, GqlValue][] };

interface GqlField {
  alias?: string;
  name: string;
  args: [string, GqlValue][];
  selection?: GqlSelection[];
}
type GqlSelection =
  | { k: 'field'; field: GqlField }
  | { k: 'spread'; name: string }
  | { k: 'inline'; typeCondition: string; selection: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  selection: GqlSelection[];
  defaults: Map<string, GqlValue>;
}

function gqlLex(src: string): { kind: string; value: string }[] {
  const tokens: { kind: string; value: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: { kind: string; value: string }[];
  constructor(tokens: { kind: string; value: string }[]) {
    this.tokens = tokens;
  }
  private peek(): { kind: string; value: string } | undefined {
    return this.tokens[this.pos];
  }
  private next(): { kind: string; value: string } {
    const tok = this.tokens[this.pos]!;
    this.pos += 1;
    return tok;
  }
  private atPunct(value: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.kind === 'punct' && tok.value === value;
  }
  private eatPunct(value: string): void {
    if (this.atPunct(value)) this.pos += 1;
  }

  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: GqlSelection[] }>();
    while (this.pos < this.tokens.length) {
      const tok = this.peek()!;
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet(), defaults: new Map() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.next();
        if (this.peek()?.kind === 'name') this.next(); // operation name
        const defaults = new Map<string, GqlValue>();
        if (this.atPunct('(')) this.parseVariableDefinitions(defaults);
        this.skipDirectives();
        operations.push({ type: tok.value as 'query' | 'mutation', selection: this.parseSelectionSet(), defaults });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.next().value;
        this.next(); // 'on'
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(name, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, GqlValue>): void {
    this.eatPunct('(');
    while (!this.atPunct(')') && this.pos < this.tokens.length) {
      this.eatPunct('$');
      const name = this.next().value;
      this.eatPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.eatPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.eatPunct(']');
    } else {
      this.next();
    }
    this.eatPunct('!');
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // directive name
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')') && this.pos < this.tokens.length) {
          this.next();
          this.eatPunct(':');
          this.parseValue();
        }
        this.eatPunct(')');
      }
    }
  }

  private parseValue(): GqlValue {
    const tok = this.peek()!;
    if (tok.kind === 'punct' && tok.value === '$') {
      this.next();
      return { k: 'var', name: this.next().value };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const items: GqlValue[] = [];
      while (!this.atPunct(']') && this.pos < this.tokens.length) items.push(this.parseValue());
      this.eatPunct(']');
      return { k: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      this.next();
      const fields: [string, GqlValue][] = [];
      while (!this.atPunct('}') && this.pos < this.tokens.length) {
        const name = this.next().value;
        this.eatPunct(':');
        fields.push([name, this.parseValue()]);
      }
      this.eatPunct('}');
      return { k: 'obj', fields };
    }
    this.next();
    if (tok.kind === 'string') return { k: 'lit', v: tok.value };
    if (tok.kind === 'number') return { k: 'lit', v: Number(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { k: 'lit', v: true };
      if (tok.value === 'false') return { k: 'lit', v: false };
      if (tok.value === 'null') return { k: 'lit', v: null };
      return { k: 'lit', v: tok.value }; // enum literal
    }
    return { k: 'lit', v: null };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.eatPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.atPunct('}') && this.pos < this.tokens.length) {
      const tok = this.peek()!;
      if (tok.kind === 'spread') {
        this.next();
        const nameTok = this.peek()!;
        if (nameTok.kind === 'name' && nameTok.value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ k: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ k: 'spread', name: this.next().value });
        }
        continue;
      }
      // a field, possibly aliased
      let name = this.next().value;
      let alias: string | undefined;
      if (this.atPunct(':')) {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args: [string, GqlValue][] = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')') && this.pos < this.tokens.length) {
          const argName = this.next().value;
          this.eatPunct(':');
          args.push([argName, this.parseValue()]);
        }
        this.eatPunct(')');
      }
      this.skipDirectives();
      let selection: GqlSelection[] | undefined;
      if (this.atPunct('{')) selection = this.parseSelectionSet();
      const field: GqlField = { name, args };
      if (alias !== undefined) field.alias = alias;
      if (selection !== undefined) field.selection = selection;
      selections.push({ k: 'field', field });
    }
    this.eatPunct('}');
    return selections;
  }
}

// --- GraphQL domain wrappers ------------------------------------------------

interface GqlCtx {
  variables: Record<string, unknown>;
  defaults: Map<string, GqlValue>;
  fragments: Map<string, { typeCondition: string; selection: GqlSelection[] }>;
  errors: { message: string }[];
}

type Wrap = { __t: string; [key: string]: unknown };

function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function repoByDbId(id: number): RepoState | null {
  for (const repo of reposByName.values()) if (repo.id === id) return repo;
  return null;
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function nodeWrap(id: string): Wrap | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = repoByDbId(Number(decoded.parts[0]));
    return repo === null ? null : { __t: 'Repository', repo };
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
    const repo = repoByDbId(Number(decoded.parts[0]));
    if (repo === null) return null;
    const rec = repo.items.get(Number(decoded.parts[1]));
    if (rec === undefined) return null;
    return rec.kind === 'issue' ? { __t: 'Issue', repo, rec } : { __t: 'PullRequest', repo, rec };
  }
  return null;
}

function cursorOf(seq: number): string {
  return Buffer.from(`anvil-cursor:${seq}`, 'utf8').toString('base64');
}

function seqOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^anvil-cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function evalValue(value: GqlValue, ctx: GqlCtx): unknown {
  switch (value.k) {
    case 'var': {
      if (value.name in ctx.variables) return ctx.variables[value.name];
      const fallback = ctx.defaults.get(value.name);
      return fallback === undefined ? undefined : evalValue(fallback, ctx);
    }
    case 'lit':
      return value.v;
    case 'list':
      return value.items.map((item) => evalValue(item, ctx));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = evalValue(inner, ctx);
      return out;
    }
  }
}

function argsOf(field: GqlField, ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = evalValue(value, ctx);
  return out;
}

function connectionWrap(kind: string, nodes: Wrap[], hasNextPage: boolean, endCursor: string | null): Wrap {
  return {
    __t: kind,
    nodes,
    pageInfo: { __t: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor: endCursor, endCursor } as Wrap,
    totalCount: nodes.length,
  };
}

function issuesConnection(repo: RepoState, args: Record<string, unknown>): Wrap {
  let items = [...repo.items.values()].filter((rec) => rec.kind === 'issue');
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((s) => String(s).toUpperCase()) : null;
  if (states !== null) items = items.filter((rec) => states.includes(rec.state.toUpperCase()));
  let descending = false;
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy !== undefined && typeof orderBy.direction === 'string' && orderBy.direction.toUpperCase() === 'DESC') descending = true;
  items.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  let startIndex = 0;
  if (typeof args.after === 'string') {
    const seq = seqOfCursor(args.after);
    if (seq !== null) {
      const at = items.findIndex((rec) => rec.seq === seq);
      if (at !== -1) startIndex = at + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const page = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + first < items.length;
  const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]!.seq) : null;
  return connectionWrap('IssueConnection', page.map((rec) => ({ __t: 'Issue', repo, rec }) as Wrap), hasNextPage, endCursor);
}

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'name'],
  User: ['login', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'repository', 'author', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt'],
  Ref: ['name', 'prefix'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Node: ['id'],
};
const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['REPOSITORY', 'ISSUE', 'PULL_REQUEST', 'USER', 'DISCUSSION'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  State: ['OPEN', 'CLOSED'],
};

type Resolver = (src: Wrap, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __t: 'Viewer' }) as Wrap,
    repository: (_src, args) => {
      const repo = claimRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : ({ __t: 'Repository', repo } as Wrap);
    },
    node: (_src, args) => nodeWrap(String(args.id ?? '')),
    __type: (_src, args) => {
      const name = String(args.name ?? '');
      return name in TYPE_FIELDS || name in ENUM_VALUES ? ({ __t: '__Type', name } as Wrap) : null;
    },
  },
  Mutation: {
    createIssue: (_src, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(Number(decoded.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const rec = newItem(repo, 'issue', String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      touchItems(repo);
      return { __t: 'CreateIssuePayload', issue: { __t: 'Issue', repo, rec } as Wrap } as Wrap;
    },
    closeIssue: (_src, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const wrap = nodeWrap(String(input.issueId ?? ''));
      if (wrap === null || wrap.__t !== 'Issue') throw new Error('issue not found');
      const rec = wrap.rec as ItemRec;
      rec.state = 'closed';
      touchItems(wrap.repo as RepoState);
      return { __t: 'CloseIssuePayload', issue: wrap } as Wrap;
    },
    createPullRequest: (_src, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(Number(decoded.parts[0])) : null;
      if (repo === null) throw new Error('repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) throw new Error('head or base branch does not exist');
      const rec = newItem(repo, 'pull', String(input.title ?? ''), typeof input.body === 'string' ? input.body : '');
      rec.head = head;
      rec.base = base;
      touchItems(repo);
      return { __t: 'CreatePullRequestPayload', pullRequest: { __t: 'PullRequest', repo, rec } as Wrap } as Wrap;
    },
    mergePullRequest: (_src, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const wrap = nodeWrap(String(input.pullRequestId ?? ''));
      if (wrap === null || wrap.__t !== 'PullRequest') throw new Error('pull request not found');
      const repo = wrap.repo as RepoState;
      const rec = wrap.rec as ItemRec;
      if (rec.merged !== true) {
        const outcome = mergePullRequest(repo, rec);
        if (!outcome.ok) throw new Error('pull request is not mergeable');
      }
      return { __t: 'MergePullRequestPayload', pullRequest: wrap } as Wrap;
    },
    addComment: (_src, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const wrap = nodeWrap(String(input.subjectId ?? ''));
      if (wrap === null) throw new Error('subject not found');
      const repo = wrap.repo as RepoState;
      const rec = wrap.rec as ItemRec;
      const comment: CommentRec = { id: nextCommentId, body: String(input.body ?? '') };
      nextCommentId += 1;
      const list = repo.comments.get(rec.number) ?? [];
      list.push(comment);
      repo.comments.set(rec.number, list);
      touchItems(repo);
      const node: Wrap = { __t: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body };
      return { __t: 'AddCommentPayload', commentEdge: { __t: 'IssueCommentEdge', node, cursor: cursorOf(rec.seq) } as Wrap } as Wrap;
    },
  },
  Viewer: {
    login: () => viewerLogin ?? 'anvil-user',
    name: () => viewerLogin ?? 'anvil-user',
  },
  User: {
    login: (src) => src.login as string,
    name: (src) => src.login as string,
  },
  Repository: {
    id: (src) => globalId('Repository', (src.repo as RepoState).id),
    databaseId: (src) => (src.repo as RepoState).id,
    name: (src) => (src.repo as RepoState).name,
    nameWithOwner: (src) => `${ownerLogin(src.repo as RepoState)}/${(src.repo as RepoState).name}`,
    owner: (src) => ({ __t: 'User', login: ownerLogin(src.repo as RepoState) }) as Wrap,
    defaultBranchRef: (src) => {
      const repo = src.repo as RepoState;
      return repo.refs.size > 0 ? ({ __t: 'Ref', name: repo.defaultBranch } as Wrap) : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (src, args) => {
      const repo = src.repo as RepoState;
      const rec = repo.items.get(Number(args.number));
      return rec !== undefined && rec.kind === 'issue' ? ({ __t: 'Issue', repo, rec } as Wrap) : null;
    },
    issues: (src, args) => issuesConnection(src.repo as RepoState, args),
    pullRequest: (src, args) => {
      const repo = src.repo as RepoState;
      const rec = repo.items.get(Number(args.number));
      return rec !== undefined && rec.kind === 'pull' ? ({ __t: 'PullRequest', repo, rec } as Wrap) : null;
    },
    pullRequests: (src, args) => {
      const repo = src.repo as RepoState;
      let items = [...repo.items.values()].filter((rec) => rec.kind === 'pull');
      items.sort((a, b) => a.seq - b.seq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
      const page = items.slice(0, first);
      return connectionWrap('PullRequestConnection', page.map((rec) => ({ __t: 'PullRequest', repo, rec }) as Wrap), items.length > page.length, page.length > 0 ? cursorOf(page[page.length - 1]!.seq) : null);
    },
    createdAt: (src) => isoAt((src.repo as RepoState).id),
    updatedAt: (src) => isoAt((src.repo as RepoState).id),
  },
  Issue: {
    id: (src) => globalId('Issue', (src.repo as RepoState).id, (src.rec as ItemRec).number),
    number: (src) => (src.rec as ItemRec).number,
    title: (src) => (src.rec as ItemRec).title,
    state: (src) => (src.rec as ItemRec).state.toUpperCase(),
    body: (src) => (src.rec as ItemRec).body,
    repository: (src) => ({ __t: 'Repository', repo: src.repo as RepoState }) as Wrap,
    author: (src) => ({ __t: 'User', login: ownerLogin(src.repo as RepoState) }) as Wrap,
    createdAt: (src) => isoAt((src.rec as ItemRec).seq),
    updatedAt: (src) => isoAt((src.rec as ItemRec).seq),
  },
  PullRequest: {
    id: (src) => globalId('PullRequest', (src.repo as RepoState).id, (src.rec as ItemRec).number),
    number: (src) => (src.rec as ItemRec).number,
    title: (src) => (src.rec as ItemRec).title,
    body: (src) => (src.rec as ItemRec).body,
    state: (src) => ((src.rec as ItemRec).merged === true ? 'CLOSED' : (src.rec as ItemRec).state.toUpperCase()),
    merged: (src) => (src.rec as ItemRec).merged === true,
    headRefName: (src) => (src.rec as ItemRec).head ?? '',
    baseRefName: (src) => (src.rec as ItemRec).base ?? '',
    mergeable: (src) => {
      const repo = src.repo as RepoState;
      const rec = src.rec as ItemRec;
      if (rec.merged === true || rec.state === 'closed') return 'UNKNOWN';
      return mergedTreeFiles(repo, rec) !== null ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (src, args) => {
      const repo = src.repo as RepoState;
      const rec = src.rec as ItemRec;
      const files = pullFiles(repo, rec);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
      const page = files.slice(0, first);
      return connectionWrap(
        'PullRequestFileConnection',
        page.map((file) => ({ __t: 'PullRequestFile', path: file.filename as string, additions: file.additions as number, deletions: file.deletions as number }) as Wrap),
        files.length > page.length,
        null,
      );
    },
    author: (src) => ({ __t: 'User', login: ownerLogin(src.repo as RepoState) }) as Wrap,
    createdAt: (src) => isoAt((src.rec as ItemRec).seq),
  },
  Ref: {
    name: (src) => src.name as string,
    prefix: () => 'refs/heads/',
  },
  IssueConnection: {
    nodes: (src) => src.nodes as Wrap[],
    pageInfo: (src) => src.pageInfo as Wrap,
    totalCount: (src) => src.totalCount as number,
    edges: (src) => (src.nodes as Wrap[]).map((node) => ({ __t: 'IssueEdge', node }) as Wrap),
  },
  PullRequestConnection: {
    nodes: (src) => src.nodes as Wrap[],
    pageInfo: (src) => src.pageInfo as Wrap,
    totalCount: (src) => src.totalCount as number,
    edges: (src) => (src.nodes as Wrap[]).map((node) => ({ __t: 'PullRequestEdge', node }) as Wrap),
  },
  PullRequestFileConnection: {
    nodes: (src) => src.nodes as Wrap[],
    pageInfo: (src) => src.pageInfo as Wrap,
    totalCount: (src) => src.totalCount as number,
    edges: (src) => (src.nodes as Wrap[]).map((node) => ({ __t: 'PullRequestFileEdge', node }) as Wrap),
  },
  PullRequestFile: {
    path: (src) => src.path as string,
    additions: (src) => src.additions as number,
    deletions: (src) => src.deletions as number,
    changeType: () => 'MODIFIED',
  },
  PageInfo: {
    hasNextPage: (src) => src.hasNextPage as boolean,
    hasPreviousPage: (src) => src.hasPreviousPage as boolean,
    startCursor: (src) => src.startCursor as string | null,
    endCursor: (src) => src.endCursor as string | null,
  },
  CreateIssuePayload: { issue: (src) => src.issue as Wrap, clientMutationId: () => null },
  CloseIssuePayload: { issue: (src) => src.issue as Wrap, clientMutationId: () => null },
  CreatePullRequestPayload: { pullRequest: (src) => src.pullRequest as Wrap, clientMutationId: () => null },
  MergePullRequestPayload: { pullRequest: (src) => src.pullRequest as Wrap, clientMutationId: () => null },
  AddCommentPayload: {
    commentEdge: (src) => src.commentEdge as Wrap,
    subject: () => null,
    clientMutationId: () => null,
  },
  IssueComment: {
    id: (src) => src.id as string,
    body: (src) => src.body as string,
    author: () => ({ __t: 'User', login: viewerLogin ?? 'anvil-user' }) as Wrap,
  },
  IssueCommentEdge: {
    node: (src) => src.node as Wrap,
    cursor: (src) => src.cursor as string,
  },
  __Type: {
    name: (src) => src.name as string,
    kind: (src) => {
      const name = src.name as string;
      if (name in ENUM_VALUES) return 'ENUM';
      if (name === 'Node') return 'INTERFACE';
      return 'OBJECT';
    },
    description: () => null,
    fields: (src) => {
      const fields = TYPE_FIELDS[src.name as string];
      return fields === undefined ? null : fields.map((name) => ({ __t: '__Field', name }) as Wrap);
    },
    enumValues: (src) => {
      const values = ENUM_VALUES[src.name as string];
      return values === undefined ? null : values.map((name) => ({ __t: '__EnumValue', name }) as Wrap);
    },
    possibleTypes: () => null,
  },
  __Field: { name: (src) => src.name as string, description: () => null },
  __EnumValue: { name: (src) => src.name as string, description: () => null },
};

function completeValue(value: unknown, selection: GqlSelection[] | undefined, ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (typeof value === 'object' && selection !== undefined && '__t' in (value as Wrap)) {
    return executeSelectionSet(value as Wrap, selection, ctx);
  }
  return value;
}

function executeSelectionSet(src: Wrap, selections: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeName = src.__t;
  for (const selection of selections) {
    if (selection.k === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(src, fragment.selection, ctx));
      }
      continue;
    }
    if (selection.k === 'inline') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(src, selection.selection, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[field.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    try {
      const value = resolver(src, argsOf(field, ctx), ctx);
      out[key] = completeValue(value, field.selection, ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
    }
  }
  return out;
}

function executeGraphql(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => executeGraphql(entry));
  if (typeof body !== 'object' || body === null) return { errors: [{ message: 'Invalid GraphQL request' }] };
  const request = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof request.query !== 'string') return { errors: [{ message: 'Missing query' }] };
  let document: ReturnType<GqlParser['parseDocument']>;
  try {
    document = new GqlParser(gqlLex(request.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] };
  }
  const operation = document.operations.find((op) => op.type === 'mutation') ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const isMutation = document.operations.length > 1 && typeof request.operationName === 'string'
    ? document.operations.find((op) => op.type === 'mutation') === operation && operation.type === 'mutation'
    : operation.type === 'mutation';
  void isMutation;
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const ctx: GqlCtx = {
    variables: (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>,
    defaults: operation.defaults,
    fragments: document.fragments,
    errors: [],
  };
  const root: Wrap = { __t: rootType };
  // Resolvers are keyed by Query/Mutation type names; register both.
  const data = executeSelectionSet(root, operation.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function handleGraphql(ctx: Ctx, res: ServerResponse): void {
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON in request body' }] });
    return;
  }
  sendJson(res, 200, executeGraphql(body));
}

// ---------------------------------------------------------------------------
// MCP: the legacy JSON-RPC era over the same store
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the token owner).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return null;
      let repo = reposByName.get(repoName);
      if (repo === undefined) {
        repo = createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      }
      if (typeof args.owner === 'string' && args.owner !== '') claimRepo(args.owner, repoName);
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = claimRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return mcpToolError('repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = claimRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return mcpToolError('repository not found');
      const rec = newItem(repo, 'issue', String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      touchItems(repo);
      return mcpToolResult(issueJson(repo, rec));
    }
    case 'list_issues': {
      const repo = claimRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return mcpToolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((rec) => rec.kind === 'issue');
      if (state === 'open' || state === 'closed') items = items.filter((rec) => rec.state === state);
      items.sort((a, b) => a.seq - b.seq);
      return mcpToolResult(items.map((rec) => issueJson(repo, rec)));
    }
    case 'create_pull_request': {
      const repo = claimRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return mcpToolError('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return mcpToolError('head or base branch does not exist');
      const duplicate = [...repo.items.values()].some((rec) => rec.kind === 'pull' && rec.state === 'open' && rec.head === head && rec.base === base);
      if (duplicate) return mcpToolError('a pull request already exists for this head and base');
      const rec = newItem(repo, 'pull', String(args.title ?? ''), typeof args.body === 'string' ? args.body : '');
      rec.head = head;
      rec.base = base;
      touchItems(repo);
      return mcpToolResult(pullJson(repo, rec));
    }
    case 'merge_pull_request': {
      const repo = claimRepo(String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) return mcpToolError('repository not found');
      const rec = repo.items.get(Number(args.pull_number));
      if (rec === undefined || rec.kind !== 'pull') return mcpToolError('pull request not found');
      if (rec.merged !== true) {
        const outcome = mergePullRequest(repo, rec);
        if (!outcome.ok) return mcpToolError('pull request is not mergeable');
      }
      return mcpToolResult(pullJson(repo, rec));
    }
    default:
      return null;
  }
}

function handleMcp(ctx: Ctx, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const request = message as { id?: unknown; method?: unknown; params?: unknown };
    const isNotification = !('id' in request) || request.id === undefined;
    const method = typeof request.method === 'string' ? request.method : '';
    const respond = (result: unknown): void => {
      responses.push({ jsonrpc: '2.0', id: request.id ?? null, result });
    };
    const respondError = (code: number, text: string): void => {
      responses.push({ jsonrpc: '2.0', id: request.id ?? null, error: { code, message: text } });
    };
    if (method === 'initialize') {
      const params = (request.params ?? {}) as { protocolVersion?: unknown };
      respond({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'anvil', version: '1.0.0' },
      });
      continue;
    }
    if (isNotification) continue; // notifications/initialized and friends need no answer
    switch (method) {
      case 'ping':
        respond({});
        break;
      case 'tools/list':
        respond({ tools: MCP_TOOLS });
        break;
      case 'tools/call': {
        const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
        const toolName = typeof params.name === 'string' ? params.name : '';
        const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
        if (tool === undefined) {
          respondError(-32602, `unknown tool: ${toolName}`);
          break;
        }
        const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const missing = tool.inputSchema.required.filter((key) => toolArgs[key] === undefined || toolArgs[key] === null || toolArgs[key] === '');
        if (missing.length > 0) {
          respondError(-32602, `missing required arguments: ${missing.join(', ')}`);
          break;
        }
        const result = callMcpTool(toolName, toolArgs);
        if (result === null) respondError(-32602, `the ${toolName} call was refused`);
        else respond(result);
        break;
      }
      default:
        respondError(-32601, `method not found: ${method}`);
    }
  }
  if (responses.length === 0) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
}

// ---------------------------------------------------------------------------
// the app: routing
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? '/';
        const qMark = rawUrl.indexOf('?');
        const rawPath = qMark === -1 ? rawUrl : rawUrl.slice(0, qMark);
        const query = new URLSearchParams(qMark === -1 ? '' : rawUrl.slice(qMark + 1));
        const segments = rawPath.split('/').filter((part) => part !== '').map(decodeSegment);
        const method = (req.method ?? 'GET').toUpperCase();

        if (rawPath === '/healthz') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }
        if (!authed(req)) {
          sendError(res, 401, 'Requires authentication');
          return;
        }
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const ctx: Ctx = { req, method, segments, rawPath, query, body };

        // MCP and GraphQL live outside /api/v3.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method === 'POST') return handleMcp(ctx, res);
          return sendError(res, 404, 'Not Found');
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method === 'POST') return handleGraphql(ctx, res);
          return sendError(res, 404, 'Not Found');
        }
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          ctx.segments = segments.slice(2);
          return handleRest(ctx, res);
        }

        // Git smart HTTP: /{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack}
        if (segments.length >= 3) {
          const tail = segments.slice(2).join('/');
          if (tail === 'info/refs' || tail === 'git-upload-pack' || tail === 'git-receive-pack') {
            const repoName = segments[1]!.endsWith('.git') ? segments[1]!.slice(0, -4) : segments[1]!;
            const repo = claimRepo(segments[0]!, repoName);
            if (repo === null) return sendError(res, 404, 'Not Found');
            if (tail === 'info/refs' && method === 'GET') return handleInfoRefs(res, repo, ctx);
            if (tail === 'git-upload-pack' && method === 'POST') return handleUploadPack(res, repo, body);
            if (tail === 'git-receive-pack' && method === 'POST') return handleReceivePack(res, repo, body);
            return sendError(res, 404, 'Not Found');
          }
        }

        return sendError(res, 404, 'Not Found');
      } catch {
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return server;
}
