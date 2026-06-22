import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { globSync } from 'glob';
import { minify as jsMinify } from 'terser';
import { minify as htmlMinify } from 'html-minifier';
import JSZip from "jszip";
import { default as JsConfuser } from 'js-confuser';
import pkg from '../package.json' with { type: 'json' };
import { gzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const ASSET_PATH = join(__dirname, '../src/assets');
const DIST_PATH = join(__dirname, '../dist/');

const green = '\x1b[32m';
const red = '\x1b[31m';
const reset = '\x1b[0m';

const success = `${green}✔${reset}`;
const failure = `${red}✗${reset}`;

const version = pkg.version;

// ===================================================================
// SENSITIVE WORDS - Strings that get heavy encoding in obfuscation
// ===================================================================
const SENSITIVE_WORDS = new Set([
    // Protocol names
    'vless', 'trojan', 'vmess', 'v2ray', 'shadowsocks',
    // Proxy/VPN identifiers
    'proxyip', 'proxy-ip', 'proxy_ip', 'proxied',
    // Cloudflare fingerprints
    'cloudflare', 'workers.dev', 'cloudflare-dns',
    'cloudflareclient.com', 'engage.cloudflareclient',
    // Panel identifiers
    'bpb', 'BPB', 'bia-pain-bache',
    // WebSocket related
    'websocket', 'sec-websocket-protocol',
    // Auth/credential strings
    'uuid', 'password', 'secret', 'passphrase', 'userid',
    // Config keys
    'panel', 'subscription', 'sub', 'login', 'logout',
    // DNS
    'dns-query', 'doh',
    // SNI/TLS
    'sni', 'ech', 'fingerprint', 'utls',
    // Fragment
    'fragment', 'fragmentation',
    // WARP
    'warp', 'warp-endpoint',
    // NAT64
    'nat64',
]);

// ===================================================================
// POST-BUILD CONFIGURATION
// ===================================================================
const POST_BUILD_CONFIG = {
    removeConsoleLogs: true,
    replaceNameCalls: true,
    removeNonAsciiCharacters: true,
    normalizeWhitespace: true,
};

// ===================================================================
// POST-BUILD PROCESSING FUNCTIONS
// ===================================================================

function removeConsoleLogs(code) {
    if (!POST_BUILD_CONFIG.removeConsoleLogs) return code;

    let result = code;
    let removedCount = 0;

    const consoleStartRegex = /console\.(log|error|warn|info|debug)\s*\(/g;

    let match;
    const replacements = [];

    while ((match = consoleStartRegex.exec(code)) !== null) {
        const startPos = match.index;
        const openParenPos = match.index + match[0].length - 1;

        let parenCount = 1;
        let pos = openParenPos + 1;
        let inString = false;
        let stringChar = '';
        let escaped = false;

        while (pos < code.length && parenCount > 0) {
            const char = code[pos];

            if (escaped) {
                escaped = false;
            } else if (char === '\\' && inString) {
                escaped = true;
            } else if (!inString && (char === '"' || char === "'" || char === '`')) {
                inString = true;
                stringChar = char;
            } else if (inString && char === stringChar) {
                inString = false;
                stringChar = '';
            } else if (!inString) {
                if (char === '(') parenCount++;
                else if (char === ')') parenCount--;
            }

            pos++;
        }

        if (parenCount === 0) {
            let endPos = pos;

            while (endPos < code.length && /\s/.test(code[endPos])) endPos++;
            if (endPos < code.length && code[endPos] === ';') endPos++;

            const fullMatch = code.substring(startPos, endPos);
            replacements.push({ start: startPos, end: endPos, original: fullMatch });
            removedCount++;
        }
    }

    replacements.sort((a, b) => b.start - a.start);

    for (const replacement of replacements) {
        const hasTrailingSemicolon = replacement.original.trim().endsWith(';');
        const newCode = hasTrailingSemicolon ? 'void 0;' : 'void 0';
        result = result.substring(0, replacement.start) + newCode + result.substring(replacement.end);
    }

    console.log(`${success} Removed ${removedCount} console logs`);
    return result;
}

function replaceNameCalls(code) {
    if (!POST_BUILD_CONFIG.replaceNameCalls) return code;

    const nameCallRegex = /__name\(([^,]+),\s*"([^"]+)"\)/g;
    const matches = [...code.matchAll(nameCallRegex)];

    if (matches.length === 0) {
        console.log(`${success} No __name calls found`);
        return code;
    }

    let newCode = code;
    const replacements = [];

    matches.forEach(match => {
        const randomHexString = Array.from({ length: 4 }, () =>
            Math.floor(Math.random() * 16).toString(16)).join('');
        const newCall = match[0].replace(/__name\(([^,]+),\s*"([^"]+)"\)/, `__name($1, "${randomHexString}")`);
        replacements.push({ original: match[0], new: newCall });
    });

    replacements.forEach(replacement => {
        newCode = newCode.replace(replacement.original, replacement.new);
    });

    console.log(`${success} Replaced ${matches.length} __name calls`);
    return newCode;
}

function removeNonAsciiCharacters(code) {
    if (!POST_BUILD_CONFIG.removeNonAsciiCharacters) return code;

    const cleaned = code.replace(/[^\x00-\x7F]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]{1,6}\}/g, '');
    console.log(`${success} Removed non-ASCII characters and Unicode escapes`);
    return cleaned;
}

function normalizeWhitespace(code) {
    if (!POST_BUILD_CONFIG.normalizeWhitespace) return code;

    const pattern = /((?<string>"(?:\\"|[^"])*"|'(?:\\'|[^'])*')|(?<regex>\/(?:\\\/|[^\/\r\n])+?\/(?:[gmiuy]+)?)|(?<block_comment>\/\*.*?\*\/)|(?<line_comment>\/\/[^\r\n]*)|(?<space>[ \t]+))/gs;

    const cleaned = code.replace(pattern, (match) => {
        if (match.match(/^[ \t]+$/)) {
            return ' ';
        }
        return match;
    });

    const normalized = cleaned.replace(/[\r\n]+/g, '\n');

    console.log(`${success} Normalized whitespace sequences`);
    return normalized;
}

// ===================================================================
// CUSTOM OBFUSCATION using js-confuser
// ===================================================================

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function customObfuscate(sourceCode) {
    const BASE_KEY = 128;
    const SHIFT_KEY = getRandomInt(1, BASE_KEY);
    const XOR_KEY = getRandomInt(1, BASE_KEY);
    console.log(`Using XOR_KEY: ${XOR_KEY} with SHIFT_KEY: ${SHIFT_KEY} with BASE_KEY: ${BASE_KEY}`);

    const options = {
        // REQUIRED
        target: 'browser',

        // ANTISIG - selectively encode strings containing sensitive words
        stringConcealing: (str) => {
            const lower = str.toLowerCase();
            for (const word of SENSITIVE_WORDS) {
                if (lower.includes(word.toLowerCase())) return true;
            }
            return false;
        },
        renameVariables: true,
        renameGlobals: true,
        renameLabels: true,
        identifierGenerator: "mangled",

        // Custom string encoding with per-build random keys
        // Pre-compute a 128-char lookup table at build time so runtime
        // decoding is a single table[index] lookup per character instead
        // of per-char arithmetic + split/map/join overhead.
        customStringEncodings: (() => {
            const decodeTableChars = [];
            for (let i = 0; i < BASE_KEY; i++) {
                const code = ((i - SHIFT_KEY + BASE_KEY) % BASE_KEY);
                const decoded = code ^ XOR_KEY;
                decodeTableChars.push(String.fromCharCode(decoded));
            }
            const decodeTableStr = decodeTableChars.join('');

            return [
                {
                    code: `
                        function {fnName}(str) {
                            var t = ${JSON.stringify(decodeTableStr)};
                            var r = "";
                            for (var i = 0; i < str.length; i++)
                                r += t[str.charCodeAt(i)];
                            return r;
                        }`,
                    encode: (str) => {
                        return str
                            .split('')
                            .map((char) => {
                                var code = char.charCodeAt(0);
                                code = code ^ XOR_KEY;
                                code = (code + SHIFT_KEY) % BASE_KEY;
                                return String.fromCharCode(code);
                            })
                            .join('');
                    },
                },
            ];
        })(),

        // FAST optimizations (movedDeclarations & objectExtraction disabled -
        // they add runtime thunk/getter call overhead per variable/property
        // access with minimal anti-signal benefit; renaming covers it)
        movedDeclarations: false,
        objectExtraction: false,
        compact: true,
        hexadecimalNumbers: true,
        astScrambler: true,
        calculator: false,
        deadCode: false,

        // OPTIONAL (disabled for performance or compatibility)
        dispatcher: false,
        duplicateLiteralsRemoval: false,
        flatten: false,
        preserveFunctionLength: false,
        stringSplitting: false,

        // SLOW (disabled for Cloudflare free plan performance)
        globalConcealing: false,
        opaquePredicates: false,
        variableMasking: false,

        // BUGGY (causes issues with Cloudflare or triggers antivirus)
        controlFlowFlattening: false,
        minify: false,
        rgf: false,

        // SECURITY LOCKS (disabled for performance)
        lock: {
            antiDebug: false,
            integrity: false,
            selfDefending: false,
            tamperProtection: false,
        },
    };

    const result = await JsConfuser.obfuscate(sourceCode, options);
    return result.code;
}

// ===================================================================
// HTML PROCESSING
// ===================================================================

async function processHtmlPages() {
    const indexFiles = globSync('**/index.html', { cwd: ASSET_PATH });
    const result = {};

    for (const relativeIndexPath of indexFiles) {
        const dir = pathDirname(relativeIndexPath);
        const base = (file) => join(ASSET_PATH, dir, file);

        const indexHtml = readFileSync(base('index.html'), 'utf8');
        let finalHtml = indexHtml.replaceAll('__VERSION__', version);

        if (dir !== 'error') {
            const styleCode = readFileSync(base('style.css'), 'utf8');
            const scriptCode = readFileSync(base('script.js'), 'utf8');
            const finalScriptCode = await jsMinify(scriptCode);
            finalHtml = finalHtml
                .replaceAll('__STYLE__', `<style>${styleCode}</style>`)
                .replaceAll('__SCRIPT__', finalScriptCode.code);
        }

        const minifiedHtml = htmlMinify(finalHtml, {
            collapseWhitespace: true,
            removeAttributeQuotes: true,
            minifyCSS: true
        });

        const compressed = gzipSync(minifiedHtml);
        const htmlBase64 = compressed.toString('base64');
        result[dir] = JSON.stringify(htmlBase64);
    }

    console.log(`${success} Assets bundled successfuly!`);
    return result;
}

// ===================================================================
// MAIN BUILD
// ===================================================================

async function buildWorker() {
    const htmls = await processHtmlPages();
    const faviconBuffer = readFileSync('./src/assets/favicon.ico');
    const faviconBase64 = faviconBuffer.toString('base64');

    const code = await build({
        entryPoints: [join(__dirname, '../src/worker.ts')],
        bundle: true,
        format: 'esm',
        write: false,
        external: ['cloudflare:sockets'],
        platform: 'browser',
        target: 'esnext',
        loader: { '.ts': 'ts' },
        define: {
            __PANEL_HTML_CONTENT__: htmls['panel'] ?? '""',
            __LOGIN_HTML_CONTENT__: htmls['login'] ?? '""',
            __ERROR_HTML_CONTENT__: htmls['error'] ?? '""',
            __SECRETS_HTML_CONTENT__: htmls['secrets'] ?? '""',
            __PROXY_IP_HTML_CONTENT__: htmls['proxy-ip'] ?? '""',
            __ICON__: JSON.stringify(faviconBase64),
            __VERSION__: JSON.stringify(version)
        }
    });

    console.log(`${success} Worker built successfuly!`);
    console.log(`Bundle size: ${Math.round(code.outputFiles[0].text.length / 1024)}KB`);

    // Step 1: Minify
    const minifiedCode = await jsMinify(code.outputFiles[0].text, {
        module: true,
        output: { comments: false },
        compress: { dead_code: false, unused: false }
    });

    console.log(`${success} Worker minified successfuly!`);
    console.log(`Minified size: ${Math.round(minifiedCode.code.length / 1024)}KB`);

    // Step 2: Post-build preprocessing (before obfuscation)
    let processedCode = minifiedCode.code;
    console.log(`After minify: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = removeConsoleLogs(processedCode);
    console.log(`After removeConsoleLogs: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = replaceNameCalls(processedCode);
    console.log(`After replaceNameCalls: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = removeNonAsciiCharacters(processedCode);
    console.log(`After removeNonAsciiCharacters: ${Math.round(processedCode.length / 1024)}KB`);

    processedCode = normalizeWhitespace(processedCode);
    console.log(`After normalizeWhitespace: ${Math.round(processedCode.length / 1024)}KB`);

    // Step 3: Obfuscate with js-confuser
    const finalCode = await customObfuscate(processedCode);

    const buildTimestamp = new Date().toISOString();
    const worker = `// Build: ${buildTimestamp}\n// @ts-nocheck\n${finalCode}`;

    console.log(`${success} Worker obfuscated successfuly!`);
    console.log(`Final size: ${Math.round(worker.length / 1024)}KB`);

    mkdirSync(DIST_PATH, { recursive: true });
    writeFileSync('./dist/worker.js', worker, 'utf8');

    const zip = new JSZip();
    zip.file('_worker.js', worker);
    zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE'
    }).then(nodebuffer => writeFileSync('./dist/worker.zip', nodebuffer));

    console.log(`${success} Done!`);
}

buildWorker().catch(err => {
    console.error(`${failure} Build failed:`, err);
    process.exit(1);
});
