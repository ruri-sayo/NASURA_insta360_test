const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const HOST = '0.0.0.0';
const PORT = 5324;
const DIST = path.join(__dirname, 'dist');
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function json(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function publicSession(session, role) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    offer: role === 'broadcaster' ? session.offer : undefined,
    answer: role === 'viewer' ? session.answer : undefined,
    candidates:
      role === 'broadcaster'
        ? session.viewerCandidates
        : session.broadcasterCandidates,
  };
}

function cleanupSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}

async function handleApi(request, response, url) {
  cleanupSessions();

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const interfaces = os.networkInterfaces();
    const addresses = Object.entries(interfaces).flatMap(([name, values]) =>
      (values || [])
        .filter((value) => value.family === 'IPv4' && !value.internal)
        .map((value) => ({ name, address: value.address })),
    );
    return json(response, 200, { ok: true, port: PORT, sessions: sessions.size, addresses });
  }

  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    const body = await readJson(request);
    if (!body.offer?.type || !body.offer?.sdp) {
      return json(response, 400, { error: 'A valid WebRTC offer is required.' });
    }
    const id = crypto.randomUUID();
    sessions.set(id, {
      id,
      createdAt: Date.now(),
      offer: body.offer,
      answer: null,
      viewerCandidates: [],
      broadcasterCandidates: [],
    });
    return json(response, 201, { id });
  }

  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    const pending = [...sessions.values()]
      .filter((session) => !session.answer)
      .map((session) => publicSession(session, 'broadcaster'));
    return json(response, 200, { sessions: pending });
  }

  const match = url.pathname.match(
    /^\/api\/sessions\/([0-9a-f-]+)(?:\/(answer|candidate|close))?$/,
  );
  if (!match) return json(response, 404, { error: 'Not found.' });

  const [, id, action] = match;
  const session = sessions.get(id);
  if (!session) return json(response, 404, { error: 'Session expired or not found.' });

  if (request.method === 'GET' && !action) {
    const role = url.searchParams.get('role') === 'broadcaster' ? 'broadcaster' : 'viewer';
    return json(response, 200, publicSession(session, role));
  }

  if (request.method === 'POST' && action === 'answer') {
    const body = await readJson(request);
    if (!body.answer?.type || !body.answer?.sdp) {
      return json(response, 400, { error: 'A valid WebRTC answer is required.' });
    }
    session.answer = body.answer;
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && action === 'candidate') {
    const body = await readJson(request);
    if (!['viewer', 'broadcaster'].includes(body.role) || !body.candidate) {
      return json(response, 400, { error: 'A role and ICE candidate are required.' });
    }
    const target =
      body.role === 'viewer' ? session.viewerCandidates : session.broadcasterCandidates;
    if (!target.some((candidate) => candidate.candidate === body.candidate.candidate)) {
      target.push(body.candidate);
    }
    return json(response, 200, { ok: true });
  }

  if (request.method === 'POST' && action === 'close') {
    sessions.delete(id);
    return json(response, 200, { ok: true });
  }

  return json(response, 405, { error: 'Method not allowed.' });
}

function serveStatic(response, pathname) {
  const routeToIndex = ['/', '/broadcast', '/viewer'].includes(pathname);
  const requested = routeToIndex ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(DIST, requested);

  if (!filePath.startsWith(`${DIST}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(data);
  });
}

const requestHandler = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    serveStatic(response, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    json(response, 500, { error: error.message || 'Internal server error.' });
  }
};

const keyPath = process.env.HTTPS_KEY_PATH;
const certPath = process.env.HTTPS_CERT_PATH;
const useHttps = Boolean(keyPath && certPath);
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, requestHandler)
  : http.createServer(requestHandler);

server.listen(PORT, HOST, () => {
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Mac Camera VR is running at ${protocol}://localhost:${PORT}`);
  console.log(`Quest viewer: ${protocol}://<this-mac-ip>:${PORT}/viewer`);
  if (!useHttps) console.log('WebXR immersive-vr requires a trusted HTTPS URL on Quest.');
});
