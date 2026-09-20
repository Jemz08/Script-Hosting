import { redis, requireAuth, genId } from '../_redis.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const ids = await redis.zrange('scripts:index', 0, -1, { rev: true });
    if (!ids || !ids.length) return res.status(200).json({ scripts: [] });
    const pipeline = redis.pipeline();
    ids.forEach(id => pipeline.get(`script:${id}`));
    const results = await pipeline.exec();
    const scripts = results.filter(Boolean);
    return res.status(200).json({ scripts });
  }

  if (req.method === 'POST') {
    if (!requireAuth(req, res)) return;
    const { id, name, code, description } = req.body || {};
    if (typeof code !== 'string') return res.status(400).json({ error: 'code required' });
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });

    const now = Date.now();
    let scriptId = id;
    let createdAt = now;

    if (scriptId) {
      const existing = await redis.get(`script:${scriptId}`);
      if (existing) createdAt = existing.createdAt || now;
    } else {
      scriptId = genId();
    }

    const script = {
      id: scriptId,
      name,
      code,
      description: description || '',
      createdAt,
      updatedAt: now,
    };

    await redis.set(`script:${scriptId}`, script);
    await redis.zadd('scripts:index', { score: now, member: scriptId });

    return res.status(200).json({ script });
  }

  res.status(405).json({ error: 'method not allowed' });
}