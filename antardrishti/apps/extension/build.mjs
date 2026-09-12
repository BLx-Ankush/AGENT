/**
 * ANTARDRISHTI — Extension Build Script
 *
 * Produces separate bundles for:
 *   - service worker (ESM for Chrome, IIFE for Firefox)
 *   - content script (IIFE — injected into pages)
 *   - popup (IIFE)
 *
 * Usage:
 *   node build.mjs                     # builds Chrome by default
 *   node build.mjs --target=chrome
 *   node build.mjs --target=firefox
 *   node build.mjs --target=chrome --watch
 */

import * as esbuild from 'esbuild';
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target =
  args.find((a) => a.startsWith('--target='))?.split('=')[1] || 'chrome';
const isWatch = args.includes('--watch');

const distDir = join(__dirname, 'dist', target);
mkdirSync(distDir, { recursive: true });

const isFirefox = target === 'firefox';

const commonOptions = {
  bundle: true,
  target: 'esnext',
  minify: false,
  sourcemap: true,
  platform: 'browser',
  logLevel: 'info',
};

async function build() {
  const startTime = Date.now();

  // 1. Service worker / background script
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/background/service-worker.ts')],
    outfile: join(distDir, 'service-worker.js'),
    format: isFirefox ? 'iife' : 'esm',
  });

  // 2. Content script (always IIFE — injected into web pages)
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/content/content-script.ts')],
    outfile: join(distDir, 'content-script.js'),
    format: 'iife',
  });

  // 3. Popup
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/ui/popup.ts')],
    outfile: join(distDir, 'popup.js'),
    format: 'iife',
  });

  // 4. Copy manifest
  const manifestSrc = join(__dirname, `manifest.${target}.json`);
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, join(distDir, 'manifest.json'));
  } else {
    console.error(`❌ Manifest not found: ${manifestSrc}`);
    process.exit(1);
  }

  // 5. Copy popup HTML + CSS
  copyFileSync(
    join(__dirname, 'src/ui/popup.html'),
    join(distDir, 'popup.html'),
  );
  const cssPath = join(__dirname, 'src/ui/popup.css');
  if (existsSync(cssPath)) {
    copyFileSync(cssPath, join(distDir, 'popup.css'));
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `\n✅ ANTARDRISHTI extension built for ${target} in ${elapsed}ms → ${distDir}\n`,
  );
}

build().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
