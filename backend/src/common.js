import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';

export const env = (name, fallback = '') => process.env[name] || fallback;
export const tenantId = env('TENANT_ID', '00000000-0000-4000-8000-000000000001');
export const cookieSecure = env('AUTH_COOKIE_SECURE') === '1';
export const sessionCookie = cookieSecure ? '__Host-vitrine_session' : 'vitrine_session';
export const uploadsDir = env('UPLOADS_DIR', './data/uploads');
export const queueDriver = env('QUEUE_DRIVER', 'redis');
export function validateConfig() {
  const environment = env('APP_ENV', 'development');
  if (!['development', 'production'].includes(environment)) throw new Error('APP_ENV must be development or production');
  for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER']) if (!env(key)) throw new Error(`${key} is required`);
  if (!['redis', 'mysql'].includes(queueDriver)) throw new Error('QUEUE_DRIVER must be redis or mysql');
  if (environment === 'production') {
    let base;
    try { base = new URL(env('APP_BASE_URL')); } catch {}
    if (!base || base.protocol !== 'https:' || !base.host || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('APP_BASE_URL must be an HTTPS origin in production');
    if (!cookieSecure) throw new Error('AUTH_COOKIE_SECURE=1 is required in production');
    if (!env('OPENAI_API_KEY')) throw new Error('OPENAI_API_KEY is required in production');
    for (const key of ['SMTP_ADDRESS', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM']) if (!env(key)) throw new Error(`${key} is required in production`);
    const smtpAddress = env('SMTP_ADDRESS').match(/^([A-Za-z0-9.-]+):(\d{1,5})$/);
    if (!smtpAddress || Number(smtpAddress[2]) < 1 || Number(smtpAddress[2]) > 65535) throw new Error('SMTP_ADDRESS must use the host:port format');
    if (!/^[^\s@<>]+@[^\s@<>]+$/.test(env('SMTP_FROM'))) throw new Error('SMTP_FROM must be a valid email address');
    if (!env('DB_PASSWORD') || env('DB_PASSWORD').length < 16 || env('DB_PASSWORD') === 'local_vitrine_password') throw new Error('A unique MySQL password of at least 16 characters is required in production');
    if (env('DB_USER') === 'root') throw new Error('Use a dedicated MySQL application user in production');
    if (queueDriver === 'redis' && (!env('REDIS_PASSWORD') || env('REDIS_PASSWORD').length < 24 || env('REDIS_PASSWORD') === 'local_redis_password')) throw new Error('A unique Redis password of at least 24 characters is required in production');
  }
}
export const makeId = () => randomUUID();
export const token = () => randomBytes(32).toString('hex');
export const hash = (value) => createHash('sha256').update(value).digest('hex');

export const pool = mysql.createPool({
  host: env('DB_HOST', '127.0.0.1'),
  port: Number(env('DB_PORT', '3306')),
  database: env('DB_NAME'),
  user: env('DB_USER'),
  password: env('DB_PASSWORD'),
  charset: 'utf8mb4',
  connectionLimit: 20,
  timezone: 'Z',
  dateStrings: false,
});

export const redis = createClient({
  url: `redis://:${encodeURIComponent(env('REDIS_PASSWORD', ''))}@${env('REDIS_ADDR', '127.0.0.1:6379')}`,
});
redis.on('error', (error) => console.error('Redis connection error:', error.message));
export const connectRedis = async () => { if (!redis.isOpen) await redis.connect(); };

export const campaignFor = (input) => {
  const product = input.product.trim();
  const hook = `Conheça ${product}`;
  const benefit = `Veja os detalhes de ${product} e descubra se combina com o que você procura.`;
  let offer = `Saiba mais sobre ${product}.`;
  if (input.price) offer = input.originalPrice
    ? `Confira por R$ ${input.price} (antes R$ ${input.originalPrice}).`
    : `Confira por R$ ${input.price}.`;
  const cta = ({ 'Oferta relâmpago': 'Confira a oferta', 'Lançamento': 'Conheça a novidade', 'Dor e solução': 'Descubra mais', 'Prova social': 'Veja os detalhes' })[input.goal];
  return {
    hook, benefit, offer, cta,
    caption: `${product}\n${benefit}\n${offer}\n${cta}.\n#novidade #comprasonline`,
    scenes: [
      { label: 'GANCHO · 0–3s', text: hook },
      { label: 'APRESENTAÇÃO · 3–10s', text: benefit },
      { label: 'OFERTA · 10–18s', text: `${offer} ${cta}.` },
    ],
    provider: 'demo', generatedAt: new Date().toISOString(),
  };
};

export function parsePrice(value) { return Number(value.replaceAll('.', '').replace(',', '.')) || 0; }
export function validateCampaignInput(input) {
  if (!input.product?.trim() || [...input.product.trim()].length > 120) return 'O nome do produto deve ter entre 1 e 120 caracteres.';
  if (!['Oferta relâmpago', 'Lançamento', 'Dor e solução', 'Prova social'].includes(input.goal)) return 'Selecione um objetivo de campanha válido.';
  if (!['TikTok', 'Instagram Reels', 'Shopee Video'].includes(input.platform)) return 'Selecione uma plataforma válida.';
  if (!['9:16', '1:1', '4:5', '16:9'].includes(input.ratio)) return 'Selecione um formato de vídeo válido.';
  const pricePattern = /^(?:\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{1,2})?$/;
  for (const price of [input.price || '', input.originalPrice || '']) {
    if (price && (price.length > 32 || !pricePattern.test(price))) return 'Informe os preços no formato 89,90.';
    if (price && parsePrice(price) <= 0) return 'Os preços devem ser maiores que zero.';
  }
  if (input.price && input.originalPrice && parsePrice(input.price) >= parsePrice(input.originalPrice)) return 'O preço promocional deve ser menor que o preço original.';
  return null;
}

export const publicUser = ({ id, name, email }) => ({ id, name, email });
export const uploadPath = (key) => path.join(uploadsDir, key);
export async function ensureUploads() { await mkdir(uploadsDir, { recursive: true, mode: 0o750 }); }
export function imageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ['image/jpeg', 'jpg'];
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
export async function saveImage(buffer, ext) {
  await ensureUploads();
  const key = `${randomBytes(16).toString('hex')}.${ext}`;
  const temp = uploadPath(`.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temp, buffer, { mode: 0o640, flag: 'wx' });
  await rename(temp, uploadPath(key));
  return key;
}
export async function imageExists(key) {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(key)) return false;
  try { return (await stat(uploadPath(key))).isFile(); } catch { return false; }
}
export async function deleteImage(key) { await rm(uploadPath(key), { force: true }); }
export const makeVideoKey = () => `${randomBytes(16).toString('hex')}.mp4`;
export async function videoExists(key) {
  if (!/^[a-f0-9]{32}\.mp4$/.test(key)) return false;
  try { return (await stat(uploadPath(key))).isFile(); } catch { return false; }
}

export const one = async (sql, params = [], db = pool) => { const [rows] = await db.execute(sql, params); return rows[0] || null; };
export const many = async (sql, params = [], db = pool) => { const [rows] = await db.execute(sql, params); return rows; };
export const execute = async (sql, params = [], db = pool) => { const [result] = await db.execute(sql, params); return result; };

export function projectFromRow(row) {
  const campaign = typeof row.campaign_json === 'string' ? JSON.parse(row.campaign_json || 'null') : row.campaign_json;
  const imageKeys = typeof row.image_keys === 'string' ? JSON.parse(row.image_keys || '[]') : row.image_keys;
  return {
    id: row.id, title: row.title, product: row.product, goal: row.goal, platform: row.platform,
    ratio: row.ratio, price: row.price, ...(row.original_price ? { originalPrice: row.original_price } : {}),
    headline: row.headline || '', campaign: campaign || {}, ...(row.image_key ? { imageKey: row.image_key, imageUrl: `/api/v1/uploads/${encodeURIComponent(row.image_key)}` } : {}),
    ...(Array.isArray(imageKeys) && imageKeys.length ? { imageKeys } : {}),
    ...(row.model_key ? { modelUrl: `/api/v1/projects/${encodeURIComponent(row.id)}/model` } : {}),
    status: row.status, progress: row.progress, ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: new Date(row.created_at).toISOString(), version: row.version, background: row.background,
    ...(row.latest_job_id ? { jobId: row.latest_job_id } : {}),
    ...(row.video_key ? { videoUrl: `/api/v1/projects/${encodeURIComponent(row.id)}/video` } : {}),
  };
}

export const projectSelect = `SELECT p.id,p.title,p.product,p.goal,p.platform,p.ratio,p.price,p.original_price,p.headline,p.campaign_json,
 p.image_key,p.video_key,p.model_key,p.status,p.progress,p.created_at,p.version,p.background,p.latest_job_id,
 COALESCE((SELECT JSON_ARRAYAGG(i.image_key) FROM project_images i WHERE i.project_id=p.id AND i.tenant_id=p.tenant_id),JSON_ARRAY()) image_keys,
 COALESCE((SELECT j.error_message FROM render_jobs j WHERE j.id=p.latest_job_id AND j.tenant_id=p.tenant_id),'') error_message
 FROM projects p`;

export const modelExists = async (key) => {
  if (!/^[a-f0-9]{32}\.glb$/.test(key || '')) return false;
  try { return (await stat(uploadPath(key))).isFile(); } catch { return false; }
};

