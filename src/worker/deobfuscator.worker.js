import { LuaFactory } from 'wasmoon';
import glueWasmUrl from 'wasmoon/dist/glue.wasm?url';

const REPO = '0x251/Prometheus-DeobfuscatorV2';
const REF = 'main';
const JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO}@${REF}/`;
const LIST_API = `https://data.jsdelivr.com/v1/packages/gh/${REPO}@${REF}?structure=flat`;

let sourcesPromise = null;
let enginePromise = null;

function luaQuote(str) {
  return JSON.stringify(str);
}

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
      .filter(f => f.name && f.name.startsWith('/src/') && f.name.endsWith('.lua'))
      .map(f => f.name.replace(/^\//, ''));
    if (!files.length) throw new Error('No Lua files found in deobfuscator repo');

    const sources = {};
    const CONCURRENCY = 8;
    let idx = 0;
    async function pull() {
      while (idx < files.length) {
        const path = files[idx++];
        const r = await fetch(JSDELIVR + path);
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
    return sources;
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
      return `package.preload[${luaQuote(name)}] = function(...)
  local c, e = load(${luaStr(source)}, ${luaQuote(chunk)}, "t")
  if not c then error(e) end
  return c(...)
end`;
    })
    .join('\n');
}

function buildRunLua(source) {
  return `
local logs = {}
local function pushLog(level, ...)
  local parts = {}
  for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
  logs[#logs + 1] = { level = level, message = table.concat(parts, " ") }
end

-- Minimal stubs for the deobfuscator's expectations
if not game then
  game = {
    GetService = function(self, name) return {} end,
  }
end
if not workspace then workspace = {} end
if not Instance then
  Instance = {
    new = function(cls) return {} end,
  }
end
if not task then
  task = {
    wait = function() end,
    spawn = function(f) if f then pcall(f) end end,
    delay = function(t, f) if f then pcall(f) end end,
  }
end
if not Enum then Enum = {} end
if not math.log10 then
  math.log10 = function(v) return math.log(v, 10) end
end
if not os.getenv then
  os.getenv = function() return nil end
end

local Deob = require("deob.pipeline")

local ok, outOrErr = xpcall(function()
  return Deob.run(${luaStr(source)})
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

async function deobfuscate(source) {
  const lua = await getEngine();
  const result = await lua.doString(buildRunLua(source));
  if (!result || result.ok === false) {
    throw new Error(result?.error || 'Deobfuscation failed');
  }
  return { output: String(result.output || ''), logs: result.logs || [] };
}

self.onmessage = async (event) => {
  const { id, source } = event.data;
  try {
    const { output, logs } = await deobfuscate(source);
    self.postMessage({ id, ok: true, output, logs });
  } catch (err) {
    enginePromise = null;
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};
