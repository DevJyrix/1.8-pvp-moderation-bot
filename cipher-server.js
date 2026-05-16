// cipher-server.js
// Resolves YouTube stream signature ciphers that Java regex can't parse.
// youtube-source sends POST /resolve_url with cipher data; we execute the
// player JS in Node.js's vm sandbox (which handles any obfuscation) and
// return the playable URL.

const http  = require('http');
const https = require('https');
const vm    = require('vm');
const { URL } = require('url');

const PORT = 8001;
const scriptCache = new Map();

// ── fetch helper ──────────────────────────────────────────────────────────────
function fetch(rawUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };
    const req = mod.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetch(res.headers.location));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getScript(playerUrl) {
  if (scriptCache.has(playerUrl)) return scriptCache.get(playerUrl);
  const text = await fetch(playerUrl);
  scriptCache.set(playerUrl, text);
  setTimeout(() => scriptCache.delete(playerUrl), 3_600_000);
  return text;
}

// ── cipher extraction ─────────────────────────────────────────────────────────
// Walk brackets to extract a complete JS function body starting at openIdx.
function extractBody(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('Unmatched brace in player script');
}

function extractSigFunction(src) {
  // Look for the pattern split("")...join("") — any variable names.
  // We scan for split("") then walk backwards to the function declaration.
  let offset = 0;
  while (offset < src.length) {
    const si = src.indexOf('a=a.split("")', offset);
    if (si === -1) break;

    // Walk back to find NAME=function(a){ or function NAME(a){
    const lookback = src.slice(Math.max(0, si - 300), si + 50);
    const m = lookback.match(/([a-zA-Z$_][\w$]{0,3})=function\(a\)\{(?:a=)*a\.split\(""\)/);
    if (m) {
      const name = m[1];
      // Find the real position of the match in src
      const matchStart = src.lastIndexOf(m[0], si);
      if (matchStart === -1) { offset = si + 1; continue; }
      const bodyStart = src.indexOf('{', matchStart);
      const body = extractBody(src, bodyStart);
      if (body.includes('.join("")')) return { name, body, decl: `var ${name}=function(a)${body}` };
    }
    offset = si + 1;
  }
  throw new Error('Cannot find sig function (split/join pattern not found)');
}

function extractHelperObject(src, sigBody) {
  const helperMatch = sigBody.match(/;([a-zA-Z$_][\w$]{0,3})\.[a-zA-Z$_]/);
  if (!helperMatch) throw new Error('Cannot find helper object name in sig body');
  const name = helperMatch[1];

  // Find:  var NAME={   or   NAME={
  const patterns = [
    new RegExp(`var\\s+${name}\\s*=\\s*\\{`),
    new RegExp(`[;,]${name}\\s*=\\s*\\{`),
  ];
  for (const pat of patterns) {
    const idx = src.search(pat);
    if (idx === -1) continue;
    const bodyStart = src.indexOf('{', idx);
    const body = extractBody(src, bodyStart);
    return { name, decl: `var ${name}=${body}` };
  }
  throw new Error('Cannot find helper object: ' + name);
}

function extractNFunction(src) {
  // n-param throttle function: b=function(a){... return a.join("") or similar
  const m = src.match(/([a-zA-Z$_][\w$]{0,3})=function\([a-zA-Z$_]+\)\{[^}]*\.join\(""\)[^}]*\}/);
  if (!m) return null;
  const name = m[1];
  const idx = src.indexOf(m[0]);
  const bodyStart = src.indexOf('{', idx);
  const body = extractBody(src, bodyStart);
  return { name, decl: `var ${name}=function(a)${body}` };
}

// ── resolver ──────────────────────────────────────────────────────────────────
async function resolveUrl(streamUrl, playerUrl, encryptedSig, sigKey, nParam) {
  const script = await getScript(playerUrl);

  // Decrypt signature
  const sigFn   = extractSigFunction(script);
  const helperObj = extractHelperObject(script, sigFn.body);
  const sigCode = `${helperObj.decl};\n${sigFn.decl};\n${sigFn.name}(sig)`;
  const sigCtx  = { sig: encryptedSig };
  const decSig  = vm.runInNewContext(sigCode, sigCtx, { timeout: 5000 });

  // Build resolved URL
  const u = new URL(streamUrl);
  u.searchParams.set(sigKey || 'sig', decSig);

  // Decrypt n-param (throttle bypass) if present
  const nValue = nParam || u.searchParams.get('n');
  if (nValue) {
    try {
      const nFn = extractNFunction(script);
      if (nFn) {
        const nCtx  = { n: nValue };
        const decN  = vm.runInNewContext(`${nFn.decl};\n${nFn.name}(n)`, nCtx, { timeout: 5000 });
        u.searchParams.set('n', decN);
      }
    } catch {
      // n-param failure is non-fatal; stream may just be throttled
    }
  }

  return u.toString();
}

// ── HTTP server ───────────────────────────────────────────────────────────────
module.exports = function startCipherServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/resolve_url')) {
      res.writeHead(404); res.end('not found'); return;
    }
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const { stream_url, player_url, encrypted_signature, signature_key, n_param } = body;
        if (!player_url || !encrypted_signature) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'missing fields' })); return;
        }
        const resolved = await resolveUrl(stream_url, player_url, encrypted_signature, signature_key, n_param);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ resolved_url: resolved }));
      } catch (e) {
        console.error('[cipher-server] Error:', e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  server.listen(PORT, '127.0.0.1', () =>
    console.log(`[cipher-server] Running on port ${PORT}`)
  );
  server.on('error', e => console.error('[cipher-server]', e.message));
  return server;
};
