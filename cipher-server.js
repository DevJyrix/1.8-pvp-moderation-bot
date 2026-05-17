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

// ── String table extraction ───────────────────────────────────────────────────
// Some YouTube player builds obfuscate string literals via an array:
//   var a="foo{split{join{reverse{splice{...".split("{")
// Cipher code then uses a[N] instead of "split", "join", etc.:
//   sig=sig[a[21]](a[11])  →  sig=sig.split("")
// We extract this table so it can be injected into the VM execution context.
function extractStringTable(src) {
  const tableRe = /var\s+([a-zA-Z$_][\w$]*)\s*=\s*"([^"]{100,})"\s*\.\s*split\s*\(\s*"([^"]{1,3})"\s*\)/g;
  let tm;
  const candidates = [];
  while ((tm = tableRe.exec(src)) !== null) {
    const varName = tm[1];
    const strings = tm[2].split(tm[3]);
    const splitIdx = strings.indexOf('split');
    const joinIdx  = strings.indexOf('join');
    if (splitIdx !== -1 && joinIdx !== -1) {
      candidates.push({ varName, strings, delim: tm[3], splitIdx, joinIdx });
    }
  }

  if (candidates.length === 0) {
    console.log('[cipher] extractStringTable: no split+join string table found in player');
    return null;
  }

  const t = candidates[0];
  t.emptyIdx   = t.strings.indexOf('');
  t.spliceIdx  = t.strings.indexOf('splice');
  t.reverseIdx = t.strings.indexOf('reverse');
  t.decl = `var ${t.varName}=${JSON.stringify(t.strings)}`;

  console.log(`[cipher] string table "${t.varName}" (${t.strings.length} entries, delim="${t.delim}"): ` +
    `split@${t.splitIdx}, join@${t.joinIdx}, empty@${t.emptyIdx}, splice@${t.spliceIdx}, reverse@${t.reverseIdx}`);
  if (candidates.length > 1)
    console.log(`[cipher]   (${candidates.length} candidate tables found; using first that has split+join)`);

  return t;
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

// Return the actual parameter name from a function declaration starting at fnIdx.
function getFnParam(src, fnIdx) {
  const snippet = src.slice(fnIdx, fnIdx + 100);
  const m = snippet.match(/function\s*\(\s*([a-zA-Z$_][\w$]*)\s*\)/);
  return m ? m[1] : 'a';
}

function extractSigFunction(src) {
  // Collect all positions of .split("") for diagnostics and fallback scanning
  const allSplitIdxs = [];
  { let i = 0; while ((i = src.indexOf('.split("")', i)) !== -1) { allSplitIdxs.push(i); i++; } }
  console.log(`[cipher] extractSigFunction: script ${src.length} chars, ${allSplitIdxs.length}× literal .split("")`);

  // ── Pass 1: known split-assignment patterns, any function name length ────────
  // Handles: a=a.split(""), var b=a.split(""), b=a.split("")
  const splitPats = ['a=a.split("")', 'var b=a.split("")', 'b=a.split("")'];
  for (const splitPat of splitPats) {
    let offset = 0;
    while (offset < src.length) {
      const si = src.indexOf(splitPat, offset);
      if (si === -1) break;

      const lookback = src.slice(Math.max(0, si - 600), si + splitPat.length + 5);
      const m = lookback.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{(?:var\s+)?(?:[a-zA-Z$_]+=)?(?:[a-zA-Z$_]+\.)?[a-zA-Z$_]+\.split\(""\)/);
      if (m) {
        const name    = m[1];
        const realIdx = src.lastIndexOf(name + '=function(', si);
        if (realIdx !== -1) {
          const param     = getFnParam(src, realIdx + name.length + 1);
          const bodyStart = src.indexOf('{', realIdx);
          let body;
          try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
          if (body.includes('.join("")')) {
            console.log(`[cipher] sig fn "${name}" via Pass1 splitPat "${splitPat}", param="${param}", body ${body.length} chars`);
            return { name, body, decl: `var ${name}=function(${param})${body}` };
          }
        }
      }
      offset = si + 1;
    }
  }

  // ── Pass 2: fallback — for every .split("") occurrence, look backward 700 chars ──
  for (const si of allSplitIdxs) {
    const region = src.slice(Math.max(0, si - 700), si + 15);
    const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
    if (!m) continue;
    const name    = m[1];
    const realIdx = src.lastIndexOf(name + '=function(', si);
    if (realIdx === -1) continue;
    const param     = getFnParam(src, realIdx + name.length + 1);
    const bodyStart = src.indexOf('{', realIdx);
    let body;
    try { body = extractBody(src, bodyStart); } catch { continue; }
    if (body.includes('.split("")') && body.includes('.join("")')) {
      console.log(`[cipher] sig fn "${name}" via Pass2 fallback scan, param="${param}", body ${body.length} chars`);
      return { name, body, decl: `var ${name}=function(${param})${body}` };
    }
  }

  // ── Pass 3: standalone function declarations: function NAME(a){a=a.split("")...} ──
  for (const splitPat of splitPats) {
    let offset = 0;
    while (offset < src.length) {
      const si = src.indexOf(splitPat, offset);
      if (si === -1) break;
      const lookback = src.slice(Math.max(0, si - 600), si + splitPat.length + 5);
      const m = lookback.match(/function\s+([a-zA-Z$_][\w$]*)\s*\(([a-zA-Z$_]+)\)\s*\{/);
      if (m) {
        const [, name, param] = m;
        const realIdx = src.lastIndexOf('function ' + name, si);
        if (realIdx !== -1) {
          const bodyStart = src.indexOf('{', realIdx);
          let body;
          try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
          if (body.includes('.join("")')) {
            console.log(`[cipher] sig fn "${name}" via Pass3 standalone decl, param="${param}", body ${body.length} chars`);
            return { name, body, decl: `var ${name}=function(${param})${body}` };
          }
        }
      }
      offset = si + 1;
    }
  }

  // ── Pass 4: string-table obfuscated cipher functions ─────────────────────────
  // Newer YouTube players replace "split"/"join"/"splice"/"reverse" with indexed
  // lookups into a string array, e.g.:
  //   var v="foo{split{join{...".split("{")  →  v[30]="split", v[41]="join"
  //
  // IMPORTANT: the cipher function is often wrapped in a closure that receives
  // the table as a parameter under a DIFFERENT name:
  //   (function(w, ...){ var CIPHER=function(sig){sig[w[30]](w[27]);...} })(v, ...)
  // So we must search for [ANY_VAR[splitIdx]] across the whole script, not just
  // [v[splitIdx]], then use whichever alias appears in both split + join positions.
  const strTable = extractStringTable(src);
  if (strTable) {
    const { varName: tableVarName, splitIdx, joinIdx } = strTable;

    // Collect every variable name used in [VAR[splitIdx]] and [VAR[joinIdx]] patterns
    const splitBracketRe = new RegExp(`\\[([a-zA-Z$_][\\w$]*)\\[${splitIdx}\\]\\]`, 'g');
    const joinBracketRe  = new RegExp(`\\[([a-zA-Z$_][\\w$]*)\\[${joinIdx}\\]\\]`, 'g');
    const splitAliases = new Set(), joinAliases = new Set();
    let bm;
    while ((bm = splitBracketRe.exec(src)) !== null) splitAliases.add(bm[1]);
    while ((bm = joinBracketRe.exec(src))  !== null) joinAliases.add(bm[1]);

    console.log(`[cipher] Pass4: vars with [X[${splitIdx}]]: ${[...splitAliases].join(', ') || '(none)'}`);
    console.log(`[cipher] Pass4: vars with [X[${joinIdx}]]: ${[...joinAliases].join(', ')  || '(none)'}`);

    // Only consider variables that appear in BOTH split and join index positions
    const commonAliases = [...splitAliases].filter(a => joinAliases.has(a));
    console.log(`[cipher] Pass4: common aliases (split+join): ${commonAliases.join(', ') || '(none)'}`);

    for (const alias of commonAliases) {
      const splitPat = `[${alias}[${splitIdx}]]`;
      const joinPat  = `[${alias}[${joinIdx}]]`;

      // Sub-pass 4a: assignment-expression form  NAME=function(param){...}
      let offset = 0;
      while (offset < src.length) {
        const si = src.indexOf(splitPat, offset);
        if (si === -1) break;
        const region = src.slice(Math.max(0, si - 700), si + splitPat.length + 5);
        const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
        if (m) {
          const name    = m[1];
          const realIdx = src.lastIndexOf(name + '=function(', si);
          if (realIdx !== -1) {
            const param     = getFnParam(src, realIdx + name.length + 1);
            const bodyStart = src.indexOf('{', realIdx);
            let body;
            try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
            if (body.includes(joinPat)) {
              console.log(`[cipher] sig fn "${name}" via Pass4a alias "${alias}" (${splitPat}), param="${param}", body ${body.length} chars`);
              // If cipher uses an alias (w) rather than the global table (v), record a bridge decl: var w=v
              const aliasDecl = alias !== tableVarName ? `var ${alias}=${tableVarName}` : null;
              return { name, body, decl: `var ${name}=function(${param})${body}`, strTable, tableAlias: alias, aliasDecl };
            }
          }
        }
        offset = si + 1;
      }

      // Sub-pass 4b: standalone declaration  function NAME(param){...}
      let offset2 = 0;
      while (offset2 < src.length) {
        const si = src.indexOf(splitPat, offset2);
        if (si === -1) break;
        const region = src.slice(Math.max(0, si - 600), si);
        const m = region.match(/function\s+([a-zA-Z$_][\w$]*)\s*\(([a-zA-Z$_]+)\)\s*\{/);
        if (m) {
          const [, name, param] = m;
          const realIdx = src.lastIndexOf('function ' + name, si);
          if (realIdx !== -1) {
            const bodyStart = src.indexOf('{', realIdx);
            let body;
            try { body = extractBody(src, bodyStart); } catch { offset2 = si + 1; continue; }
            if (body.includes(joinPat)) {
              console.log(`[cipher] sig fn "${name}" via Pass4b alias "${alias}" standalone, param="${param}", body ${body.length} chars`);
              const aliasDecl = alias !== tableVarName ? `var ${alias}=${tableVarName}` : null;
              return { name, body, decl: `var ${name}=function(${param})${body}`, strTable, tableAlias: alias, aliasDecl };
            }
          }
        }
        offset2 = si + 1;
      }
    }

    // ── Pass 4c: literal .split()/.join() with string-table ARGUMENT ───────
    // Method names are literal dot-notation, but the empty-string arg comes from
    // the table: sig.split(v[27]) where v[27]=""  →  equivalent to sig.split("")
    if (strTable.emptyIdx !== -1) {
      const emptyBracketRe = new RegExp(`\\[([a-zA-Z$_][\\w$]*)\\[${strTable.emptyIdx}\\]\\]`, 'g');
      const emptyAliases = new Set([tableVarName]);
      let bm2;
      while ((bm2 = emptyBracketRe.exec(src)) !== null) emptyAliases.add(bm2[1]);
      console.log(`[cipher] Pass4c: empty-arg aliases: ${[...emptyAliases].join(', ')}`);

      for (const ea of emptyAliases) {
        const sp = `.split(${ea}[${strTable.emptyIdx}])`;
        const jp = `.join(${ea}[${strTable.emptyIdx}])`;
        let sc = 0, jc = 0;
        { let i = 0; while ((i = src.indexOf(sp, i)) !== -1) { sc++; i++; } }
        { let i = 0; while ((i = src.indexOf(jp, i)) !== -1) { jc++; i++; } }
        console.log(`[cipher] Pass4c: "${sp}" ${sc}×, "${jp}" ${jc}×`);

        let off4c = 0;
        while (off4c < src.length) {
          const si = src.indexOf(sp, off4c);
          if (si === -1) break;
          const region = src.slice(Math.max(0, si - 700), si + sp.length + 5);
          const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
          if (m) {
            const name    = m[1];
            const realIdx = src.lastIndexOf(name + '=function(', si);
            if (realIdx !== -1) {
              const param     = getFnParam(src, realIdx + name.length + 1);
              const bodyStart = src.indexOf('{', realIdx);
              let body;
              try { body = extractBody(src, bodyStart); } catch { off4c = si + 1; continue; }
              if (body.includes(jp)) {
                console.log(`[cipher] sig fn "${name}" via Pass4c (${sp}), param="${param}", body ${body.length} chars`);
                const aliasDecl = ea !== tableVarName ? `var ${ea}=${tableVarName}` : null;
                return { name, body, decl: `var ${name}=function(${param})${body}`, strTable, tableAlias: ea, aliasDecl };
              }
            }
          }
          off4c = si + 1;
        }
      }
    }

    // Dump context for every alias at the split position to diagnose further
    console.error(`[cipher] Pass4 FAILED. split aliases: ${[...splitAliases].join(', ')||'(none)'}, join aliases: ${[...joinAliases].join(', ')||'(none)'}, common: ${commonAliases.join(', ')||'(none)'}`);
    for (const alias of [...splitAliases].slice(0, 4)) {
      const pat = `[${alias}[${splitIdx}]]`;
      let dumpOff = 0, dumpN = 0;
      while (dumpN < 3 && dumpOff < src.length) {
        const si = src.indexOf(pat, dumpOff);
        if (si === -1) break;
        const ctx = src.slice(Math.max(0, si - 300), si + pat.length + 100).replace(/\n/g, '↵');
        console.error(`[cipher]   ${pat}[${dumpN}] @${si}: …${ctx}…`);
        dumpN++;
        dumpOff = si + 1;
      }
    }
  }

  // ── Pass 5: find by .join("") + cipher-typical array mutations ─────────────
  // Cipher functions MUST rejoin the array at the end.  If the function that
  // calls .join("") also does .reverse() or .splice(), it is almost certainly
  // the cipher (utility array functions do NOT rejoin into a string).
  {
    const joinLitIdxs = [];
    { let i = 0; while ((i = src.indexOf('.join("")', i)) !== -1) { joinLitIdxs.push(i); i++; } }
    console.log(`[cipher] Pass5: ${joinLitIdxs.length}× literal .join("")`);

    for (const ji of joinLitIdxs) {
      const region = src.slice(Math.max(0, ji - 800), ji + 10);
      const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
      if (!m) continue;
      const name    = m[1];
      const realIdx = src.lastIndexOf(name + '=function(', ji);
      if (realIdx === -1) continue;
      const param     = getFnParam(src, realIdx + name.length + 1);
      const bodyStart = src.indexOf('{', realIdx);
      let body;
      try { body = extractBody(src, bodyStart); } catch { continue; }
      if (!body.includes('.join("")')) continue;
      const hasReverse = body.includes('.reverse()');
      const hasSplice  = body.includes('.splice(');
      if (hasReverse || hasSplice) {
        console.log(`[cipher] sig fn "${name}" via Pass5 (.join("")+ops), reverse=${hasReverse}, splice=${hasSplice}, body ${body.length} chars`);
        return { name, body, decl: `var ${name}=function(${param})${body}` };
      }
    }
    console.log('[cipher] Pass5: no .join("")+ops function found');
  }

  // ── Final diagnostic dump ────────────────────────────────────────────────────
  console.error(`[cipher] ALL PASSES FAILED. Script ${src.length} chars, ${allSplitIdxs.length}× literal .split("")`);

  // Count patterns we haven't tried so future logs can guide the next fix
  const diagCounts = {};
  { let c = 0, i = 0; while ((i = src.indexOf('.join("")',  i)) !== -1) { c++; i++; } diagCounts['.join("")']  = c; }
  { let c = 0, i = 0; while ((i = src.indexOf('.reverse()', i)) !== -1) { c++; i++; } diagCounts['.reverse()'] = c; }
  { let c = 0, i = 0; while ((i = src.indexOf('.splice(',   i)) !== -1) { c++; i++; } diagCounts['.splice(']   = c; }
  { let c = 0, i = 0; while ((i = src.indexOf('[...',       i)) !== -1) { c++; i++; } diagCounts['[...spread'] = c; }
  if (strTable) {
    const { varName: tn, emptyIdx, reverseIdx, spliceIdx } = strTable;
    if (emptyIdx  !== -1) {
      let c = 0, i = 0; while ((i = src.indexOf(`.split(${tn}[${emptyIdx}])`, i)) !== -1) { c++; i++; }
      diagCounts[`.split(${tn}[${emptyIdx}])`] = c;
      c = 0; i = 0; while ((i = src.indexOf(`.join(${tn}[${emptyIdx}])`, i)) !== -1)  { c++; i++; }
      diagCounts[`.join(${tn}[${emptyIdx}])`]  = c;
    }
    if (reverseIdx !== -1) {
      diagCounts[`[X[${reverseIdx}]] (rev)`]  = (src.match(new RegExp(`\\[[a-zA-Z$_][\\w$]*\\[${reverseIdx}\\]\\]`, 'g')) || []).length;
    }
    if (spliceIdx  !== -1) {
      diagCounts[`[X[${spliceIdx}]] (spl)`]   = (src.match(new RegExp(`\\[[a-zA-Z$_][\\w$]*\\[${spliceIdx}\\]\\]`, 'g')) || []).length;
    }
  }
  console.error('[cipher] pattern counts for next fix:', JSON.stringify(diagCounts));

  for (let k = 0; k < Math.min(6, allSplitIdxs.length); k++) {
    const p   = allSplitIdxs[k];
    const ctx = src.slice(Math.max(0, p - 350), p + 80).replace(/\n/g, '↵');
    console.error(`[cipher]  split[${k}] @${p}: …${ctx}…`);
  }
  throw new Error('Cannot find sig function (split/join pattern absent in all passes)');
}

function extractHelperObject(src, sigBody, strTable) {
  // Classic players use dot-notation:   ;Abc.de(a,12);
  const hm1 = sigBody.match(/;([a-zA-Z$_][\w$]*)\.[a-zA-Z$_][\w$]*\(a/);
  // String-table players use bracket-notation: ;Abc[X[N]](sig,12)
  const hm2 = sigBody.match(/;([a-zA-Z$_][\w$]*)\[[a-zA-Z$_][\w$]*\[\d+\]\]/);

  const helperNames = [];
  if (hm1) helperNames.push(hm1[1]);
  if (hm2 && (!hm1 || hm2[1] !== hm1[1])) helperNames.push(hm2[1]);

  if (helperNames.length === 0) {
    throw new Error('Cannot find helper object name in sig body:\n' + sigBody.slice(0, 300));
  }
  console.log(`[cipher] helper candidates: ${helperNames.join(', ')}`);

  for (const name of helperNames) {
    for (const pat of [
      new RegExp(`var\\s+${name}\\s*=\\s*\\{`),
      new RegExp(`(?:^|[;,{(])${name}\\s*=\\s*\\{`),
    ]) {
      const idx = src.search(pat);
      if (idx === -1) continue;
      const bodyStart = src.indexOf('{', idx);
      let body;
      try { body = extractBody(src, bodyStart); } catch (e) { continue; }
      console.log(`[cipher] helper obj "${name}", body ${body.length} chars`);
      return { name, decl: `var ${name}=${body}` };
    }
  }

  throw new Error('Cannot find helper object declaration: ' + helperNames.join(', '));
}

function extractNFunction(src) {
  // n-param throttle function — literal split patterns
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

  // Try string-table obfuscated n-function
  const strTable = extractStringTable(src);
  if (strTable) {
    const { varName: tn, splitIdx, joinIdx } = strTable;
    const splitPat = `[${tn}[${splitIdx}]]`;
    const joinPat  = `[${tn}[${joinIdx}]]`;
    console.log(`[cipher] n-fn: trying string-table patterns (${splitPat})`);

    // n-fn is typically: NAME=function(a){var b=a[T[S]](T[E]);...;return b[T[J]](T[E])}
    // or:                NAME=function(a){a=a[T[S]](T[E]);...;return a[T[J]](T[E])}
    let offset = 0;
    while (offset < src.length) {
      const si = src.indexOf(splitPat, offset);
      if (si === -1) break;
      const region = src.slice(Math.max(0, si - 600), si + splitPat.length + 5);
      const m = region.match(/([a-zA-Z$_][\w$]*)=function\([a-zA-Z$_]+\)\{/);
      if (m) {
        const name    = m[1];
        const realIdx = src.lastIndexOf(name + '=function(', si);
        if (realIdx !== -1) {
          const bodyStart = src.indexOf('{', realIdx);
          let body;
          try { body = extractBody(src, bodyStart); } catch { offset = si + 1; continue; }
          // n-fn bodies are large (>200 chars) and must have both split + join patterns
          if (body.includes(joinPat) && body.length > 200) {
            console.log(`[cipher] n-fn "${name}" via string-table (${splitPat}), body ${body.length} chars`);
            return { name, decl: `${strTable.decl};\nvar ${name}=function(a)${body}`, strTable };
          }
        }
      }
      offset = si + 1;
    }
    console.log('[cipher] n-fn: string-table search also found nothing');
  }

  console.warn('[cipher] n-fn not found — stream may be throttled but will still play');
  return null;
}

// ── Core decrypt ──────────────────────────────────────────────────────────────
async function decryptSignature(playerUrl, encSig) {
  const script = await getScript(playerUrl);

  let sigFn;
  try {
    sigFn = extractSigFunction(script);
  } catch (e) {
    // Last-resort no-op: return the signature unchanged.
    // For OAuth TV-client streams the URL may already be properly signed
    // or the sig field may be optional — at minimum this avoids a hard crash.
    console.warn(`[cipher] sig extraction failed: ${e.message}`);
    console.warn('[cipher] NO-OP FALLBACK: returning encrypted_signature unchanged');
    return encSig;
  }

  let helper;
  try {
    helper = extractHelperObject(script, sigFn.body, sigFn.strTable);
  } catch (e) {
    console.warn(`[cipher] helper extraction failed: ${e.message}`);
    console.warn('[cipher] NO-OP FALLBACK: returning encrypted_signature unchanged');
    return encSig;
  }

  // Build VM preamble:
  //   [string table]  →  [alias bridge if needed]  →  helper  →  cipher fn  →  call
  // The cipher fn and helper may use a closure-local alias (e.g. w) that points
  // to the same array as the global table (v).  We declare both so all [w[N]]
  // and [v[N]] lookups inside the VM resolve correctly.
  const parts = [];
  if (sigFn.strTable) {
    parts.push(sigFn.strTable.decl);                  // var v=[...]
    if (sigFn.aliasDecl) parts.push(sigFn.aliasDecl); // var w=v
    console.log(`[cipher] VM: string table "${sigFn.strTable.varName}" (${sigFn.strTable.strings.length} entries)` +
      (sigFn.aliasDecl ? `, alias "${sigFn.tableAlias}"` : ''));
  }
  parts.push(helper.decl);
  parts.push(sigFn.decl);
  parts.push(`${sigFn.name}(sig)`);

  const code = parts.join(';\n');
  const ctx  = { sig: encSig };
  console.log(`[cipher] VM exec: code ${code.length} chars, sig.length=${encSig.length}`);

  let result;
  try {
    result = vm.runInNewContext(code, ctx, { timeout: 5000 });
  } catch (vmErr) {
    console.error(`[cipher] VM ERROR: ${vmErr.message}`);
    console.error(`[cipher] VM code (first 600 chars): ${code.slice(0, 600)}`);
    const paramGuess = sigFn.decl.match(/function\s*\(\s*([^)]+)\s*\)/);
    console.error(`[cipher] sig fn param: ${paramGuess ? paramGuess[1] : '?'}, ctx keys: ${Object.keys(ctx).join(', ')}`);
    if (sigFn.strTable)
      console.error(`[cipher] string table var: "${sigFn.strTable.varName}", entries: ${sigFn.strTable.strings.length}`);
    throw vmErr;
  }

  if (typeof result !== 'string' || result.length < 10) {
    console.warn(`[cipher] VM returned suspicious result: ${JSON.stringify(result)} (expected string ≥10 chars)`);
  } else {
    console.log(`[cipher] VM decrypted sig: input ${encSig.length} → output ${result.length} chars`);
  }
  return result;
}

async function decryptN(playerUrl, nVal) {
  const script = await getScript(playerUrl);
  const nFn    = extractNFunction(script);
  if (!nFn) return nVal;

  const ctx = { n: nVal };
  // nFn.decl may already include the string table declaration prepended
  const code = `${nFn.decl};\n${nFn.name}(n)`;
  try {
    const result = vm.runInNewContext(code, ctx, { timeout: 5000 });
    console.log(`[cipher] n-param decrypted: ${nVal.slice(0,10)}… → ${String(result).slice(0,10)}…`);
    return result;
  } catch (e) {
    console.warn(`[cipher] n-fn VM error: ${e.message} — returning nVal unchanged (non-fatal)`);
    return nVal;
  }
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
