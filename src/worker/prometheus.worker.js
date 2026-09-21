import { LuaFactory } from 'wasmoon';
import glueWasmUrl from 'wasmoon/dist/glue.wasm?url';

// Try multiple repo candidates — first one that returns /src/*.lua files wins
const REPO_CANDIDATES = [
  'levno-710/Prometheus',
  'prometheus-lua/Prometheus',
];
const REF = 'master';

let sourcesPromise = null;
let enginePromise = null;

function luaStr(str) {
  let level = 0;
  while (str.includes(']' + '='.repeat(level) + ']')) level++;
  const eq = '='.repeat(level);
  return `[${eq}[\n${str}]${eq}]`;
}

async function listFiles(repo) {
  const listUrl = `https://data.jsdelivr.com/v1/packages/gh/${repo}@${REF}?structure=flat`;
  const res = await fetch(listUrl);
  if (!res.ok) throw new Error(`list HTTP ${res.status}`);
  const data = await res.json();
  const allFiles = data.files || [];
  const srcLua = allFiles.filter(
    f => f.type === 'file' && f.name.startsWith('/src/') && f.name.endsWith('.lua')
  );
  return { allFiles, srcLua };
}

async function pickRepo() {
  const errors = [];
  for (const repo of REPO_CANDIDATES) {
    try {
      const { allFiles, srcLua } = await listFiles(repo);
      if (srcLua.length > 0) {
        return { repo, files: srcLua, totalListed: allFiles.length };
      }
      // Give a useful diagnostic if this repo exists but has no /src/*.lua
      const sample = allFiles.slice(0, 5).map(f => f.name).join(', ') || '(none)';
      errors.push(`${repo}: ${allFiles.length} files, 0 .lua under /src/. Sample: ${sample}`);
    } catch (e) {
      errors.push(`${repo}: ${e.message}`);
    }
  }
  throw new Error('No repo worked. ' + errors.join(' | '));
}

async function fetchSources() {
  if (sourcesPromise) return sourcesPromise;
  sourcesPromise = (async () => {
    const picked = await pickRepo();
    const sources = {};
    const CONCURRENCY = 8;
    let idx = 0;
    const cdnBase = `https://cdn.jsdelivr.net/gh/${picked.repo}@${REF}/`;
    async function pull() {
      while (idx < picked.files.length) {
        const path = picked.files[idx++].name.replace(/^\//, '');
        const r = await fetch(cdnBase + path);
        if (!r.ok) throw new Error(`fetch ${path}: HTTP ${r.status}`);
        const text = await r.text();
        const moduleName = path
          .replace(/^src\//, '')
          .replace(/\.lua$/, '')
          .split('/')
          .join('.');
        sources[moduleName] = text;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, pull));
    return { repo: picked.repo, sources };
  })().catch(err => {
    sourcesPromise = null;
    throw err;
  });
  return sourcesPromise;
}

function buildBootstrap(sources) {
  return Object.entries(sources)
    .map(([name, source]) => {
      const chunk = `@/src/${name.split('.').join('/')}.lua`;
      return `package.preload[${luaStr(name)}] = function(...)
  local c, e = load(${luaStr(source)}, ${luaStr(chunk)}, "t")
  if not c then error(e) end
  return c(...)
end`;
    })
    .join('\n');
}

function buildRunLua(opts) {
  return `
local logs = {}
local function pushLog(level, ...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  logs[#logs + 1] = { level = level, message = table.concat(parts, " ") }
end
if not math.log10 then
  math.log10 = function(v) return math.log(v, 10) end
end
local Prometheus = require("prometheus")
Prometheus.Logger.logLevel = Prometheus.Logger.LogLevel.Info
Prometheus.colors.enabled = false
Prometheus.Logger.debugCallback = function(...) pushLog("debug", ...) end
Prometheus.Logger.logCallback = function(...) pushLog("info", ...) end
Prometheus.Logger.warnCallback = function(...) pushLog("warn", ...) end
Prometheus.Logger.errorCallback = function(...) pushLog("error", ...) end
local ok, outOrErr = xpcall(function()
  local config = {}
  for k, v in pairs(Prometheus.Presets[${luaStr(opts.preset)}]) do config[k] = v end
  config.LuaVersion = ${luaStr(opts.luaVersion)}
  config.PrettyPrint = ${opts.prettyPrint ? 'true' : 'false'}
  config.Seed = ${Math.max(1, Math.floor(opts.seed))}
  return Prometheus.Pipeline:fromConfig(config):apply(${luaStr(opts.source)}, ${luaStr(opts.filename)})
end, debug.traceback)
return {
  ok = ok,
  output = ok and outOrErr or "",
  error = ok and "" or outOrErr,
  logs = logs,
}`;
}

async function getEngine() {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const { repo, sources } = await fetchSources();
    const factory = new LuaFactory(glueWasmUrl);
    const lua = await factory.createEngine({ openStandardLibs: true });
    await lua.doString(`_G.arg = _G.arg or {}\n${buildBootstrap(sources)}`);
    return { lua, repo, sourceCount: Object.keys(sources).length };
  })().catch(err => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

async function obfuscate(opts) {
  const { lua } = await getEngine();
  const result = await lua.doString(buildRunLua(opts));
  if (!result || result.ok === false) {
    throw new Error(result?.error || 'Obfuscation failed');
  }
  return { output: String(result.output || ''), logs: result.logs || [] };
}

self.onmessage = async (event) => {
  const { id, ...opts } = event.data;
  try {
    const { output, logs } = await obfuscate(opts);
    self.postMessage({ id, ok: true, output, logs });
  } catch (err) {
    enginePromise = null;
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
