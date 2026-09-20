import { redis, requireAuth, genId } from '../_redis.js';

function stripCode(s) {
  const { rawCode, code, ...rest } = s;
  return rest;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const ids = await redis.zrange('scripts:index', 0, -1, { rev: true });
    if (!ids || !ids.length) return res.status(200).json({ scripts: [] });
    const pipeline = redis.pipeline();
    ids.forEach(id => pipeline.get(`script:${id}`));
    const results = await pipeline.exec();
    const scripts = results.filter(Boolean).map(stripCode);
    return res.status(200).json({ scripts });
  }

  if (req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const { id, name, rawCode, code, obfuscated, obfuscator, description } = req.body || {};
    if (typeof rawCode !== 'string' && typeof code !== 'string') {
      return res.status(400).json({ error: 'rawCode or code required' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }

    const now = Date.now();
    let scriptId = id;
    let createdAt = now;

    if (scriptId) {
      const existing = await redis.get(`script:${scriptId}`);
      if (existing) createdAt = existing.createdAt || now;
    } else {
      scriptId = genId();
    }

    const raw = typeof rawCode === 'string' ? rawCode : code;
    const served = typeof code === 'string' ? code : rawCode;

    const script = {
      id: scriptId,
      name,
      description: description || '',
      rawCode: raw,
      code: served,
      obfuscated: !!obfuscated,
      obfuscator: obfuscator || null,
      createdAt,
      updatedAt: now,
    };

    await redis.set(`script:${scriptId}`, script);
    await redis.zadd('scripts:index', { score: now, member: scriptId });

    return res.status(200).json({ script: stripCode(script) });
  }

  res.status(405).json({ error: 'method not allowed' });
}
