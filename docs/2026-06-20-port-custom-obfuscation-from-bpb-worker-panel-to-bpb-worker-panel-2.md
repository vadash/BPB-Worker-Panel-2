
## Port Custom Obfuscation from BPB-Worker-Panel to BPB-Worker-Panel-2

### Problem
BPB-Worker-Panel-2 uses `javascript-obfuscator` which produces fingerprinted, recognizable output. Workers still get banned because:
1. `javascript-obfuscator`'s `stringArray` pattern is a known signature
2. Sensitive strings (protocol names, `cloudflare`, `proxyIP`, etc.) remain in plaintext
3. No post-build cleanup (console logs, non-ASCII, __name leaks remain)
4. The `mangle` mode only adds junk code without real obfuscation

### Changes

**1. `scripts/build.js` - Full rewrite of obfuscation pipeline**

Replace `javascript-obfuscator` with `js-confuser` and port `customObfuscate()` from the original repo, with these adaptations:

- **Inline sensitive words** (drop `sensitive_words_auto.txt` dependency): Define a `Set<string>` of sensitive words directly in `build.js` - e.g. `vless`, `trojan`, `vmess`, `proxyip`, `proxy-ip`, `cloudflare`, `workers.dev`, `bpb`, `panel`, `websocket`, `uuid`, `password`, etc. This replaces the file-based approach with a hardcoded list that covers the new codebase's sensitive strings.

- **Port custom string encoding**: The XOR+shift encoding with per-build random keys (`SHIFT_KEY`, `XOR_KEY`, `BASE_KEY`). This produces unique obfuscation per build.

- **Port `stringConcealing`** with the predicate function: only apply heavy encoding to strings that match sensitive words, keeping performance acceptable.

- **Port js-confuser options**: `renameVariables`, `renameGlobals`, `renameLabels`, `identifierGenerator: "mangled"`, `movedDeclarations`, `objectExtraction`, `compact`, `hexadecimalNumbers`, `astScrambler`. Disable heavy/slow options (`dispatcher`, `flatten`, `opaquePredicates`, `controlFlowFlattening`, etc.) per the original's well-tested config.

- **Add post-build processing functions** from the original:
  - `removeConsoleLogs()` - strip all console.* calls
  - `replaceNameCalls()` - randomize wrangler `__name()` hashes
  - `removeNonAsciiCharacters()` - strip Unicode/non-ASCII
  - `normalizeWhitespace()` - collapse whitespace

- **Remove `mangle` mode**: Replace the confusing `NODE_ENV=mangle` branching. Always run the full obfuscation pipeline: esbuild → terser minify → post-build preprocessing → js-confuser obfuscation.

- **Adapt for ESM/TypeScript**: The original targets CJS `.js`, but BPB-Worker-Panel-2 uses ESM + TypeScript. The `esbuild` bundle output (after going through esbuild) will already be JS, so `js-confuser` processes the same format. No structural changes needed beyond what esbuild already produces.

- Keep output to `dist/worker.js` and `dist/worker.zip`.

**2. `package.json` - Update dependencies**

- Add: `"js-confuser": "latest"` to devDependencies
- Remove: `"javascript-obfuscator": "latest"` from dependencies

### Files Modified
- `scripts/build.js` (major rewrite of obfuscation section)
- `package.json` (swap obfuscator dependency)

### Not Changed
- No source code changes needed in `src/` (the obfuscation is purely a build-time concern)
- `sensitive_words_auto.txt` is not created (inlined instead)
