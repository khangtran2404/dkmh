// Server cho VPS (không cần thư viện ngoài, Node >= 18): phục vụ dist/ + proxy đọc Google Sheet.
// /api/sheet.php giữ đúng API của public/api/sheet.php (bản PHP dùng cho nginx ở local).
// Chạy: PORT=1712 ROOT=/path/to/dist node server.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 1712;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.ROOT || path.join(__dirname, 'dist'));
const CACHE_TTL = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (dkmh timetable helper)';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

// ---------------- Proxy Google Sheet ----------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pageCache = new Map(); // url -> { t, body }

async function fetchText(url, nocache) {
  const hit = pageCache.get(url);
  if (!nocache && hit && Date.now() - hit.t < CACHE_TTL) return hit.body;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new HttpError(502, 'Không tải được sheet: ' + (e.cause?.message || e.message));
  }
  if (new URL(res.url).protocol !== 'https:') throw new HttpError(502, 'Google chuyển hướng sang link không hợp lệ');
  if (res.status !== 200) throw new HttpError(502, `Google trả về HTTP ${res.status}. Kiểm tra sheet đã được 'Publish to web' chưa.`);
  const body = await res.text();
  pageCache.set(url, { t: Date.now(), body });
  if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value);
  return body;
}

async function sheetApi(query) {
  const raw = (query.get('url') || '').trim();
  let gid = (query.get('gid') || '').replace(/\D/g, '');
  const nocache = !!query.get('nocache');
  if (!raw) throw new HttpError(400, 'Thiếu tham số url');

  let u;
  try {
    u = new URL(raw);
  } catch {
    u = null;
  }
  if (!u || u.protocol !== 'https:' || u.hostname !== 'docs.google.com' || u.port) {
    throw new HttpError(400, 'Chỉ hỗ trợ link https://docs.google.com/spreadsheets/...');
  }
  if (!gid) gid = (u.searchParams.get('gid') || (u.hash.match(/gid=(\d+)/) || [])[1] || '').replace(/\D/g, '');

  let m;
  let base;
  if ((m = u.pathname.match(/^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/))) base = `https://docs.google.com/spreadsheets/d/e/${m[1]}`;
  else if ((m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/))) base = `https://docs.google.com/spreadsheets/d/${m[1]}`;
  else throw new HttpError(400, 'Link Google Sheet không hợp lệ');

  const index = await fetchText(`${base}/pubhtml`, nocache);

  // Danh sách sheet: items.push({name: "Sheet1", pageUrl: "...gid=123"
  const sheets = [];
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"((?:[^"\\]|\\.)*)"/g;
  const unescape = (s) => {
    try {
      return JSON.parse('"' + s + '"');
    } catch {
      return s;
    }
  };
  for (const it of index.matchAll(re)) {
    const g = unescape(it[2]).match(/gid=(\d+)/);
    if (g) sheets.push({ name: unescape(it[1]), gid: g[1] });
  }

  let html;
  if (sheets.length) {
    if (!gid || !sheets.some((s) => s.gid === gid)) gid = sheets[0].gid;
    html = await fetchText(`${base}/pubhtml/sheet?headers=false&gid=${gid}`, nocache);
  } else {
    html = index; // sheet chỉ có 1 tab: bảng nằm luôn trong trang pubhtml
  }
  const start = html.search(/<table/i);
  const end = html.toLowerCase().lastIndexOf('</table>');
  if (start < 0 || end < 0) throw new HttpError(502, 'Không tìm thấy bảng dữ liệu trong sheet');
  // Bỏ thuộc tính trình bày, cột số dòng <th>, thẻ <div> bọc chữ (giữ rowspan/colspan) -> nhỏ hơn ~55%
  const table = html
    .slice(start, end + 8)
    .replace(/<th\b[^>]*>[\s\S]*?<\/th>/gi, '')
    .replace(/\s(?:class|style|id|dir|cellspacing|cellpadding)="[^"]*"/gi, '')
    .replace(/<\/?(?:div|thead|colgroup|col)\b[^>]*>/gi, '');
  return { sheets, gid, html: table };
}

// ---------------- Static ----------------
function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT) || path.basename(file).startsWith('.')) return null;
  try {
    const st = fs.statSync(file);
    if (st.isFile()) return file;
    if (st.isDirectory() && fs.statSync(path.join(file, 'index.html')).isFile()) return path.join(file, 'index.html');
  } catch {
    /* không có */
  }
  return null;
}

function send(req, res, status, body, type, headers = {}) {
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024;
  res.writeHead(status, {
    'Content-Type': type,
    ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : gz ? zlib.gzipSync(body) : body);
}

const gzStatic = new Map();
function serveStatic(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = TYPES[ext] || 'application/octet-stream';
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  const headers = { 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
  const body = fs.readFileSync(file);
  if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const st = fs.statSync(file);
    const key = file + ':' + st.mtimeMs;
    if (!gzStatic.has(key)) gzStatic.set(key, zlib.gzipSync(body));
    res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...headers });
    return res.end(req.method === 'HEAD' ? undefined : gzStatic.get(key));
  }
  res.writeHead(200, { 'Content-Type': type, ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/sheet.php') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        const data = await sheetApi(url.searchParams);
        return send(req, res, 200, Buffer.from(JSON.stringify(data)), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      const file = resolveFile(url.pathname) || (path.extname(url.pathname) ? null : path.join(ROOT, 'index.html'));
      if (!file) throw new HttpError(404, 'Not found');
      serveStatic(req, res, file);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(req, res, status, Buffer.from(JSON.stringify({ error: e.status ? e.message : 'Lỗi server' })), 'application/json; charset=utf-8', {
        'Cache-Control': 'no-store',
      });
    }
  })
  .listen(PORT, HOST, () => console.log(`dkmh: http://${HOST}:${PORT}  (root ${ROOT})`));
