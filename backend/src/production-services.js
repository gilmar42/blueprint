import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env, uploadsDir, makeVideoKey } from './common.js';
import { reconstructProduct, renderOrbit } from './photogrammetry.js';

const campaignSchema = {
  type: 'object',
  properties: {
    hook: { type: 'string' },
    benefit: { type: 'string' },
    offer: { type: 'string' },
    cta: { type: 'string' },
    caption: { type: 'string' },
    scenes: {
      type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, text: { type: 'string' } }, required: ['label', 'text'], additionalProperties: false },
    },
  },
  required: ['hook', 'benefit', 'offer', 'cta', 'caption', 'scenes'],
  additionalProperties: false,
};

const VIDEO_DURATION_SECONDS = 18;

export async function generateCampaign(input) {
  const apiKey = env('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to generate real campaigns.');
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model: env('OPENAI_MODEL', 'gpt-6.2-astra'),
        store: false,
        input: [
          { role: 'system', content: 'Você é um redator profissional de anúncios de comércio eletrônico em português brasileiro. Crie um roteiro claro, objetivo e conciso para um vídeo de 18 segundos e uma legenda. Se o usuário fornecer texto de referência, reorganize e refine a redação com linguagem profissional, preservando a intenção. Use somente fatos fornecidos pelo usuário: não invente características, resultados, avaliações, estoque, prazos ou descontos. Se faltarem detalhes, mantenha o texto genérico e transparente. O preço e o preço original, quando fornecidos, devem ser reproduzidos exatamente. Gere exatamente três cenas: GANCHO · 0–3s, APRESENTAÇÃO · 3–10s, OFERTA · 10–18s. Retorne apenas os campos pedidos pelo schema.' },
          { role: 'user', content: JSON.stringify(input) },
        ],
        text: { format: { type: 'json_schema', name: 'vitrine_campaign', strict: true, schema: campaignSchema } },
        max_output_tokens: 900,
      }),
    });
  } catch (error) {
    error.retryable = true;
    throw error;
  }
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id');
    const payload = await response.json().catch(() => ({}));
    const code = payload.error?.code || payload.error?.type || '';
    const detail = String(payload.error?.message || '').replaceAll(apiKey, '[redacted]').slice(0, 700);
    const suffix = requestId ? ` ID da requisição: ${requestId}.` : '';
    let message = detail || `A OpenAI respondeu com HTTP ${response.status}.`;
    let retryable = response.status >= 500;
    if (response.status === 401) message = 'A OpenAI recusou a chave configurada. Verifique OPENAI_API_KEY e reinicie API e worker.';
    if (response.status === 429 && ['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_exhausted', 'organization_usage_limit_exceeded', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded'].includes(code)) {
      message = 'A conta ou o projeto OpenAI atingiu o limite de crédito, uso ou gastos. Confira faturamento e limites no painel OpenAI.';
    } else if (response.status === 429) {
      message = 'A OpenAI limitou temporariamente as requisições. Aguarde o intervalo indicado e tente novamente.';
      retryable = true;
    }
    const error = new Error(`${message}${suffix}`);
    error.code = code;
    error.status = response.status;
    error.retryable = retryable;
    error.retryAfterMs = Math.min(Number(response.headers.get('retry-after')) * 1000 || 0, 60_000);
    error.publicMessage = `${message}${suffix}`;
    throw error;
  }
  const payload = await response.json();
  const output = payload.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!output) throw new Error('OpenAI returned no campaign text.');
  const campaign = JSON.parse(output);
  if (!campaign.hook?.trim() || !campaign.benefit?.trim() || !campaign.offer?.trim() || !campaign.cta?.trim() || !campaign.caption?.trim() || !Array.isArray(campaign.scenes) || campaign.scenes.length !== 3) {
    throw new Error('OpenAI returned an incomplete campaign.');
  }
  return { ...campaign, provider: 'openai', generatedAt: new Date().toISOString() };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(-1800)}`)));
  });
}

let encoderList;
async function availableEncoders() {
  if (encoderList) return encoderList;
  encoderList = await new Promise((resolve, reject) => {
    const child = spawn(env('FFMPEG_PATH', 'ffmpeg'), ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-100_000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(new Set([...output.matchAll(/^\s*V[^\n]*?\s([a-zA-Z0-9_]+)\s/gm)].map((match) => match[1]))) : reject(new Error('Could not inspect FFmpeg encoders.')));
  });
  return encoderList;
}

function videoEncoderArgs(encoders) {
  const requested = env('VIDEO_ENCODER');
  const encoder = requested || ['libx264', 'libopenh264', 'mpeg4'].find((item) => encoders.has(item));
  if (!encoder || !encoders.has(encoder)) throw new Error('No supported MP4 video encoder is available in this FFmpeg build. Install libx264, libopenh264, or MPEG-4 encoding support.');
  if (encoder === 'libx264') return ['-c:v', encoder, '-preset', env('FFMPEG_PRESET', 'veryfast'), '-crf', '23'];
  if (encoder === 'libopenh264') return ['-c:v', encoder, '-b:v', env('VIDEO_BITRATE', '4M')];
  return ['-c:v', encoder, '-q:v', env('VIDEO_QUALITY', '4')];
}

export async function checkFfmpeg() {
  try { await run(env('FFMPEG_PATH', 'ffmpeg'), ['-version']); await availableEncoders(); }
  catch { throw new Error(`FFmpeg is unavailable at "${env('FFMPEG_PATH', 'ffmpeg')}". Install FFmpeg before starting the campaign worker.`); }
}

export async function renderCampaignVideo({ campaign, imagePath, imagePaths = [], ratio, background = 0 }) {
  if (imagePath) await stat(imagePath);
  const dimensions = ({ '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] })[ratio];
  if (!dimensions) throw new Error('Unsupported video ratio.');
  const [width, height] = dimensions;
  const portrait = height > width;
  const productMaxWidth = Math.round(width * (portrait ? 0.62 : 0.36));
  const productMaxHeight = Math.round(height * (portrait ? 0.34 : 0.70));
  const productY = portrait ? Math.round(height * 0.29) : Math.round(height * 0.14);
  const textFont = Number(env('VIDEO_FONT_SIZE', portrait ? '60' : '54'));
  const fontPath = env('FONT_FILE', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const colors = ['#4c427e', '#293b39', '#824f57'];
  const backgroundColor = colors[Math.min(Math.max(Number(background) || 0, 0), 2)].slice(1);
  const tempDir = await mkdtemp(path.join(uploadsDir, '.render-'));
  const videoKey = makeVideoKey();
  const outputPath = path.join(uploadsDir, videoKey);
  const modelKey = imagePaths.length >= 20 ? `${randomBytes(16).toString('hex')}.glb` : null;
  const modelPath = modelKey ? path.join(uploadsDir, modelKey) : null;
  try {
    const textFiles = [];
    for (const [name, text] of [['hook', campaign.hook], ['benefit', campaign.benefit], ['offer', campaign.offer], ['cta', campaign.cta]]) {
      const file = path.join(tempDir, `${name}.txt`);
      await writeFile(file, String(text).replaceAll('\r', ''), { mode: 0o600 });
      textFiles.push(file);
    }
    const [hookFile, benefitFile, offerFile, ctaFile] = textFiles;
    const font = `fontfile=${fontPath}:`;
    const draw = (file, start, end, y, size) => `drawtext=${font}textfile=${file}:expansion=none:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:line_spacing=14:box=1:boxcolor=black@0.40:boxborderw=18:enable='between(t,${start},${end})'`;
    const headlineY = Math.round(height * (portrait ? 0.10 : 0.08));
    const subtitleY = Math.round(height * (portrait ? 0.68 : 0.79));
    const ctaY = Math.round(height * (portrait ? 0.83 : 0.87));
    let args;
    if (modelKey) {
      const frameDir = path.join(tempDir, 'orbit');
      await reconstructProduct({ imagePaths, modelOutputPath: modelPath });
      await renderOrbit({ modelPath, outputPattern: frameDir, ratio });
      const filter = `[0:v]scale=${width}:${height}[product];[1:v][product]overlay=0:0:format=auto,${draw(hookFile, 0, 3, headlineY, textFont)},${draw(benefitFile, 3, 10, headlineY, textFont)},${draw(offerFile, 10, 15, subtitleY, Math.round(textFont * 0.9))},${draw(ctaFile, 15, VIDEO_DURATION_SECONDS, ctaY, Math.round(textFont * 0.9))}[video]`;
      args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', '24', '-start_number', '1', '-i', `${frameDir}/orbit_%04d.png`, '-f', 'lavfi', '-i', `color=c=${backgroundColor}:s=${width}x${height}:r=24:d=${VIDEO_DURATION_SECONDS}`, '-filter_complex', filter, '-map', '[video]', '-an', '-t', String(VIDEO_DURATION_SECONDS), '-r', '24'];
    } else {
      const filter = `[0:v]scale=${productMaxWidth}:${productMaxHeight}:force_original_aspect_ratio=decrease[product];[1:v][product]overlay=(W-w)/2:${productY},${draw(hookFile, 0, 3, headlineY, textFont)},${draw(benefitFile, 3, 10, headlineY, textFont)},${draw(offerFile, 10, 15, subtitleY, Math.round(textFont * 0.9))},${draw(ctaFile, 15, VIDEO_DURATION_SECONDS, ctaY, Math.round(textFont * 0.9))}[video]`;
      args = ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '30', '-i', imagePath, '-f', 'lavfi', '-i', `color=c=${backgroundColor}:s=${width}x${height}:r=30:d=${VIDEO_DURATION_SECONDS}`, '-filter_complex', filter, '-map', '[video]', '-an', '-t', String(VIDEO_DURATION_SECONDS), '-r', '30'];
    }
    const encoderArgs = videoEncoderArgs(await availableEncoders());
    await run(env('FFMPEG_PATH', 'ffmpeg'), [
      ...args,
      ...encoderArgs,
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath,
    ]);
    return { videoKey, modelKey };
  } catch (error) {
    await rm(outputPath, { force: true });
    if (modelPath) await rm(modelPath, { force: true });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
