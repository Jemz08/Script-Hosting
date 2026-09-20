import { redis } from '../_redis.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).send('-- missing id');

  const script = await redis.get(`script:${id}`);
  if (!script) return res.status(404).send('-- script not found');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  return res.status(200).send(script.code);
}
