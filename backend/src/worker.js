import { connectRedis, ensureUploads, execute, many, pool, redis, tenantId, validateConfig, queueDriver, uploadPath } from './common.js';
import { checkFfmpeg, generateCampaign, renderCampaignVideo } from './production-services.js';

async function startJob(jobId, projectId, retrying = false) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT status FROM render_jobs WHERE id=? AND tenant_id=? AND project_id=? FOR UPDATE', [jobId, tenantId, projectId]);
    if (!rows[0]) { await conn.rollback(); throw new Error('campaign job does not exist'); }
    if (['completed', 'failed'].includes(rows[0].status) || (rows[0].status === 'processing' && !retrying)) { await conn.rollback(); return false; }
    await conn.execute("UPDATE render_jobs SET status='processing',progress=50,started_at=COALESCE(started_at,UTC_TIMESTAMP(6)) WHERE id=? AND tenant_id=?", [jobId, tenantId]);
    await conn.execute("UPDATE projects SET status='processing',progress=50 WHERE id=? AND tenant_id=? AND latest_job_id=?", [projectId, tenantId, jobId]);
    await conn.commit(); return true;
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}

async function completeJob(jobId, projectId, campaign, videoKey, modelKey) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [project] = await conn.execute("UPDATE projects SET campaign_json=?,headline=?,video_key=?,model_key=?,status='completed',progress=100 WHERE id=? AND tenant_id=? AND latest_job_id=?", [JSON.stringify(campaign), campaign.hook, videoKey, modelKey, projectId, tenantId, jobId]);
    if (!project.affectedRows) throw new Error('project does not reference active job');
    const [job] = await conn.execute("UPDATE render_jobs SET status='completed',progress=100,finished_at=UTC_TIMESTAMP(6),error_message=NULL WHERE id=? AND tenant_id=? AND status='processing'", [jobId, tenantId]);
    if (!job.affectedRows) throw new Error('job is no longer processing');
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; } finally { conn.release(); }
}

async function failJob(jobId, projectId, message) {
  await execute("UPDATE render_jobs SET status='failed',error_message=?,finished_at=UTC_TIMESTAMP(6) WHERE id=? AND tenant_id=? AND status IN ('queued','processing')", [message, jobId, tenantId]);
  await execute("UPDATE projects SET status='failed' WHERE id=? AND tenant_id=? AND latest_job_id=?", [projectId, tenantId, jobId]);
}

async function processCampaign(payload) {
  const { jobId, projectId, input, imageKey, imageKeys = imageKey ? [imageKey] : [], ratio, background = 0, retries = 0 } = payload;
  let campaign = payload.campaign;
  try {
    if (!jobId || !projectId) throw new Error('campaign task is missing identifiers');
    if (!(await startJob(jobId, projectId, Number(retries) > 0))) return;
    if (!imageKey || !ratio) throw new Error('campaign task is missing render inputs');
    campaign ||= await generateCampaign(input);
    const imagePaths = imageKeys.length >= 20 ? imageKeys.map(uploadPath) : [];
    const { videoKey, modelKey } = await renderCampaignVideo({ campaign, imagePath: uploadPath(imageKey), imagePaths, ratio, background });
    await completeJob(jobId, projectId, campaign, videoKey, modelKey);
  } catch (error) {
    console.error(`Campaign job ${jobId} failed:`, error);
    const attempt = Number(retries) || 0;
    if (error.retryable !== false && attempt < 3) {
      const nextPayload = { ...payload, ...(campaign ? { campaign } : {}), retries: attempt + 1 };
      const delay = error.retryAfterMs || Math.min(1500 * (attempt + 1), 10000) + Math.floor(Math.random() * 500);
      if (queueDriver === 'redis') {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await redis.rPush('vitrine:campaigns', JSON.stringify(nextPayload));
      } else {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await processCampaign(nextPayload);
      }
    } else if (jobId && projectId) {
      await failJob(jobId, projectId, error.publicMessage || 'O processamento falhou. Revise a configuração dos serviços e tente novamente.');
    }
  }
}

let stopping = false;
async function main() {
  validateConfig();
  await pool.query('SELECT 1');
  await checkFfmpeg();
  await ensureUploads();
  if (queueDriver === 'redis') await connectRedis();
  console.log('Node campaign worker started');
  while (!stopping) {
    if (queueDriver === 'redis') {
      const result = await redis.blPop('vitrine:campaigns', 0);
      if (result?.element) {
        try { await processCampaign(JSON.parse(result.element)); }
        catch (error) { console.error('Invalid campaign queue payload:', error); }
      }
    } else {
      const jobs = await many(`SELECT j.id job_id,j.project_id,j.job_type,p.product,p.goal,p.platform,p.ratio,p.price,p.original_price,p.image_key,p.background,p.campaign_json,p.text_notes,
        (SELECT JSON_ARRAYAGG(i.image_key) FROM project_images i WHERE i.project_id=p.id) image_keys
        FROM render_jobs j JOIN projects p ON p.id=j.project_id AND p.tenant_id=j.tenant_id
        WHERE j.tenant_id=? AND j.status='queued' AND j.job_type IN ('campaign.generate','campaign.render')
        ORDER BY j.created_at LIMIT 1`, [tenantId]);
      if (jobs.length) {
        const row = jobs[0];
        const campaign = row.job_type === 'campaign.render' ? (typeof row.campaign_json === 'string' ? JSON.parse(row.campaign_json) : row.campaign_json) : undefined;
        const imageKeys = typeof row.image_keys === 'string' ? JSON.parse(row.image_keys || '[]') : row.image_keys || [];
        await processCampaign({ jobId: row.job_id, projectId: row.project_id, imageKey: row.image_key, imageKeys, ratio: row.ratio, background: row.background, campaign, input: { product: row.product, goal: row.goal, platform: row.platform, ratio: row.ratio, price: row.price, originalPrice: row.original_price, textNotes: row.text_notes || '' }, retries: 0 });
      } else await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}
let shutdownPromise;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true;
  shutdownPromise ||= (async () => {
    try { if (redis.isOpen) await redis.quit(); } catch {}
    await pool.end();
  })().catch((error) => console.error('Worker shutdown failed:', error));
});
main().catch((error) => { console.error('Worker startup failed:', error); process.exit(1); });
