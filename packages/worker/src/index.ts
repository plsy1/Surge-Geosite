import {
  type RegexMode
} from "@surge-geosite/core";

// 缓存相关的常量
const DEFAULT_SRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set";
const DEFAULT_SRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_SRS_CACHE_TTL_SECONDS = 86400;
const DEFAULT_MRS_UPSTREAM_BASE_URL = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite";
const DEFAULT_MRS_UPSTREAM_USER_AGENT = "surge-geosite-worker/2";
const DEFAULT_MRS_CACHE_TTL_SECONDS = 86400;

const VALID_LIST_NAME = /^[a-z0-9!-]+$/;
const VALID_ATTR_NAME = /^[a-z0-9!-]+$/;

const remoteBinaryCacheLocks = new Map<string, Promise<ReadThroughRemoteBinaryResult>>();

export interface R2ObjectBodyLike {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PutOptionsLike {
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    etag?: string;
  };
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: R2PutOptionsLike): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface AssetsBindingLike {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  GEOSITE_BUCKET: R2BucketLike;
  ASSETS?: AssetsBindingLike;
  SRS_UPSTREAM_BASE_URL?: string;
  SRS_UPSTREAM_USER_AGENT?: string;
  SRS_CACHE_TTL_SECONDS?: string;
  MRS_UPSTREAM_BASE_URL?: string;
  MRS_UPSTREAM_USER_AGENT?: string;
  MRS_CACHE_TTL_SECONDS?: string;
}

export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerDeps {
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface RemoteBinaryCacheMeta {
  version: 1;
  sourceEtag: string | null;
  responseEtag: string;
  fetchedAt: string;
  contentType: string;
}

interface ReadThroughRemoteBinaryOptions {
  namespace: string;
  cacheKey: string;
  upstreamUrl: string;
  userAgent: string;
  ttlSeconds: number;
  fallbackContentType: string;
  now: () => number;
  fetchImpl: typeof fetch;
  serveStaleWhileRevalidate?: boolean;
  onRevalidate?: (promise: Promise<unknown>) => void;
}

type ReadThroughRemoteBinaryResult =
  | { found: false }
  | {
      found: true;
      body: Uint8Array;
      responseEtag: string;
      sourceEtag: string | null;
      contentType: string;
      stale: boolean;
    };

type RemoteBinaryFoundResult = Extract<ReadThroughRemoteBinaryResult, { found: true }>;

export function createWorker(deps: WorkerDeps = {}): {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response>;
  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void>;
} {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = resolveFetchImpl(deps.fetchImpl);

  return {
    async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
      return handleFetch(request, env, ctx, { now, fetchImpl });
    },

    async scheduled(_event: ScheduledEventLike, env: WorkerEnv, _ctx: ExecutionContextLike): Promise<void> {
      // 定时同步任务已迁移到 GitHub Actions
    }
  };
}

async function handleFetch(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContextLike,
  deps: { now: () => number; fetchImpl: typeof fetch }
): Promise<Response> {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const isInternal = hostname === "geosite.internal";
  if (!isInternal && !isLocal) {
    return text(403, "Forbidden: Private API");
  }

  if (request.method !== "GET") {
    return text(405, "method not allowed");
  }
  const path = url.pathname;

  if (path === "/geosite") {
    return handleGeositeIndex(request, env);
  }

  if (path === "/test-scheduled") {
    return json(200, { ok: true, message: "Scheduled tasks are migrated to GitHub Actions." });
  }

  if (path === "/geoip") {
    return handleGeoipIndex(request, env);
  }

  if (path === "/geoip/") {
    return text(400, "missing country code");
  }

  if (path.startsWith("/geoip/")) {
    const country = path.slice("/geoip/".length).toLowerCase().trim();
    if (!country || !VALID_LIST_NAME.test(country)) {
      return text(400, "invalid country code");
    }
    return handleGeoipRules(request, country, env);
  }

  if (path === "/geosite-srs") {
    return text(400, "missing list name");
  }

  if (path.startsWith("/geosite-srs/")) {
    const suffix = path.slice("/geosite-srs/".length);
    const decoded = safeDecodeURIComponent(suffix);
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }

    return handleGeositeSrs(request, decoded, env, deps, ctx);
  }

  if (path === "/geosite-mrs") {
    return text(400, "missing list name");
  }

  if (path.startsWith("/geosite-mrs/")) {
    const suffix = path.slice("/geosite-mrs/".length);
    const decoded = safeDecodeURIComponent(suffix);
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }

    return handleGeositeMrs(request, decoded, env, deps, ctx);
  }

  if (!path.startsWith("/geosite/")) {
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return text(404, "not found");
  }

  const suffix = path.slice("/geosite/".length);
  const segments = suffix.split("/").filter((item) => item.length > 0);
  if (segments.length === 0) {
    return text(404, "not found");
  }

  let mode: RegexMode = "balanced";
  let nameWithFilter: string;

  if (segments.length >= 2 && isRegexMode(segments[0]!)) {
    mode = segments[0] as RegexMode;
    const decoded = safeDecodeURIComponent(segments.slice(1).join("/"));
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }
    nameWithFilter = decoded;
  } else {
    const decoded = safeDecodeURIComponent(segments.join("/"));
    if (decoded === null) {
      return text(400, "invalid path encoding");
    }
    nameWithFilter = decoded;
  }

  return handleGeositeRules(request, mode, nameWithFilter, env);
}

async function handleGeositeIndex(request: Request, env: WorkerEnv): Promise<Response> {
  const key = "index/geosite.json";
  const object = await env.GEOSITE_BUCKET.get(key);
  if (!object) {
    return json(503, { ok: false, error: "geosite data not ready" });
  }

  const etag = (object as any).httpMetadata?.etag ?? (object as any).etag ?? `"${key}"`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300, s-maxage=600, stale-while-revalidate=900",
    etag: etag
  };

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return notModified(headers);
  }

  const body = await object.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers
  });
}

async function handleGeositeRules(
  request: Request,
  mode: RegexMode,
  nameWithFilter: string,
  env: WorkerEnv
): Promise<Response> {
  const { name, filter } = splitNameFilter(nameWithFilter);
  if (!isValidListName(name) || (filter !== null && !isValidAttr(filter))) {
    return text(400, "invalid name");
  }

  const key = `rules/${mode}/${nameWithFilter.toLowerCase()}.txt`;
  const object = await env.GEOSITE_BUCKET.get(key);
  if (!object) {
    return text(404, `list not found: ${nameWithFilter}`);
  }

  const etag = (object as any).httpMetadata?.etag ?? (object as any).etag ?? `"${key}"`;
  const headers = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag: etag,
    "x-mode": mode,
    "x-list": name.toLowerCase(),
    ...(filter ? { "x-filter": filter } : {})
  };

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return notModified(headers);
  }

  const body = await object.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers
  });
}

async function handleGeoipIndex(request: Request, env: WorkerEnv): Promise<Response> {
  const key = "index/geoip.json";
  const object = await env.GEOSITE_BUCKET.get(key);
  if (!object) {
    return json(503, { ok: false, error: "geoip data not ready" });
  }

  const etag = (object as any).httpMetadata?.etag ?? (object as any).etag ?? `"${key}"`;
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300, s-maxage=600, stale-while-revalidate=900",
    etag
  };

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return notModified(headers);
  }

  const body = await object.arrayBuffer();
  return new Response(body, { status: 200, headers });
}

async function handleGeoipRules(request: Request, country: string, env: WorkerEnv): Promise<Response> {
  const key = `geoip/${country}.txt`;
  const object = await env.GEOSITE_BUCKET.get(key);
  if (!object) {
    return text(404, `geoip not found: ${country}`);
  }

  const etag = (object as any).httpMetadata?.etag ?? (object as any).etag ?? `"${key}"`;
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag,
    "x-country": country
  };

  if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
    return notModified(headers);
  }

  const body = await object.arrayBuffer();
  return new Response(body, { status: 200, headers });
}

// 代理 SRS / MRS 相关逻辑（保持原样）
async function handleGeositeSrs(
  request: Request,
  listNameRaw: string,
  env: WorkerEnv,
  deps: { now: () => number; fetchImpl: typeof fetch },
  ctx: ExecutionContextLike
): Promise<Response> {
  const listName = listNameRaw.trim().toLowerCase();
  if (!isValidListName(listName)) {
    return text(400, "invalid name");
  }

  const fileName = `geosite-${listName}.srs`;
  const baseUrl = trimTrailingSlash(env.SRS_UPSTREAM_BASE_URL ?? DEFAULT_SRS_UPSTREAM_BASE_URL);
  const upstreamUrl = `${baseUrl}/${fileName}`;
  const ttlSeconds = parsePositiveInt(env.SRS_CACHE_TTL_SECONDS, DEFAULT_SRS_CACHE_TTL_SECONDS);
  const userAgent = env.SRS_UPSTREAM_USER_AGENT ?? DEFAULT_SRS_UPSTREAM_USER_AGENT;

  const result = await readThroughRemoteBinaryCache(env, {
    namespace: "geosite-srs",
    cacheKey: fileName,
    upstreamUrl,
    userAgent,
    ttlSeconds,
    fallbackContentType: "application/octet-stream",
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    serveStaleWhileRevalidate: true,
    onRevalidate: (promise) => {
      ctx.waitUntil(promise);
    }
  });

  if (!result.found) {
    return text(404, `srs not found: ${listName}`);
  }

  const headers = srsResponseHeaders(result, listName);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), result.responseEtag)) {
    return notModified(headers);
  }

  return new Response(asResponseBody(result.body), {
    status: 200,
    headers
  });
}

async function handleGeositeMrs(
  request: Request,
  listNameRaw: string,
  env: WorkerEnv,
  deps: { now: () => number; fetchImpl: typeof fetch },
  ctx: ExecutionContextLike
): Promise<Response> {
  const listName = listNameRaw.trim().toLowerCase();
  if (!isValidListName(listName)) {
    return text(400, "invalid name");
  }

  const fileName = `${listName}.mrs`;
  const baseUrl = trimTrailingSlash(env.MRS_UPSTREAM_BASE_URL ?? DEFAULT_MRS_UPSTREAM_BASE_URL);
  const upstreamUrl = `${baseUrl}/${fileName}`;
  const ttlSeconds = parsePositiveInt(env.MRS_CACHE_TTL_SECONDS, DEFAULT_MRS_CACHE_TTL_SECONDS);
  const userAgent = env.MRS_UPSTREAM_USER_AGENT ?? DEFAULT_MRS_UPSTREAM_USER_AGENT;

  const result = await readThroughRemoteBinaryCache(env, {
    namespace: "geosite-mrs",
    cacheKey: fileName,
    upstreamUrl,
    userAgent,
    ttlSeconds,
    fallbackContentType: "application/octet-stream",
    now: deps.now,
    fetchImpl: deps.fetchImpl,
    serveStaleWhileRevalidate: true,
    onRevalidate: (promise) => {
      ctx.waitUntil(promise);
    }
  });

  if (!result.found) {
    return text(404, `mrs not found: ${listName}`);
  }

  const headers = srsResponseHeaders(result, listName);
  if (matchesIfNoneMatch(request.headers.get("if-none-match"), result.responseEtag)) {
    return notModified(headers);
  }

  return new Response(asResponseBody(result.body), {
    status: 200,
    headers
  });
}

// 辅助方法
function splitNameFilter(input: string): { name: string; filter: string | null } {
  const normalized = input.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at === -1) {
    return { name: normalized, filter: null };
  }

  const name = normalized.slice(0, at);
  const filter = normalized.slice(at + 1);
  return {
    name,
    filter: filter.length === 0 ? null : filter
  };
}

function srsResponseHeaders(
  result: Extract<ReadThroughRemoteBinaryResult, { found: true }>,
  listName: string
): Record<string, string> {
  return {
    "content-type": result.contentType,
    "cache-control": result.stale
      ? "public, max-age=60, s-maxage=120, stale-while-revalidate=900"
      : "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400",
    etag: result.responseEtag,
    "x-list": listName,
    ...(result.sourceEtag ? { "x-upstream-etag": result.sourceEtag } : {}),
    ...(result.stale ? { "x-stale": "1" } : {})
  };
}

async function readThroughRemoteBinaryCache(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions
): Promise<ReadThroughRemoteBinaryResult> {
  const blobKey = remoteBlobKey(options.namespace, options.cacheKey);
  const metaKey = remoteMetaKey(options.namespace, options.cacheKey);

  const [cachedObject, cachedMetaRaw] = await Promise.all([
    env.GEOSITE_BUCKET.get(blobKey),
    readJson<RemoteBinaryCacheMeta>(env.GEOSITE_BUCKET, metaKey)
  ]);

  const cachedBody = cachedObject ? new Uint8Array(await cachedObject.arrayBuffer()) : null;
  const cachedMeta = await normalizeRemoteBinaryCacheMeta(
    cachedMetaRaw,
    options.namespace,
    options.cacheKey,
    cachedBody,
    options.fallbackContentType
  );
  const cached = cachedBody && cachedMeta ? { body: cachedBody, meta: cachedMeta } : null;

  const nowMs = options.now();
  const ttlMs = options.ttlSeconds * 1000;
  if (cached && isFreshAt(cached.meta.fetchedAt, ttlMs, nowMs)) {
    return remoteBinaryFound({
      body: cached.body,
      responseEtag: cached.meta.responseEtag,
      sourceEtag: cached.meta.sourceEtag,
      contentType: cached.meta.contentType,
      stale: false
    });
  }

  if (cached && options.serveStaleWhileRevalidate) {
    const refresh = ensureRemoteBinaryRevalidated(env, options, cached, blobKey, metaKey)
      .then(() => undefined)
      .catch(() => undefined);
    options.onRevalidate?.(refresh);

    return remoteBinaryFound({
      body: cached.body,
      responseEtag: cached.meta.responseEtag,
      sourceEtag: cached.meta.sourceEtag,
      contentType: cached.meta.contentType,
      stale: true
    });
  }

  return ensureRemoteBinaryRevalidated(env, options, cached, blobKey, metaKey);
}

async function ensureRemoteBinaryRevalidated(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions,
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta } | null,
  blobKey: string,
  metaKey: string
): Promise<ReadThroughRemoteBinaryResult> {
  const lockKey = `${options.namespace}:${options.cacheKey}`;
  const existingLock = remoteBinaryCacheLocks.get(lockKey);
  if (existingLock) {
    return existingLock;
  }

  const lock: Promise<ReadThroughRemoteBinaryResult> = revalidateRemoteBinaryFromUpstream(
    env,
    options,
    cached,
    blobKey,
    metaKey
  ).finally(() => {
    remoteBinaryCacheLocks.delete(lockKey);
  });

  remoteBinaryCacheLocks.set(lockKey, lock);
  return lock;
}

async function revalidateRemoteBinaryFromUpstream(
  env: WorkerEnv,
  options: ReadThroughRemoteBinaryOptions,
  cached: { body: Uint8Array; meta: RemoteBinaryCacheMeta } | null,
  blobKey: string,
  metaKey: string
): Promise<ReadThroughRemoteBinaryResult> {
  const requestHeaders: Record<string, string> = {
    "user-agent": options.userAgent
  };
  if (cached?.meta.sourceEtag) {
    requestHeaders["if-none-match"] = cached.meta.sourceEtag;
  }

  const nowIso = new Date(options.now()).toISOString();

  try {
    const upstreamResponse = await options.fetchImpl(options.upstreamUrl, {
      headers: requestHeaders
    });

    if (upstreamResponse.status === 304 && cached) {
      const refreshedMeta: RemoteBinaryCacheMeta = {
        ...cached.meta,
        fetchedAt: nowIso
      };
      await writeJson(env.GEOSITE_BUCKET, metaKey, refreshedMeta);
      return remoteBinaryFound({
        body: cached.body,
        responseEtag: refreshedMeta.responseEtag,
        sourceEtag: refreshedMeta.sourceEtag,
        contentType: refreshedMeta.contentType,
        stale: false
      });
    }

    if (upstreamResponse.status === 404) {
      await deleteRemoteCacheEntry(env.GEOSITE_BUCKET, blobKey, metaKey);
      return remoteBinaryNotFound();
    }

    if (!upstreamResponse.ok) {
      if (cached) {
        return remoteBinaryFound({
          body: cached.body,
          responseEtag: cached.meta.responseEtag,
          sourceEtag: cached.meta.sourceEtag,
          contentType: cached.meta.contentType,
          stale: true
        });
      }
      throw new Error(`failed to fetch remote binary: ${upstreamResponse.status} ${upstreamResponse.statusText}`);
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? options.fallbackContentType;
    const sourceEtag = normalizeEtag(upstreamResponse.headers.get("etag"));
    const body = new Uint8Array(await upstreamResponse.arrayBuffer());
    const responseEtag = await buildRemoteBinaryEtag(options.namespace, options.cacheKey, sourceEtag, body);

    const nextMeta: RemoteBinaryCacheMeta = {
      version: 1,
      sourceEtag,
      responseEtag,
      fetchedAt: nowIso,
      contentType
    };

    await Promise.all([
      writeBinary(env.GEOSITE_BUCKET, blobKey, body, {
        contentType,
        cacheControl: "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400"
      }),
      writeJson(env.GEOSITE_BUCKET, metaKey, nextMeta)
    ]);

    return remoteBinaryFound({
      body,
      responseEtag,
      sourceEtag,
      contentType,
      stale: false
    });
  } catch (error) {
    if (cached) {
      return remoteBinaryFound({
        body: cached.body,
        responseEtag: cached.meta.responseEtag,
        sourceEtag: cached.meta.sourceEtag,
        contentType: cached.meta.contentType,
        stale: true
      });
    }
    throw error;
  }
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }

  if (ifNoneMatch.trim() === "*") {
    return true;
  }

  return ifNoneMatch
    .split(",")
    .map((item) => item.trim())
    .some((item) => item === etag);
}

function notModified(headers: Record<string, string>): Response {
  const nextHeaders = { ...headers };
  delete nextHeaders["content-type"];
  return new Response(null, {
    status: 304,
    headers: nextHeaders
  });
}

function remoteBlobKey(namespace: string, cacheKey: string): string {
  return `remote-cache/${namespace}/blob/${cacheKey}`;
}

function remoteMetaKey(namespace: string, cacheKey: string): string {
  return `remote-cache/${namespace}/meta/${cacheKey}.json`;
}

async function normalizeRemoteBinaryCacheMeta(
  input: RemoteBinaryCacheMeta | null,
  namespace: string,
  cacheKey: string,
  cachedBody: Uint8Array | null,
  fallbackContentType: string
): Promise<RemoteBinaryCacheMeta | null> {
  if (
    input &&
    typeof input === "object" &&
    input.version === 1 &&
    typeof input.fetchedAt === "string" &&
    typeof input.responseEtag === "string" &&
    typeof input.contentType === "string"
  ) {
    return {
      version: 1,
      sourceEtag: typeof input.sourceEtag === "string" ? input.sourceEtag : null,
      responseEtag: input.responseEtag,
      fetchedAt: input.fetchedAt,
      contentType: input.contentType
    };
  }

  if (!cachedBody) {
    return null;
  }

  return {
    version: 1,
    sourceEtag: null,
    responseEtag: await buildRemoteBinaryEtag(namespace, cacheKey, null, cachedBody),
    fetchedAt: new Date(0).toISOString(),
    contentType: fallbackContentType
  };
}

function isFreshAt(fetchedAt: string, ttlMs: number, nowMs: number): boolean {
  if (ttlMs <= 0) {
    return false;
  }
  const fetchedAtMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) {
    return false;
  }
  return nowMs - fetchedAtMs < ttlMs;
}

async function buildRemoteBinaryEtag(
  namespace: string,
  cacheKey: string,
  sourceEtag: string | null,
  body: Uint8Array
): Promise<string> {
  const stableToken = sourceEtag ?? (await sha256Hex(body));
  const safeToken = stableToken.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `"${namespace}:${cacheKey}:${safeToken}"`;
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }

  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function remoteBinaryNotFound(): ReadThroughRemoteBinaryResult {
  return { found: false };
}

function remoteBinaryFound(
  input: Omit<RemoteBinaryFoundResult, "found">
): RemoteBinaryFoundResult {
  return {
    found: true,
    ...input
  };
}

function asResponseBody(input: Uint8Array): BodyInit {
  return input as unknown as BodyInit;
}

// Check Regex Mode
function isRegexMode(input: string): input is RegexMode {
  return input === "strict" || input === "balanced" || input === "full";
}

function isValidListName(input: string): boolean {
  return VALID_LIST_NAME.test(input);
}

function isValidAttr(input: string): boolean {
  return VALID_ATTR_NAME.test(input);
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readText(bucket: R2BucketLike, key: string): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  return object.text();
}

async function readJson<T>(bucket: R2BucketLike, key: string): Promise<T | null> {
  const content = await readText(bucket, key);
  if (content === null) {
    return null;
  }
  return JSON.parse(content) as T;
}

async function writeText(
  bucket: R2BucketLike,
  key: string,
  content: string,
  options: { contentType?: string; cacheControl?: string } = {}
): Promise<void> {
  const metadata: NonNullable<R2PutOptionsLike["httpMetadata"]> = {
    contentType: options.contentType ?? "text/plain; charset=utf-8"
  };
  if (options.cacheControl) {
    metadata.cacheControl = options.cacheControl;
  }

  await bucket.put(key, content, {
    httpMetadata: metadata
  });
}

async function writeJson(bucket: R2BucketLike, key: string, value: unknown): Promise<void> {
  await bucket.put(key, `${JSON.stringify(value)}\n`, {
    httpMetadata: {
      contentType: "application/json; charset=utf-8"
    }
  });
}

async function writeBinary(
  bucket: R2BucketLike,
  key: string,
  value: Uint8Array,
  options: { contentType: string; cacheControl?: string }
): Promise<void> {
  const metadata: NonNullable<R2PutOptionsLike["httpMetadata"]> = {
    contentType: options.contentType
  };
  if (options.cacheControl) {
    metadata.cacheControl = options.cacheControl;
  }

  await bucket.put(key, value, {
    httpMetadata: metadata
  });
}

async function deleteRemoteCacheEntry(bucket: R2BucketLike, blobKey: string, metaKey: string): Promise<void> {
  if (!bucket.delete) {
    return;
  }

  const deleteFromBucket = bucket.delete.bind(bucket);
  await Promise.all([deleteFromBucket(blobKey), deleteFromBucket(metaKey)]);
}

function resolveFetchImpl(input?: typeof fetch): typeof fetch {
  if (input) {
    return input;
  }

  return (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(request, init);
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const copied = Uint8Array.from(input);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEtag(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  return raw.replace(/^W\//, "").replace(/^"/, "").replace(/"$/, "").trim() || null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers
  });
}

const worker = createWorker();

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike): Promise<Response> {
    return worker.fetch(request, env, ctx);
  },

  scheduled(event: ScheduledEventLike, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    return worker.scheduled(event, env, ctx);
  }
};
