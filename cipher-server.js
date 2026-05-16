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
  // Prepend base if relative
  if (raw.startsWith('/')) raw = 'https://www.youtube.com' + raw;
  // player_embed.vflset does NOT contain cipher functions — swap to player_ias.vflset
  // which has the same hash but includes the sig/n decode functions.
  const before = raw;
  raw = raw.replace('/player_embed.vflset/', '/player_ias.vflset/');
  // Normalize locale so cache key is stable and we always get the same JS
  raw = raw.replace(/\/[a-z]{2}_[A-Z]{2}\/base\.js$/, '/en_US/base.js');
  if (raw !== before) console.log(`[cipher] remapped player URL:\n  from: ${before}\n    to: ${raw}`);
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
  console.log(`[cipher] fetching player script: ${playerUrl.slice(0, 80)}`);
  const text = await fetchText(playerUrl);
  console.log(`[cipher] player script fetched: ${text.length} chars`);
  scriptCache.set(playerUrl, text);
  setTimeout(() => scriptCache.delete(playerUrl), 3_600_000);
  return text;
}

// ── STS extraction ────────────────────────────────────────────────────────────
function extractSts(script) {
  const m = script.match(/[,;{]signatureTimestamp[:\s]*(\d+)/);
  if (m) return m[1];
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
  // Collect all positions of .split("") for diagnostics and fallback scanning
  const allSplitIdxs = [];
  { let i = 0; while ((i = src.indexOf('.split("")', i)) !== -1) { allSplitIdxs.push(i); i++; } }
  console.log(`[cipher] extractSigFunction: script ${src.length} chars, ${allSplitIdxs.length}× .split("")`);

  // Pass 1: look for known split-assignment patterns, any function name length
  // Handles: a=a.split(""), var b=a.split(""), b=a.split("")
  const splitPats = ['a=a.split("")', 'var b=a.split("")', 'b=a.split("")'];
  for (const splitPat of splitPats) {
    let offset = 0;
    while (offset < src.length) {
      const si = src.indexOf(splitPat, offset);
      if (si === -1) break;

      // Search up to 600 chars back for a function declaration
      const lookback = src.slice(Math.max(0, si - 600), si + splitPat.length + 5);
      // No {0,4} name-length cap — match any identifier
      const m = lookback.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{(?:var\s+)?(?:[a-zA-Z$_]+=)?(?:[a-zA-Z$_]+\.)?[a-zA-Z$_]+\.split\(""\)/);
      if (m) {
        const name    = m[1];
        const realIdx = src.lastIndexOf(name + '=function(', si);
        if (realIdx !== -1) {
          const bodyStart = src.indexOf('{', realIdx);
          let body;
          try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
          if (body.includes('.join("")')) {
            console.log(`[cipher] sig fn "${name}" via splitPat "${splitPat}", body ${body.length} chars`);
            return { name, body, decl: `var ${name}=function(a)${body}` };
          }
        }
      }
      offset = si + 1;
    }
  }

  // Pass 2: fallback — for every .split("") occurrence, look backward 700 chars for nearest =function(
  for (const si of allSplitIdxs) {
    const region = src.slice(Math.max(0, si - 700), si + 15);
    const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
    if (!m) continue;
    const name    = m[1];
    const realIdx = src.lastIndexOf(name + '=function(', si);
    if (realIdx === -1) continue;
    const bodyStart = src.indexOf('{', realIdx);
    let body;
    try { body = extractBody(src, bodyStart); } catch { continue; }
    if (body.includes('.split("")') && body.includes('.join("")')) {
      console.log(`[cipher] sig fn "${name}" via fallback scan, body ${body.length} chars`);
      return { name, body, decl: `var ${name}=function(a)${body}` };
    }
  }

  // Pass 3: standalone function declarations: function NAME(a){a=a.split("")...}
  for (const splitPat of splitPats) {
    let offset = 0;
    while (offset < src.length) {
      const si = src.indexOf(splitPat, offset);
      if (si === -1) break;
      const lookback = src.slice(Math.max(0, si - 600), si + splitPat.length + 5);
      const m = lookback.match(/function\s+([a-zA-Z$_][\w$]*)\s*\([a-zA-Z$_]+\)\s*\{/);
      if (m) {
        const name    = m[1];
        const realIdx = src.lastIndexOf('function ' + name, si);
        if (realIdx !== -1) {
          const bodyStart = src.indexOf('{', realIdx);
          let body;
          try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
          if (body.includes('.join("")')) {
            console.log(`[cipher] sig fn "${name}" via standalone decl, body ${body.length} chars`);
            return { name, body, decl: `var ${name}=function(a)${body}` };
          }
        }
      }
      offset = si + 1;
    }
  }

  // Diagnostic dump — log context around each .split("") to help identify the pattern
  console.error(`[cipher] FAILED to find sig fn. Script ${src.length} chars, ${allSplitIdxs.length}× .split("")`);
  for (let k = 0; k < Math.min(6, allSplitIdxs.length); k++) {
    const p   = allSplitIdxs[k];
    const ctx = src.slice(Math.max(0, p - 350), p + 80).replace(/\n/g, '↵');
    console.error(`[cipher]  split[${k}] @${p}: …${ctx}…`);
  }
  throw new Error('Cannot find sig function (split/join pattern absent)');
}

function extractHelperObject(src, sigBody) {
  // e.g.  ;Abc.de(a,12);  — no name-length cap
  const hm = sigBody.match(/;([a-zA-Z$_][\w$]*)\.[a-zA-Z$_][\w$]*\(a/);
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
    console.log(`[cipher] helper obj "${name}", body ${body.length} chars`);
    return { name, decl: `var ${name}=${body}` };
  }
  throw new Error('Cannot find helper object: ' + name);
}

function extractNFunction(src) {
  // n-param throttle function — no name-length cap, extra split patterns
  const patterns = [
    /([a-zA-Z$_][\w$]*)=function\(a\)\{var b=a\.split\(""\)/,
    /([a-zA-Z$_][\w$]*)=function\(a\)\{a=a\.split\(""\)/,
    /([a-zA-Z$_][\w$]*)=function\(a\)\{b=a\.split\(""\)/,
  ];
  for (const pat of patterns) {
    const m = src.match(pat);
    if (!m) continue;
    const name = m[1];
    const idx  = src.indexOf(m[0]);
    const bodyStart = src.indexOf('{', idx);
    const body = extractBody(src, bodyStart);
    if (body.includes('.join("")') && body.length > 200) {
      console.log(`[cipher] n-fn "${name}" via "${pat.source.slice(0,40)}", body ${body.length} chars`);
      return { name, decl: `var ${name}=function(a)${body}` };
    }
  }
  console.warn('[cipher] n-fn not found — stream may be throttled');
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
  if (!nFn) return nVal;
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
        console.log(`[cipher] GET_STS player_url=${player_url.slice(0, 70)}`);
        const script = await getScript(player_url);
        const sts    = extractSts(script);
        console.log(`[cipher] GET_STS → sts=${sts}`);
        send(200, { sts });

      // ── POST /decrypt_signature ────────────────────────────────────────────
      } else if (req.url.startsWith('/decrypt_signature')) {
        const { player_url, encrypted_signature, n_param } = parsed;
        if (!player_url || !encrypted_signature) { send(400, { error: 'missing fields' }); return; }
        console.log(`[cipher] DECRYPT_SIG player_url=${player_url.slice(0, 70)}`);
        const decSig = await decryptSignature(player_url, encrypted_signature);
        const decN   = n_param ? await decryptN(player_url, n_param) : null;
        console.log(`[cipher] DECRYPT_SIG → ok, n=${decN !== null ? 'decrypted' : 'none'}`);
        send(200, { decrypted_signature: decSig, decrypted_n_sig: decN });

      // ── POST /resolve_url ──────────────────────────────────────────────────
      } else if (req.url.startsWith('/resolve_url')) {
        const { stream_url, player_url, encrypted_signature, signature_key, n_param } = parsed;
        if (!player_url || !encrypted_signature) { send(400, { error: 'missing fields' }); return; }
        console.log(`[cipher] RESOLVE_URL player_url=${player_url.slice(0, 70)}`);

        const decSig = await decryptSignature(player_url, encrypted_signature);
        const u      = new URL(stream_url);
        u.searchParams.set(signature_key || 'sig', decSig);

        const nVal = n_param || u.searchParams.get('n');
        if (nVal) {
          try {
            const decN = await decryptN(player_url, nVal);
            u.searchParams.set('n', decN);
          } catch (ne) {
            console.warn(`[cipher] n-param decrypt failed (non-fatal): ${ne.message}`);
          }
        }

        console.log(`[cipher] RESOLVE_URL → ok`);
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
