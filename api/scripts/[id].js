import { redis, requireAuth } from '../_redis.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });

  if (req.method === 'GET') {
    if (!requireAuth(req, res)) return;
    const script = await redis.get(`script:${id}`);
    if (!script) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ script });
  }

  if (req.method === 'DELETE') {
    if (!requireAuth(req, res)) return;
    await redis.del(`script:${id}`);
    await redis.zrem('scripts:index', id);
    return res.status(200).json({ ok: true });
  }

  res.status(405).json({ error: 'method not allowed' });
}
