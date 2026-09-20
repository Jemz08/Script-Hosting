import { Redis } from '@upstash/redis';

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const redis = new Redis({ url, token });

export function requireAuth(req, res) {
  const pass = process.env.EDIT_PASSWORD;
  if (!pass) return true;
  const given = req.headers['x-edit-password'];
  if (given !== pass) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

export function genId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
