import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'apps', 'web', 'dist');
const assetsDir = path.join(distDir, 'assets');
const indexHtmlPath = path.join(distDir, 'index.html');
const swPath = path.join(distDir, 'sw.js');

if (!fs.existsSync(indexHtmlPath)) {
  console.error(`Build verification failed: missing ${indexHtmlPath}`);
  process.exit(1);
}

if (!fs.existsSync(assetsDir)) {
  console.error(`Build verification failed: missing ${assetsDir}`);
  process.exit(1);
}

const assetFiles = fs.readdirSync(assetsDir).sort();
if (assetFiles.length === 0) {
  console.error('Build verification failed: dist/assets is empty.');
  process.exit(1);
}

let gitSha = 'local';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  // Ignore if git is unavailable
}

const hash = crypto.createHash('sha256');
for (const file of assetFiles) {
  const fullPath = path.join(assetsDir, file);
  if (fs.statSync(fullPath).isFile()) {
    hash.update(file);
    hash.update(fs.readFileSync(fullPath));
  }
}
const assetDigest = hash.digest('hex').slice(0, 10);
const buildVersion = `1.0.0+${gitSha}.${assetDigest}`;
const cacheName = `webssh-studio-shell-${assetDigest}`;

let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
indexHtml = indexHtml.replace(/__WEBSSH_BUILD_VERSION__/g, buildVersion);
fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');

const basePath = process.env.VITE_BASE_PATH || './';

function resolveAssetDiskPath(refUrl) {
  let clean = refUrl.split('?')[0].split('#')[0];
  if (basePath.startsWith('/') && clean.startsWith(basePath)) {
    clean = clean.slice(basePath.length);
  } else if (clean.startsWith('./')) {
    clean = clean.slice(2);
  } else if (clean.startsWith('/')) {
    clean = clean.slice(1);
  }
  return path.join(distDir, clean);
}

// Verify all script src and link href attributes in dist/index.html exist on disk
const attrRegex = /(?:src|href)=["']([^"']+)["']/g;
const referencedAssets = [];
let match;
while ((match = attrRegex.exec(indexHtml)) !== null) {
  const ref = match[1];
  if (!ref || ref.startsWith('data:') || ref.startsWith('http://') || ref.startsWith('https://')) {
    continue;
  }
  referencedAssets.push(ref);
  const targetPath = resolveAssetDiskPath(ref);
  if (!fs.existsSync(targetPath)) {
    console.error(`Build verification failed: HTML references missing asset "${ref}" (expected at ${targetPath})`);
    process.exit(1);
  }
}

// Verify every JS bundle's relative/dynamic import chunks exist in dist/assets or dist/
for (const file of assetFiles) {
  if (!file.endsWith('.js')) continue;
  const jsContent = fs.readFileSync(path.join(assetsDir, file), 'utf8');
  const chunkRefRegex = /["'](\.\/[A-Za-z0-9_.-]+\.(?:js|css))["']/g;
  let chunkMatch;
  while ((chunkMatch = chunkRefRegex.exec(jsContent)) !== null) {
    const chunkRel = chunkMatch[1];
    const resolvedInAssets = path.resolve(assetsDir, chunkRel);
    const resolvedInDist = path.resolve(distDir, chunkRel);
    if (!fs.existsSync(resolvedInAssets) && !fs.existsSync(resolvedInDist)) {
      console.error(`Build verification failed: bundle ${file} references missing chunk "${chunkRel}"`);
      process.exit(1);
    }
  }
}

// Inject deterministic cache version and precache asset list into dist/sw.js
if (fs.existsSync(swPath)) {
  let swContent = fs.readFileSync(swPath, 'utf8');
  const precacheList = [
    './manifest.webmanifest',
    ...assetFiles.map((f) => `./assets/${f}`)
  ];
  swContent = swContent
    .replace(/__WEBSSH_CACHE_NAME__/g, cacheName)
    .replace(/__WEBSSH_BUILD_VERSION__/g, buildVersion)
    .replace(
      /const PRECACHE_ASSETS = \[[^\]]*\];/,
      `const PRECACHE_ASSETS = ${JSON.stringify(precacheList)};`
    );
  fs.writeFileSync(swPath, swContent, 'utf8');
}

// Ensure .nojekyll exists for GitHub Pages
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');

// Emit build-manifest.json for runtime and deployment inspection
const buildManifest = {
  version: buildVersion,
  cacheName,
  basePath,
  referencedAssets,
  assets: assetFiles
};
fs.writeFileSync(path.join(distDir, 'build-manifest.json'), JSON.stringify(buildManifest, null, 2), 'utf8');

console.log(`Verified production build ${buildVersion} (${assetFiles.length} hashed assets, base="${basePath}").`);
