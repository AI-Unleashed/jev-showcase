// Zero-dependency server: serves the showcase UI and proxies decisions to
// OpenRouter so the API key never reaches the browser.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3456;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = process.env.JEV_MODEL || '~typesafe/jev-latest';
const ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/v1/systemone';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const MAX_BODY_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const QUESTION_TYPES = new Set(['choice', 'score', 'noul']);

// Every /api/decide call spends the key owner's credits, so cap calls per
// client per minute. Behind a reverse proxy all clients share the proxy's
// address, which turns this into a global cap — still the right failure mode.
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 120;
const hits = new Map();

function rateLimited(req) {
  const now = Date.now();
  const client = req.socket.remoteAddress || 'unknown';
  const recent = (hits.get(client) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_LIMIT_PER_MIN) {
    hits.set(client, recent);
    return true;
  }
  recent.push(now);
  hits.set(client, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [client, times] of hits) if (times.every((t) => now - t >= 60_000)) hits.delete(client);
}, 60_000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

// Structural checks only; Jev's own limits (255 options, 2-10 levels, token
// budget) are left to the upstream so its error messages surface unchanged.
function validateDecision(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object.';
  const { state, questions } = body;
  if (state === undefined || state === null || state === '') return '`state` is required.';
  if (typeof state !== 'string' && typeof state !== 'object') return '`state` must be a string, object, or array.';
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    return '`questions` must be an object keyed by question name.';
  }
  const names = Object.keys(questions);
  if (names.length === 0) return 'Ask at least one question.';
  for (const name of names) {
    const q = questions[name];
    if (!q || typeof q !== 'object') return `Question "${name}" must be an object.`;
    if (!QUESTION_TYPES.has(q.type)) return `Question "${name}" has type "${q.type}"; expected choice, score, or noul.`;
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) {
      return `Question "${name}" needs \`instructions\`.`;
    }
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object')) {
      return `Choice question "${name}" needs \`criteria\` (option → description).`;
    }
    if (q.type === 'score' && !Array.isArray(q.criteria)) {
      return `Score question "${name}" needs \`criteria\` as an ordered array of levels.`;
    }
  }
  return null;
}

function upstreamErrorMessage(status, parsed, rawText) {
  const upstream = parsed?.error?.message || parsed?.message || rawText?.slice(0, 300) || 'Unknown error';
  const hints = {
    401: 'OpenRouter rejected the API key. Check OPENROUTER_API_KEY in .env.',
    402: 'Your OpenRouter account is out of credits.',
    403: 'This key is not allowed to use the model. Jev is in beta on OpenRouter.',
    404: `OpenRouter could not find "${MODEL}". Jev is in beta and may not be enabled for your account.`,
    429: 'Rate limited by OpenRouter. Wait a moment and retry.',
  };
  return { message: upstream, hint: hints[status] || null };
}

async function handleDecide(req, res) {
  if (!API_KEY) {
    return sendJson(res, 503, {
      ok: false,
      error: 'OPENROUTER_API_KEY is not set.',
      hint: 'Copy .env.example to .env, add your OpenRouter key, then restart the server.',
    });
  }

  if (rateLimited(req)) {
    return sendJson(res, 429, {
      ok: false,
      error: `Too many requests — this showcase allows ${RATE_LIMIT_PER_MIN} per minute.`,
      hint: 'Wait a minute and retry, or raise RATE_LIMIT_PER_MIN on the server.',
    });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { ok: false, error: err.message });
  }
  const invalid = validateDecision(body);
  if (invalid) return sendJson(res, 400, { ok: false, error: invalid });

  const request = { model: MODEL, state: body.state, questions: body.questions };
  const started = performance.now();
  let upstream;
  let rawText;
  try {
    upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Jev Showcase',
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    rawText = await upstream.text();
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    return sendJson(res, 504, {
      ok: false,
      error: timedOut ? `OpenRouter did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s.` : `Could not reach OpenRouter: ${err.message}`,
      hint: 'Check your network connection and retry.',
    });
  }
  const latencyMs = Math.round(performance.now() - started);

  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // non-JSON upstream body is reported below
  }

  if (!upstream.ok || !parsed || parsed.error) {
    const status = upstream.ok ? 502 : upstream.status;
    const { message, hint } = upstreamErrorMessage(status, parsed, rawText);
    return sendJson(res, status, { ok: false, status, error: message, hint, latencyMs, request });
  }

  return sendJson(res, 200, { ok: true, latencyMs, request, response: parsed });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = resolve(join(PUBLIC_DIR, relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, { hasKey: Boolean(API_KEY), model: MODEL, endpoint: ENDPOINT });
    }
    if (pathname === '/api/decide') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Use POST.' });
      return await handleDecide(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error.' });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`Port ${PORT} is already in use — is the showcase already running? Stop it, or pick another port: PORT=3457 npm start`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Jev showcase → http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  model:    ${MODEL}`);
  console.log(`  endpoint: ${ENDPOINT}`);
  if (!API_KEY) console.log('  ⚠ OPENROUTER_API_KEY is not set — copy .env.example to .env and add your key.');
});
