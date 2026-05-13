// ╔══════════════════════════════════════════════════════════════════╗
// ║                  👇 用户配置区（部署前请修改）                    ║
// ╚══════════════════════════════════════════════════════════════════╝

// ──────── 调试开关 ────────
// 生产环境保持 false，关闭调试日志与 x-debug-* 响应头
const DEBUG = false;

// ──────── Backblaze B2 / S3 兼容 API ────────
const B2_REGION = "us-west-004";
const B2_ENDPOINT = `s3.${B2_REGION}.backblazeb2.com`;
const B2_BUCKET = "your-private-bucket-name";   // ← 改成你的真实桶名

// ──────── B2 应用密钥 ────────
const AWS_ACCESS_KEY_ID     = "你的_keyID";
const AWS_SECRET_ACCESS_KEY = "你的_applicationKey";

// ──────── 缓存时间（秒） ────────
// 成功响应（2xx/304）缓存时间，默认 1 周。文件不可变，浏览器与 CDN 共用此值
const CACHE_DURATION_SECONDS = 7 * 24 * 60 * 60;
// 错误响应（4xx/5xx）缓存时间，默认 2 小时，避免反复回源 B2
const ERROR_CACHE_DURATION_SECONDS = 2 * 60 * 60;

// ──────── 来源域名白名单 ────────
// 支持三种写法：
//   1) 精确匹配：       "https://example.com"
//   2) 通配子域：       "*.example.com"        （匹配 example.com 及其所有子域，协议不限）
//   3) 任意来源：       "*"                    （等价于 Access-Control-Allow-Origin: *，慎用）
// 留空数组等于完全禁止跨域。
const ALLOWED_ORIGINS = [
  "https://example.com",
  "*.example.com",
];

// ╔══════════════════════════════════════════════════════════════════╗
// ║              ☟ 以下为实现细节，一般无需修改                       ║
// ╚══════════════════════════════════════════════════════════════════╝

// 预编译 Cache-Control 字符串，避免每次请求重复拼接
const CACHE_CONTROL_OK  = `public, max-age=${CACHE_DURATION_SECONDS}, s-maxage=${CACHE_DURATION_SECONDS}, immutable`;
const CACHE_CONTROL_ERR = `public, max-age=${ERROR_CACHE_DURATION_SECONDS}, s-maxage=${ERROR_CACHE_DURATION_SECONDS}`;

// 模块加载时预处理白名单：精确匹配走 Set（O(1)），通配走小型数组
let ALLOW_ALL = false;
const ALLOW_EXACT = new Set();
const ALLOW_SUFFIX = []; // 元素形如 "example.com"，匹配自身或 ".example.com" 结尾
for (const p of ALLOWED_ORIGINS) {
  if (!p) continue;
  if (p === "*") ALLOW_ALL = true;
  else if (p.startsWith("*.")) ALLOW_SUFFIX.push(p.slice(2).toLowerCase());
  else ALLOW_EXACT.add(p);
}

// 已知"长期"错误码（路径真不存在 / 权限错 / 后端持续故障）—— 这类响应值得短期缓存
const LONG_TERM_ERROR_STATUS = new Set([404, 403, 502, 500]);

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ENC = new TextEncoder();   // 全局复用，省内存
const HEX = "0123456789abcdef";  // toHex 查表

// ╔══════════════════════════════════════════════════════════════════╗
// ║                          入口                                     ║
// ╚══════════════════════════════════════════════════════════════════╝
export default {
  async fetch(request) {
    // Origin/白名单解析放在 try 外，确保 catch 兜底也能注入 CORS
    // 这两步本身不会抛异常（resolveAllowedOrigin 内部已 try/catch）
    const origin = request.headers.get("Origin");
    const allowedOrigin = resolveAllowedOrigin(origin);

    try {
      const method = request.method;

      // CORS 预检与方法校验
      if (method === "OPTIONS") return buildPreflightResponse(allowedOrigin);
      if (method !== "GET" && method !== "HEAD") return buildMethodNotAllowed(allowedOrigin);

      const url = new URL(request.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;

      // 缓存 key 忽略查询参数（同一 path 永远对应同一份内容，匹配 immutable 语义）
      const cacheKey = new Request(url.origin + path, { method: "GET" });
      const cache = caches.default;

      // 命中缓存直接走 hit 分支；未命中则回源 B2 并按状态码组装响应
      const cached = await cache.match(cacheKey);
      const { response, shouldCache } = cached
        ? { response: wrapCacheHit(cached), shouldCache: false }
        : await fetchAndBuildResponse(path, method);

      // 仅 GET 且当前响应可缓存时写入边缘缓存
      if (!cached && shouldCache && method === "GET") {
        await tryPutCache(cache, cacheKey, response);
      }

      // 统一注入 CORS / Vary / DEBUG 头
      injectCors(response, allowedOrigin);
      if (DEBUG) injectDebugHeaders(response, path, allowedOrigin);
      return response;

    } catch (err) {
      if (DEBUG) console.error("[CRITICAL]", err);
      return buildInternalErrorResponse(err, allowedOrigin);
    }
  },
};

// ╔══════════════════════════════════════════════════════════════════╗
// ║                  响应构造（按状态分支）                           ║
// ╚══════════════════════════════════════════════════════════════════╝

// CORS 预检响应：命中白名单 204，否则 403（不泄露允许的方法）
function buildPreflightResponse(allowedOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  return new Response(null, { status: allowedOrigin ? 204 : 403, headers });
}

// 不支持的 HTTP 方法
function buildMethodNotAllowed(allowedOrigin) {
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Vary": "Origin" };
  if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  return new Response("Method Not Allowed", { status: 405, headers });
}

// catch 兜底响应：必须带 CORS，否则浏览器看到的会是 CORS 错误而非 500
// 不输出 err.stack，避免大字符串占内存
function buildInternalErrorResponse(err, allowedOrigin) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
  return new Response("Internal Error: " + err.message, { status: 500, headers });
}

// 回源 B2 并根据状态码构造响应
//   返回 { response, shouldCache }，shouldCache 表示该响应是否值得写入边缘缓存
async function fetchAndBuildResponse(path, method) {
  const b2 = await fetchFromB2(path, method);

  if (b2.ok || b2.status === 304) {
    return { response: buildSuccessResponse(b2), shouldCache: true };
  }
  if (LONG_TERM_ERROR_STATUS.has(b2.status)) {
    return { response: await buildLongTermErrorResponse(b2), shouldCache: true };
  }
  // 其他状态码（429/503/504/重定向/...）：透传 body 与 status，但不缓存
  return { response: buildPassthroughResponse(b2), shouldCache: false };
}

// 成功响应（2xx/304）：保持 B2 原始 Content-Type / Content-Disposition，叠加长期缓存
function buildSuccessResponse(b2) {
  const response = new Response(b2.body, b2);
  response.headers.set("Cache-Control", CACHE_CONTROL_OK);
  response.headers.set("x-snippets-cache", "stored-success");
  return response;
}

// 已知长期错误码（404/403/500/502）：包成短文本响应，缓存 2 小时避免反复回源
async function buildLongTermErrorResponse(b2) {
  const body = await b2.text();
  return new Response(body || "Error from B2", {
    status: b2.status,
    statusText: b2.statusText,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": CACHE_CONTROL_ERR,
      "x-snippets-cache": `stored-error-${b2.status}`,
    },
  });
}

// 其他状态码：原样透传 body/status，强制 no-store，避免被中间代理缓存瞬时错误
// 必须重新包一层 Response，否则后续 CORS/Vary 注入无法生效（透传 b2 会使浏览器跨域失败）
function buildPassthroughResponse(b2) {
  const response = new Response(b2.body, {
    status: b2.status,
    statusText: b2.statusText,
    headers: b2.headers,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("x-snippets-cache", `passthrough-${b2.status}`);
  return response;
}

// 缓存命中：重新包一层以便后续修改 headers
function wrapCacheHit(cached) {
  const response = new Response(cached.body, cached);
  response.headers.set("x-snippets-cache", "hit");
  return response;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                       工具：B2 / 缓存                             ║
// ╚══════════════════════════════════════════════════════════════════╝

// 通过 SigV4 签名直连 B2 私桶
async function fetchFromB2(path, method) {
  const b2Url = `https://${B2_BUCKET}.${B2_ENDPOINT}${path}`;
  const signedHeaders = await signV4(b2Url, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, B2_REGION);
  return fetch(b2Url, { method, headers: signedHeaders });
}

// 写入边缘缓存（不阻塞响应失败，错误以 x-cache-put-error 头透出便于排查）
async function tryPutCache(cache, cacheKey, response) {
  try {
    await cache.put(cacheKey, response.clone());
  } catch (e) {
    response.headers.set("x-cache-put-error", e.message.replace(/\n/g, " "));
  }
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                       工具：响应头 / 路径                         ║
// ╚══════════════════════════════════════════════════════════════════╝

// 统一注入 CORS（基于本次请求 Origin），加 Vary 避免缓存污染
function injectCors(response, allowedOrigin) {
  if (allowedOrigin) response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  else response.headers.delete("Access-Control-Allow-Origin");
  response.headers.set("Vary", "Origin");
}

function injectDebugHeaders(response, path, allowedOrigin) {
  response.headers.set("x-debug-mode", "enabled");
  response.headers.set("x-debug-request-path", path);
  response.headers.set("x-debug-b2-bucket", B2_BUCKET);
  response.headers.set("x-debug-allowed-origin", allowedOrigin || "(blocked)");
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║                  工具：CORS 白名单解析                            ║
// ╚══════════════════════════════════════════════════════════════════╝
function resolveAllowedOrigin(origin) {
  if (!origin) return null;
  if (ALLOW_ALL) return origin;
  if (ALLOW_EXACT.has(origin)) return origin;
  if (ALLOW_SUFFIX.length === 0) return null;

  let host;
  try { host = new URL(origin).hostname.toLowerCase(); }
  catch (e) { return null; }

  for (let i = 0; i < ALLOW_SUFFIX.length; i++) {
    const base = ALLOW_SUFFIX[i];
    // 匹配 "example.com" 自身或其任意子域
    if (host === base || host.endsWith("." + base)) return origin;
  }
  return null;
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║              工具：AWS SigV4 签名（访问 B2 私桶必需）             ║
// ╚══════════════════════════════════════════════════════════════════╝
async function hmac(key, str) {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? ENC.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, ENC.encode(str)));
}

async function sha256Hex(str) {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", ENC.encode(str)));
  return toHex(buf);
}

function toHex(buf) {
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    s += HEX[b >> 4] + HEX[b & 0xf];
  }
  return s;
}

function awsUriEncode(path) {
  // 按 / 分段，每段按 RFC3986 编码（! ' ( ) * 也要转义）
  return path.split('/').map(seg => {
    let dec = seg;
    try { dec = decodeURIComponent(seg); } catch (e) {}
    return encodeURIComponent(dec).replace(/[!'()*]/g, c =>
      '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );
  }).join('/');
}

async function signV4(url, ak, sk, region) {
  const u = new URL(url);
  const canonicalUri = awsUriEncode(u.pathname);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStr = amzDate.substring(0, 8);
  const service = "s3";

  const canonicalHeaders = `host:${u.host}\nx-amz-content-sha256:${EMPTY_HASH}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${EMPTY_HASH}`;

  const credentialScope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  // 派生签名密钥：date → region → service → "aws4_request"
  const kDate = await hmac(`AWS4${sk}`, dateStr);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  return {
    "Authorization": `AWS4-HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": EMPTY_HASH,
  };
}
