import { createServer } from 'node:http';
import { createTransport } from 'nodemailer';
import bcrypt from 'bcryptjs';
import {
  connectRedis, cookieSecure, deleteImage, execute, hash, imageExists, imageType, makeId, many,
  one, parsePrice, pool, projectFromRow, projectSelect, publicUser, redis, saveImage, sessionCookie,
  tenantId, token, uploadPath, validateCampaignInput, env, validateConfig, queueDriver, videoExists, modelExists,
} from './common.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const production = env('APP_ENV', 'development') === 'production';
const appBaseURL = env('APP_BASE_URL', 'http://localhost:3000').replace(/\/$/, '');
const smtpAddress = env('SMTP_ADDRESS');
const smtpParts = smtpAddress.match(/^(.+):(\d+)$/);
const smtpPort = smtpParts ? Number(smtpParts[2]) : 0;
const smtp = smtpParts ? createTransport({ host: smtpParts[1], port: smtpPort, secure: smtpPort === 465, requireTLS: smtpPort !== 465,
  auth: { user: env('SMTP_USERNAME'), pass: env('SMTP_PASSWORD') }, tls: { minVersion: 'TLSv1.2' } }) : null;
const limits = new Map();
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const pricePattern = /^(?:\d{1,3}(?:\.\d{3})*|\d+)(?:,\d{1,2})?$/;

function send(res, status, value, headers = {}) {
  const body = value === undefined ? '' : JSON.stringify(value);
  res.writeHead(status, { ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(body);
}
const fail = (res, status, error) => send(res, status, { error });

async function readBody(req, maxBytes = 1 << 20) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  const raw = await readBody(req);
  try { const value = JSON.parse(raw.toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}
function cookie(req, name) {
  const header = req.headers.cookie || '';
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index >= 0 && item.slice(0, index).trim() === name) return decodeURIComponent(item.slice(index + 1).trim());
  }
  return '';
}
function clientIp(req) {
  const supplied = req.headers['x-real-ip'];
  if (production && typeof supplied === 'string' && /^[0-9a-f:.]+$/i.test(supplied)) return supplied;
  return req.socket.remoteAddress || 'unknown';
}
function rateAllowed(req, key, intervalMs, burst) {
  const now = Date.now(); const id = `${key}:${clientIp(req)}`;
  const bucket = limits.get(id) || { tokens: burst, at: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / intervalMs)); bucket.at = now;
  if (bucket.tokens < 1) { limits.set(id, bucket); return false; }
  bucket.tokens -= 1; limits.set(id, bucket);
  if (limits.size > 10000) for (const [k, v] of limits) if (now - v.at > 3600000) limits.delete(k);
  return true;
}
function allowed(res, req, key, intervalMs, burst) {
  if (rateAllowed(req, key, intervalMs, burst)) return true;
  fail(res, 429, 'Muitas tentativas. Aguarde um pouco e tente novamente.');
  return false;
}
async function auth(req, res) {
  const value = cookie(req, sessionCookie);
  if (!value) { fail(res, 401, 'Faça login para continuar.'); return null; }
  const user = await one(`SELECT u.id,u.tenant_id,u.name,u.email,u.created_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>UTC_TIMESTAMP(6)`, [hash(value)]);
  if (!user) { fail(res, 401, 'Sua sessão expirou. Faça login novamente.'); return null; }
  await execute('UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP(6) WHERE id=?', [hash(value)]);
  return user;
}
async function startSession(res, userId) {
  const session = token();
  await execute('INSERT INTO auth_sessions(id,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 7 DAY))', [hash(session), userId]);
  res.setHeader('Set-Cookie', `${sessionCookie}=${session}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax${cookieSecure ? '; Secure' : ''}`);
}
function emailValid(email) { return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function sessionUser(user) { return { user: publicUser(user) }; }

async function uploadImage(req, user, res) {
  if (!/^multipart\/form-data;\s*boundary=/.test(req.headers['content-type'] || '')) return fail(res, 400, 'Envie uma imagem JPG, PNG ou WebP de até 15 MB.');
  const boundary = (req.headers['content-type'].match(/boundary=(?:"([^"]+)"|([^;]+))/) || []).slice(1).find(Boolean)?.trim();
  if (!boundary) return fail(res, 400, 'Envie uma imagem JPG, PNG ou WebP de até 15 MB.');
  let raw;
  try { raw = await readBody(req, 16 * 1024 * 1024 + 4096); }
  catch (error) { if (error.status === 413) return fail(res, 413, 'A imagem deve ter no máximo 15 MB.'); throw error; }
  const marker = Buffer.from(`--${boundary}`); const separator = Buffer.from('\r\n\r\n');
  let fileBuffer; let files = 0; let fields = 0; let offset = 0;
  while ((offset = raw.indexOf(marker, offset)) !== -1) {
    let start = offset + marker.length;
    if (raw.subarray(start, start + 2).toString() === '--') break;
    if (raw.subarray(start, start + 2).toString() === '\r\n') start += 2;
    const headerEnd = raw.indexOf(separator, start); if (headerEnd < 0) break;
    const headers = raw.subarray(start, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length; const next = raw.indexOf(marker, dataStart);
    if (next < 0) break;
    const dataEnd = next >= 2 && raw.subarray(next - 2, next).toString() === '\r\n' ? next - 2 : next;
    if (/content-disposition:\s*form-data;[^\r\n]*filename=/i.test(headers)) {
      files += 1;
      if (/content-disposition:\s*form-data;[^\r\n]*name="image"/i.test(headers)) fileBuffer = raw.subarray(dataStart, dataEnd);
    } else fields += 1;
    offset = next;
  }
  if (files > 1 || fields > 0) return fail(res, 400, 'Envie uma imagem JPG, PNG ou WebP de até 15 MB.');
  if (fileBuffer?.length > 15 * 1024 * 1024) return fail(res, 413, 'A imagem deve ter no máximo 15 MB.');
  const detected = fileBuffer && imageType(fileBuffer);
  if (!fileBuffer?.length || !detected) return fail(res, 415, 'O arquivo não é uma imagem JPG, PNG ou WebP válida.');
  const key = await saveImage(fileBuffer, detected[1]);
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('SELECT id FROM users WHERE id=? AND tenant_id=? FOR UPDATE', [user.id, tenantId]);
      const [rows] = await conn.execute('SELECT COALESCE(SUM(size_bytes),0) used FROM user_uploads WHERE user_id=?', [user.id]);
      if (fileBuffer.length < 1 || fileBuffer.length > 500 * 1024 * 1024 - Number(rows[0].used)) throw Object.assign(new Error('quota'), { quota: true });
      await conn.execute('INSERT INTO user_uploads(image_key,user_id,size_bytes) VALUES(?,?,?)', [key, user.id, fileBuffer.length]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  } catch (e) {
    await deleteImage(key);
    if (e.quota) return fail(res, 413, 'A conta atingiu o limite de 500 MB para imagens. Contate o administrador para liberar espaço.');
    throw e;
  }
  send(res, 201, { imageKey: key, imageUrl: `/api/v1/uploads/${key}`, mediaType: detected[0] });
}

async function makeProjectRow(id, ownerId) {
  const row = await one(`${projectSelect} WHERE p.tenant_id=? AND p.id=? AND p.owner_user_id=?`, [tenantId, id, ownerId]);
  return row ? projectFromRow(row) : null;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const writeMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (production) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (writeMethod) {
      let origin; try { origin = new URL(req.headers.origin || ''); } catch {}
      const expected = new URL(appBaseURL);
      if (!origin || origin.protocol !== expected.protocol || origin.host.toLowerCase() !== expected.host.toLowerCase()) return fail(res, 403, 'Origem da requisição inválida.');
    }
  }
  if (method === 'GET' && pathname === '/healthz') {
    await pool.query('SELECT 1');
    if (queueDriver === 'redis') { await connectRedis(); await redis.ping(); }
    return send(res, 200, { status: 'ok' });
  }
  if (!pathname.startsWith('/api/v1/')) return fail(res, 404, 'Rota não encontrada.');

  if (method === 'POST' && pathname === '/api/v1/auth/signup') {
    if (!allowed(res, req, 'signup', 60000, 5)) return;
    const input = await jsonBody(req); const name = String(input.name || '').trim(); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
    if ([...name].length < 2 || [...name].length > 120 || !emailValid(email)) return fail(res, 422, 'Informe nome e e-mail válidos.');
    if ([...password].length < 8 || Buffer.byteLength(password) > 72) return fail(res, 422, 'A senha deve ter pelo menos 8 caracteres e no máximo 72 bytes.');
    const id = makeId();
    try { await execute('INSERT INTO users(id,tenant_id,name,email,password_hash) VALUES(?,?,?,?,?)', [id, tenantId, name, email, await bcrypt.hash(password, 10)]); }
    catch (e) { if (e.code === 'ER_DUP_ENTRY') return fail(res, 409, 'Já existe uma conta com este e-mail.'); throw e; }
    await startSession(res, id); return send(res, 201, { user: { id, name, email } });
  }
  if (method === 'POST' && pathname === '/api/v1/auth/login') {
    if (!allowed(res, req, 'login', 5000, 10)) return;
    const input = await jsonBody(req); const email = String(input.email || '').trim().toLowerCase(); const password = String(input.password || '');
    const user = await one('SELECT id,tenant_id,name,email,password_hash,created_at FROM users WHERE tenant_id=? AND email=?', [tenantId, email]);
    const valid = user ? await bcrypt.compare(password, user.password_hash) : await bcrypt.compare(password, '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!valid || !user) return fail(res, 401, 'E-mail ou senha inválidos.');
    await startSession(res, user.id); return send(res, 200, sessionUser(user));
  }
  if (method === 'POST' && pathname === '/api/v1/auth/forgot-password') {
    if (!allowed(res, req, 'forgot-password', 60000, 5)) return;
    if (!smtp || !env('SMTP_USERNAME') || !env('SMTP_PASSWORD') || !env('SMTP_FROM')) return fail(res, 503, 'A recuperação por e-mail ainda não está configurada neste ambiente.');
    const input = await jsonBody(req); const email = String(input.email || '').trim().toLowerCase();
    if (!emailValid(email)) return fail(res, 400, 'Informe um e-mail válido.');
    const user = await one('SELECT id,name,email FROM users WHERE tenant_id=? AND email=?', [tenantId, email]);
    if (user) {
      const resetToken = token();
      await execute('INSERT INTO password_reset_tokens(id,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 MINUTE))', [hash(resetToken), user.id]);
      const link = new URL(appBaseURL); link.hash = `token=${resetToken}`;
      try {
        await smtp.sendMail({ from: env('SMTP_FROM'), to: user.email, subject: 'Redefina sua senha da Vitrine', text: `Olá ${user.name},\n\nUse este link nos próximos 30 minutos para redefinir sua senha:\n${link}\n\nSe você não solicitou essa alteração, ignore esta mensagem.` });
      } catch (error) { console.error('Password reset email failed:', error.message); }
    }
    return send(res, 202, { message: 'Se o e-mail estiver cadastrado, enviaremos instruções de recuperação.' });
  }
  if (method === 'POST' && pathname === '/api/v1/auth/reset-password') {
    if (!allowed(res, req, 'reset-password', 10000, 5)) return;
    const input = await jsonBody(req); const resetToken = String(input.token || ''); const password = String(input.password || '');
    if (resetToken.length < 32 || [...password].length < 8 || Buffer.byteLength(password) > 72) return fail(res, 422, 'Token ou senha inválidos.');
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute('SELECT user_id FROM password_reset_tokens WHERE id=? AND used_at IS NULL AND expires_at>UTC_TIMESTAMP(6) FOR UPDATE', [hash(resetToken)]);
      if (!rows[0]) { await conn.rollback(); return fail(res, 422, 'O link de recuperação expirou ou já foi utilizado.'); }
      const passwordHash = await bcrypt.hash(password, 10);
      await conn.execute('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, rows[0].user_id]);
      await conn.execute('UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP(6) WHERE id=?', [hash(resetToken)]);
      await conn.execute('DELETE FROM auth_sessions WHERE user_id=?', [rows[0].user_id]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    return send(res, 200, { message: 'Senha redefinida com sucesso.' });
  }

  const user = await auth(req, res); if (!user) return;
  if (method === 'GET' && pathname === '/api/v1/auth/me') return send(res, 200, sessionUser(user));
  if (method === 'POST' && pathname === '/api/v1/auth/logout') {
    const value = cookie(req, sessionCookie); if (value) await execute('DELETE FROM auth_sessions WHERE id=?', [hash(value)]);
    res.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${cookieSecure ? '; Secure' : ''}`);
    return send(res, 204);
  }
  if (method === 'POST' && pathname === '/api/v1/uploads') {
    if (!allowed(res, req, 'upload', 1000, 10)) return;
    return uploadImage(req, user, res);
  }
  const uploadMatch = pathname.match(/^\/api\/v1\/uploads\/([a-f0-9]{32}\.(?:jpg|png|webp))$/);
  if (method === 'GET' && uploadMatch) {
    const key = uploadMatch[1];
    if (!(await one('SELECT 1 FROM user_uploads WHERE user_id=? AND image_key=?', [user.id, key]))) return fail(res, 404, 'Imagem não encontrada.');
    if (!(await imageExists(key))) return fail(res, 404, 'Imagem não encontrada.');
    const contentType = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[key.split('.').pop()];
    res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
    return createReadStream(uploadPath(key)).pipe(res);
  }
  if (method === 'GET' && pathname === '/api/v1/projects') {
    const rows = await many(`${projectSelect} WHERE p.tenant_id=? AND p.owner_user_id=? ORDER BY p.created_at DESC`, [tenantId, user.id]);
    return send(res, 200, { projects: rows.map(projectFromRow) });
  }
  if (method === 'POST' && pathname === '/api/v1/projects') {
    const input = await jsonBody(req);
    const campaignInput = { product: String(input.product || '').trim(), goal: input.goal, platform: input.platform, ratio: input.ratio, price: String(input.price || '').trim(), originalPrice: String(input.originalPrice || '').trim(), textNotes: String(input.textNotes || '').trim() };
    const validation = validateCampaignInput(campaignInput); if (validation) return fail(res, 422, validation);
    if (campaignInput.textNotes.length > 2000) return fail(res, 422, 'O texto de referência deve ter no máximo 2.000 caracteres.');
    if (!env('OPENAI_API_KEY')) return fail(res, 503, 'Configure OPENAI_API_KEY no servidor para gerar roteiros reais.');
    const imageKeys = Array.isArray(input.imageKeys) ? [...new Set(input.imageKeys.map((key) => String(key || '').trim()))] : [];
    if (imageKeys.length < 20 || imageKeys.length > 60) return fail(res, 422, 'Envie de 20 a 60 fotos do produto, cobrindo todos os ângulos.');
    const imageKey = imageKeys[0];
    const ownedImages = await many(`SELECT image_key FROM user_uploads WHERE user_id=? AND image_key IN (${imageKeys.map(() => '?').join(',')})`, [user.id, ...imageKeys]);
    if (ownedImages.length !== imageKeys.length) return fail(res, 422, 'Uma ou mais fotos não foram enviadas por esta conta.');
    for (const key of imageKeys) if (!(await imageExists(key))) return fail(res, 422, 'Uma ou mais fotos não estão disponíveis. Envie-as novamente.');
    const projectId = makeId(); const jobId = makeId();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`INSERT INTO projects(id,tenant_id,owner_user_id,title,product,goal,platform,ratio,price,original_price,image_key,text_notes,status,progress,version,background,latest_job_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',0,1,0,?)`, [projectId, tenantId, user.id, campaignInput.product, campaignInput.product, campaignInput.goal, campaignInput.platform, campaignInput.ratio, campaignInput.price, campaignInput.originalPrice, imageKey, campaignInput.textNotes || null, jobId]);
      for (const [sortOrder, key] of imageKeys.entries()) await conn.execute('INSERT INTO project_images(project_id,tenant_id,user_id,image_key,sort_order) VALUES(?,?,?,?,?)', [projectId, tenantId, user.id, key, sortOrder]);
      await conn.execute("INSERT INTO render_jobs(id,tenant_id,project_id,job_type,status,progress) VALUES(?,?,?,'campaign.generate','queued',0)", [jobId, tenantId, projectId]);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    try {
      if (queueDriver === 'redis') {
        await connectRedis();
        await redis.rPush('vitrine:campaigns', JSON.stringify({ jobId, projectId, input: campaignInput, imageKey, imageKeys, ratio: campaignInput.ratio, background: 0, retries: 0 }));
      }
    } catch (e) {
      await execute("UPDATE render_jobs SET status='failed',error_message=?,finished_at=UTC_TIMESTAMP(6) WHERE id=?", ['Não foi possível iniciar o worker.', jobId]);
      await execute("UPDATE projects SET status='failed' WHERE id=? AND latest_job_id=?", [projectId, jobId]);
      return fail(res, 503, 'A campanha foi salva, mas a fila de processamento está indisponível.');
    }
    const project = await makeProjectRow(projectId, user.id);
    return send(res, 202, { project, jobId });
  }
  if (method === 'POST' && pathname === '/api/v1/projects/import') {
    const project = await jsonBody(req);
    if (!project.legacyId || project.legacyId.length > 64 || !project.title || !project.product || project.campaign?.provider !== 'demo' || !project.campaign?.hook || !project.campaign?.caption) return fail(res, 422, 'O projeto local não contém os dados necessários para importação.');
    const validation = validateCampaignInput(project); if (validation) return fail(res, 422, validation);
    if (project.imageKey && (!(await one('SELECT 1 FROM user_uploads WHERE user_id=? AND image_key=?', [user.id, project.imageKey])) || !(await imageExists(project.imageKey)))) return fail(res, 422, 'A imagem do projeto local ainda não foi enviada por esta conta.');
    const id = makeId(); const imageKey = project.imageKey || null;
    const createdAt = Number.isNaN(Date.parse(project.createdAt)) ? new Date() : new Date(project.createdAt);
    await execute(`INSERT INTO projects(id,tenant_id,owner_user_id,legacy_id,title,product,goal,platform,ratio,price,original_price,headline,campaign_json,image_key,status,progress,version,background,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preview',100,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
      [id, tenantId, user.id, project.legacyId, project.title, project.product, project.goal, project.platform, project.ratio, project.price || '', project.originalPrice || '', project.headline || '', JSON.stringify(project.campaign), imageKey, Math.max(Number(project.version) || 1, 1), Math.min(Math.max(Number(project.background) || 0, 0), 2), createdAt]);
    const existing = await one('SELECT id FROM projects WHERE tenant_id=? AND owner_user_id=? AND legacy_id=?', [tenantId, user.id, project.legacyId]);
    return send(res, 200, { project: await makeProjectRow(existing.id, user.id) });
  }
  const jobMatch = pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (method === 'GET' && jobMatch) {
    const id = jobMatch[1]; if (!idPattern.test(id)) return fail(res, 400, 'Identificador de job inválido.');
    const job = await one(`SELECT j.id,j.project_id,j.status,j.progress,j.error_message,j.created_at,j.started_at,j.finished_at FROM render_jobs j JOIN projects p ON p.id=j.project_id AND p.tenant_id=j.tenant_id WHERE j.tenant_id=? AND j.id=? AND p.owner_user_id=?`, [tenantId, id, user.id]);
    if (!job) return fail(res, 404, 'Job não encontrado.');
    const result = { id: job.id, projectId: job.project_id, status: job.status, progress: job.progress, createdAt: new Date(job.created_at).toISOString(), ...(job.error_message ? { error: job.error_message } : {}), ...(job.started_at ? { startedAt: new Date(job.started_at).toISOString() } : {}), ...(job.finished_at ? { finishedAt: new Date(job.finished_at).toISOString() } : {}) };
    return send(res, 200, { job: result });
  }
  const videoMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/video$/);
  if (method === 'GET' && videoMatch) {
    const id = videoMatch[1]; if (!idPattern.test(id)) return fail(res, 400, 'Identificador de projeto inválido.');
    const project = await one('SELECT video_key FROM projects WHERE id=? AND tenant_id=? AND owner_user_id=? AND status=\'completed\'', [id, tenantId, user.id]);
    if (!project?.video_key || !(await videoExists(project.video_key))) return fail(res, 404, 'Vídeo ainda não disponível.');
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': `inline; filename="campaign-${id}.mp4"`, 'Content-Length': String((await stat(uploadPath(project.video_key))).size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return createReadStream(uploadPath(project.video_key)).pipe(res);
  }
  const modelMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/model$/);
  if (method === 'GET' && modelMatch) {
    const id = modelMatch[1]; if (!idPattern.test(id)) return fail(res, 400, 'Identificador de projeto inválido.');
    const project = await one('SELECT model_key FROM projects WHERE id=? AND tenant_id=? AND owner_user_id=? AND status=\'completed\'', [id, tenantId, user.id]);
    if (!project?.model_key || !(await modelExists(project.model_key))) return fail(res, 404, 'Modelo 3D ainda não disponível.');
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Disposition': `attachment; filename="product-${id}.glb"`, 'Content-Length': String((await stat(uploadPath(project.model_key))).size), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return createReadStream(uploadPath(project.model_key)).pipe(res);
  }
  const projectMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (method === 'PUT' && projectMatch) {
    const id = projectMatch[1]; if (!idPattern.test(id)) return fail(res, 400, 'Identificador de projeto inválido.');
    const input = await jsonBody(req); const campaign = input.campaign || {};
    if (Number(input.version) < 1 || !['9:16', '1:1', '4:5', '16:9'].includes(input.ratio) || !Number.isInteger(input.background) || input.background < 0 || input.background > 2 || !input.headline || !['openai', 'demo'].includes(campaign.provider) || !campaign.hook || !campaign.benefit || !campaign.offer || !campaign.cta || !campaign.caption) return fail(res, 422, 'Revise os textos e o formato antes de salvar.');
    const price = String(input.price || '');
    if (price && (price.length > 32 || !pricePattern.test(price))) return fail(res, 422, 'Preço inválido.');
    if (price && parsePrice(price) <= 0) return fail(res, 422, 'O preço promocional deve ser maior que zero.');
    const existing = await one('SELECT original_price,image_key,status FROM projects WHERE id=? AND tenant_id=? AND owner_user_id=?', [id, tenantId, user.id]);
    if (!existing) return fail(res, 404, 'Projeto não encontrado.');
    if (!existing.image_key || !['completed', 'preview', 'failed'].includes(existing.status)) return fail(res, 409, 'Aguarde o processamento atual antes de editar o projeto.');
    const sourceImages = await many('SELECT image_key FROM project_images WHERE project_id=? AND tenant_id=? ORDER BY sort_order', [id, tenantId]);
    const imageKeys = sourceImages.map((row) => row.image_key);
    if (price && existing.original_price && parsePrice(price) >= parsePrice(existing.original_price)) return fail(res, 422, 'O preço promocional deve ser menor que o preço original.');
    const jobId = makeId();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute("UPDATE projects SET price=?,ratio=?,headline=?,campaign_json=?,background=?,version=version+1,status='queued',progress=0,latest_job_id=? WHERE id=? AND tenant_id=? AND owner_user_id=? AND version=?", [price, input.ratio, input.headline, JSON.stringify(campaign), input.background, jobId, id, tenantId, user.id, Number(input.version)]);
      if (!result.affectedRows) { await conn.rollback(); return fail(res, 409, 'O projeto foi alterado em outra sessão; atualize e tente novamente.'); }
      await conn.execute("INSERT INTO render_jobs(id,tenant_id,project_id,job_type,status,progress) VALUES(?,?,?,'campaign.render','queued',0)", [jobId, tenantId, id]);
      await conn.commit();
    } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
    try {
      if (queueDriver === 'redis') {
        await connectRedis();
        await redis.rPush('vitrine:campaigns', JSON.stringify({ jobId, projectId: id, campaign, imageKey: existing.image_key, imageKeys, ratio: input.ratio, background: input.background, retries: 0 }));
      }
    } catch {
      await execute("UPDATE render_jobs SET status='failed',error_message=?,finished_at=UTC_TIMESTAMP(6) WHERE id=?", ['Não foi possível iniciar o worker.', jobId]);
      await execute("UPDATE projects SET status='failed' WHERE id=? AND latest_job_id=?", [id, jobId]);
      return fail(res, 503, 'As alterações foram salvas, mas a fila de renderização está indisponível.');
    }
    return send(res, 202, { project: await makeProjectRow(id, user.id), jobId });
  }
  return fail(res, 404, 'Rota não encontrada.');
}

const server = createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (error) {
    console.error('API request failed:', error?.stack || error);
    if (!res.headersSent) fail(res, error.status || 500, error.status === 413 ? 'A requisição excede o limite permitido.' : 'Ocorreu um erro interno.');
    else res.destroy(error);
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

async function start() {
  validateConfig();
  await pool.query('SELECT 1');
  if (queueDriver === 'redis') await connectRedis();
  await ensureUploads();
  const port = Number(env('API_ADDRESS', ':8080').split(':').pop() || 8080);
  server.listen(port, '0.0.0.0', () => console.log(`Node API listening on :${port}`));
}
import { ensureUploads } from './common.js';
import path from 'node:path';
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) start().catch((error) => { console.error('API startup failed:', error); process.exit(1); });
