import { LuaFactory } from 'wasmoon';
import glueWasmUrl from 'wasmoon/dist/glue.wasm?url';

const REPO = 'prometheus-lua/Prometheus';
const REF = 'master';
const JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO}@${REF}/`;
const LIST_API = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${REF}?structure=flat`;

let sourcesPromise = null;
let enginePromise = null;

// Lua long-bracket string. Prepends \n so Lua's "strip first newline" rule
// leaves the content byte-identical.
function luaStr(str) {
  let level = 0;
  while (str.includes(']' + '='.repeat(level) + ']')) level++;
  const eq = '='.repeat(level);
  return `[${eq}[\n${str}]${eq}]`;
}

async function fetchSources() {
  if (sourcesPromise) return sourcesPromise;
  sourcesPromise = (async () => {
    const res = await fetch(LIST_API);
    if (!res.ok) throw new Error(`jsDelivr list ${res.status}`);
    const data = await res.json();
    const files = (data.files || [])
      .filter(f => f.type === 'file' && f.name.startsWith('/src/') && f.name.endsWith('.lua'))
      .map(f => f.name.replace(/^\//, ''));
    if (!files.length) throw new Error('No Lua files found');

    const sources = {};
    const CONCURRENCY = 8;
    let idx = 0;
    async function pull() {
      while (idx < files.length) {
        const path = files[idx++];
        const r = await fetch(JSDELIVR + path);
        if (!r.ok) throw new Error(`fetch ${path}: ${r.status}`);
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
    return sources;
  })();
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
    const sources = await fetchSources();
    const factory = new LuaFactory(glueWasmUrl);
    const lua = await factory.createEngine({ openStandardLibs: true });
    await lua.doString(`_G.arg = _G.arg or {}\n${buildBootstrap(sources)}`);
    return lua;
  })().catch(err => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

async function obfuscate(opts) {
  const lua = await getEngine();
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
    enginePromise = null; // force fresh engine on next attempt
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
