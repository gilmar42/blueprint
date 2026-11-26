import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadsDir } from './common.js';

function run(command, args, { cwd, timeout = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`${command} não está instalado no worker 3D: ${error.message}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} falhou (código ${code}). ${output.trim().slice(-1600)}`));
    });
  });
}

async function firstSparseModel(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const candidate = path.join(root, item.name);
    try { await stat(path.join(candidate, 'images.bin')); return candidate; } catch {}
  }
  throw new Error('As fotos não tiveram sobreposição suficiente para calcular as posições das câmeras. Faça novas fotos com mais detalhes visíveis entre ângulos.');
}

async function findFile(root, suffix) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, item.name);
    if (item.isFile() && item.name.toLowerCase().endsWith(suffix)) return candidate;
    if (item.isDirectory()) { const nested = await findFile(candidate, suffix); if (nested) return nested; }
  }
  return null;
}

export async function reconstructProduct({ imagePaths, modelOutputPath }) {
  if (!Array.isArray(imagePaths) || imagePaths.length < 20 || imagePaths.length > 60) throw new Error('Envie de 20 a 60 fotos para reconstruir o produto em 3D.');
  const work = await mkdtemp(path.join(uploadsDir, '.photogrammetry-'));
  const imageDir = path.join(work, 'images');
  const sparseDir = path.join(work, 'sparse');
  const denseDir = path.join(work, 'dense');
  const dbPath = path.join(work, 'database.db');
  await Promise.all([mkdir(imageDir), mkdir(sparseDir), mkdir(denseDir)]);
  try {
    for (const [index, imagePath] of imagePaths.entries()) {
      await stat(imagePath);
      await copyFile(imagePath, path.join(imageDir, `${String(index).padStart(3, '0')}${path.extname(imagePath).toLowerCase()}`));
    }
    const colmap = process.env.COLMAP_PATH || 'colmap';
    await run(colmap, ['feature_extractor', '--database_path', dbPath, '--image_path', imageDir, '--ImageReader.single_camera', '1', '--FeatureExtraction.use_gpu', '0', '--FeatureExtraction.max_image_size', '1600', '--FeatureExtraction.num_threads', '2'], { cwd: work });
    await run(colmap, ['exhaustive_matcher', '--database_path', dbPath, '--FeatureMatching.use_gpu', '0'], { cwd: work });
    await run(colmap, ['mapper', '--database_path', dbPath, '--image_path', imageDir, '--output_path', sparseDir, '--Mapper.num_threads', '2'], { cwd: work });
    const sparseModel = await firstSparseModel(sparseDir);
    await run(colmap, ['image_undistorter', '--image_path', imageDir, '--input_path', sparseModel, '--output_path', denseDir, '--output_type', 'COLMAP', '--max_image_size', '1200'], { cwd: work });
    const scene = path.join(work, 'scene.mvs');
    await run(process.env.OPENMVS_INTERFACE || 'InterfaceCOLMAP', ['-i', denseDir, '-o', scene, '--image-folder', path.join(denseDir, 'images')], { cwd: work });
    await run(process.env.OPENMVS_DENSIFY || 'DensifyPointCloud', [scene, '--fusion-mode', '-2', '--resolution-level', '1'], { cwd: work, timeout: 2 * 60 * 60 * 1000 });
    const denseScene = path.join(work, 'scene_dense.mvs');
    const densePoints = path.join(work, 'scene_dense.ply');
    const mesh = path.join(work, 'scene_dense_mesh.ply');
    const textured = path.join(work, 'scene_textured.mvs');
    await run(process.env.OPENMVS_MESH || 'ReconstructMesh', [denseScene, '-p', densePoints, '-o', mesh], { cwd: work, timeout: 60 * 60 * 1000 });
    await run(process.env.OPENMVS_TEXTURE || 'TextureMesh', [denseScene, '-m', mesh, '-o', textured, '--export-type', 'glb'], { cwd: work, timeout: 60 * 60 * 1000 });
    const model = await findFile(work, '.glb');
    if (!model) throw new Error('A reconstrução foi concluída sem exportar o modelo 3D.');
    await copyFile(model, modelOutputPath);
    return modelOutputPath;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function renderOrbit({ modelPath, outputPattern, ratio }) {
  const blenderScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-orbit.py');
  await run(process.env.BLENDER_PATH || 'blender', ['--background', '--python', blenderScript, '--', modelPath, outputPattern, ratio], { timeout: 2 * 60 * 60 * 1000 });
}
