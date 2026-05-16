// cipher-server.js — YouTube cipher resolver compatible with youtube-source remoteCipher.
// Implements the yt-cipher API:  POST /get_sts  POST /decrypt_signature  POST /resolve_url
//
// youtube-source's RemoteCipherManager calls:
//   1. POST /get_sts              → extract signatureTimestamp from player JS
//   2. POST /decrypt_signature    → decrypt sig + n-param using player JS cipher functions
//   3. POST /resolve_url          → full resolution (sig + n) applied to stream URL

const http  = require('http');
const https = require('https');
const vm    = require('vm');
const { URL } = require('url');

const PORT = 8001;
const scriptCache = new Map();

// ── HTTP fetch ────────────────────────────────────────────────────────────────
function normalizePlayerUrl(raw) {
  if (!raw) return raw;
  // youtube-source may send a bare path like /s/player/2d01abf7/...
  if (raw.startsWith('/')) return 'https://www.youtube.com' + raw;
  return raw;
}

function fetchText(rawUrl) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(rawUrl);
      const mod  = parsed.protocol === 'https:' ? https : http;
      const req  = mod.get(rawUrl, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return resolve(fetchText(res.headers.location));
        if (res.statusCode >= 400)
          return reject(new Error(`HTTP ${res.statusCode} fetching ${rawUrl}`));
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) { reject(e); }
  });
}

async function getScript(playerUrl) {
  playerUrl = normalizePlayerUrl(playerUrl);
  if (scriptCache.has(playerUrl)) return scriptCache.get(playerUrl);
  const text = await fetchText(playerUrl);
  scriptCache.set(playerUrl, text);
  setTimeout(() => scriptCache.delete(playerUrl), 3_600_000);
  return text;
}

// ── STS extraction ────────────────────────────────────────────────────────────
function extractSts(script) {
  const m = script.match(/[,;{]signatureTimestamp[:\s]*(\d+)/);
  if (m) return m[1];
  // fallback patterns
  const m2 = script.match(/signatureTimestamp:(\d+)/);
  if (m2) return m2[1];
  throw new Error('Cannot extract signatureTimestamp from player script');
}

// ── Cipher extraction ─────────────────────────────────────────────────────────
function extractBody(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  throw new Error('Unmatched brace in player script');
}

function extractSigFunction(src) {
  // Scan for the unique pattern: a=a.split("") inside a short-named function
  let offset = 0;
  while (offset < src.length) {
    const si = src.indexOf('a=a.split("")', offset);
    if (si === -1) break;

    // look at up to 400 chars before split to find the function declaration
    const lookback = src.slice(Math.max(0, si - 400), si + 20);
    // NAME=function(a){  or  NAME=function(a){a=  or  NAME=function(a){var a=
    const m = lookback.match(/([a-zA-Z$_][\w$]{0,4})=function\([a-zA-Z$_]+\)\{(?:[a-zA-Z$_]+=)?(?:[a-zA-Z$_]+\.)?[a-zA-Z$_]+\.split\(""\)/);
    if (m) {
      const name = m[1];
      const matchInFull = src.lastIndexOf(m[0], si + 20);
      if (matchInFull !== -1) {
        const bodyStart = src.indexOf('{', matchInFull);
        const body = extractBody(src, bodyStart);
        if (body.includes('.join("")')) {
          return { name, body, decl: `var ${name}=function(a)${body}` };
        }
      }
    }
    offset = si + 1;
  }
  throw new Error('Cannot find sig function (split/join pattern absent)');
}

function extractHelperObject(src, sigBody) {
  // e.g.  ;Abc.de(a,12);  → helper name is Abc
  const hm = sigBody.match(/;([a-zA-Z$_][\w$]{0,4})\.[a-zA-Z$_][\w$]*\(a/);
  if (!hm) throw new Error('Cannot find helper object name in sig body:\n' + sigBody.slice(0, 200));
  const name = hm[1];

  for (const pat of [
    new RegExp(`var\\s+${name}\\s*=\\s*\\{`),
    new RegExp(`[;,{(]${name}\\s*=\\s*\\{`),
  ]) {
    const idx = src.search(pat);
    if (idx === -1) continue;
    const bodyStart = src.indexOf('{', idx);
    const body = extractBody(src, bodyStart);
    return { name, decl: `var ${name}=${body}` };
  }
  throw new Error('Cannot find helper object: ' + name);
}

function extractNFunction(src) {
  // n-param throttle function — looks for: NAME=function(a){...enhanced array ops...return a.join("")}
  // Try several patterns
  const patterns = [
    /([a-zA-Z$_][\w$]{0,4})=function\(a\)\{var b=a\.split\(""\)/,
    /([a-zA-Z$_][\w$]{0,4})=function\(a\)\{a=a\.split\(""\)/,
  ];
  for (const pat of patterns) {
    const m = src.match(pat);
    if (!m) continue;
    const name = m[1];
    const idx  = src.indexOf(m[0]);
    const bodyStart = src.indexOf('{', idx);
    const body = extractBody(src, bodyStart);
    if (body.includes('.join("")') && body.length > 200) {
      return { name, decl: `var ${name}=function(a)${body}` };
    }
  }
  return null;
}

// ── Core decrypt ──────────────────────────────────────────────────────────────
async function decryptSignature(playerUrl, encSig) {
  const script = await getScript(playerUrl);
  const sigFn  = extractSigFunction(script);
  const helper = extractHelperObject(script, sigFn.body);
  const code   = `${helper.decl};\n${sigFn.decl};\n${sigFn.name}(sig)`;
  const ctx    = { sig: encSig };
  return vm.runInNewContext(code, ctx, { timeout: 5000 });
}

async function decryptN(playerUrl, nVal) {
  const script = await getScript(playerUrl);
  const nFn    = extractNFunction(script);
  if (!nFn) return nVal; // can't decrypt → return as-is (stream just throttled)
  const ctx  = { n: nVal };
  return vm.runInNewContext(`${nFn.decl};\n${nFn.name}(n)`, ctx, { timeout: 5000 });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(res => { let s = ''; req.on('data', c => s += c); req.on('end', () => res(s)); });
}

module.exports = function startCipherServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }

    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
    }

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    try {
      // ── POST /get_sts ──────────────────────────────────────────────────────
      if (req.url.startsWith('/get_sts')) {
        const { player_url } = parsed;
        if (!player_url) { send(400, { error: 'missing player_url' }); return; }
        const script = await getScript(player_url);
        const sts    = extractSts(script);
        send(200, { sts });

      // ── POST /decrypt_signature ────────────────────────────────────────────
      } else if (req.url.startsWith('/decrypt_signature')) {
        const { player_url, encrypted_signature, n_param } = parsed;
        if (!player_url || !encrypted_signature) { send(400, { error: 'missing fields' }); return; }
        const decSig = await decryptSignature(player_url, encrypted_signature);
        const decN   = n_param ? await decryptN(player_url, n_param) : null;
        send(200, { decrypted_signature: decSig, decrypted_n_sig: decN });

      // ── POST /resolve_url ──────────────────────────────────────────────────
      } else if (req.url.startsWith('/resolve_url')) {
        const { stream_url, player_url, encrypted_signature, signature_key, n_param } = parsed;
        if (!player_url || !encrypted_signature) { send(400, { error: 'missing fields' }); return; }

        const decSig = await decryptSignature(player_url, encrypted_signature);
        const u      = new URL(stream_url);
        u.searchParams.set(signature_key || 'sig', decSig);

        const nVal = n_param || u.searchParams.get('n');
        if (nVal) {
          try {
            const decN = await decryptN(player_url, nVal);
            u.searchParams.set('n', decN);
          } catch { /* non-fatal */ }
        }

        send(200, { resolved_url: u.toString() });

      } else {
        send(404, { error: 'unknown endpoint' });
      }
    } catch (e) {
      console.error(`[cipher-server] ${req.url} error:`, e.message);
      send(500, { error: e.message });
    }
  });

  server.listen(PORT, '127.0.0.1', () =>
    console.log(`[cipher-server] Running on port ${PORT} (get_sts + decrypt_signature + resolve_url)`)
  );
  server.on('error', e => console.error('[cipher-server]', e.message));
  return server;
};
