/**
 * ANTARDRISHTI — Extension Build Script
 *
 * Produces separate bundles for:
 *   - service worker (ESM for Chrome, IIFE for Firefox)
 *   - offscreen document (IIFE for Chrome only — inference runtime)
 *   - content script (IIFE — injected into pages)
 *   - popup (IIFE)
 *
 * Offscreen document notes:
 *   - Chrome MV3 offscreen documents support Workers and dynamic import().
 *   - The ortMv3Plugin is NOT applied to offscreen.js — it's not needed there.
 *   - ortMv3Plugin is KEPT on service-worker.js (amendment 3: remove only
 *     after live Chrome offscreen inference is confirmed working).
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
  readdirSync,
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

import { readFileSync } from 'fs';

const commonOptions = {
  bundle: true,
  target: 'esnext',
  minify: false,
  sourcemap: true,
  platform: 'browser',
  logLevel: 'info',
};

/**
 * ONNX Runtime Web v1.29.0 ships a thread worker loader:
 *
 *   us = async n => (await import(webpackIgnore n)).default
 *
 * Chrome MV3 service workers reject any SW that CONTAINS import() syntax,
 * even inside dead code paths that are never executed (confirmed: us() has
 * 0 call sites in the WASM-only bundle with numThreads=1).
 *
 * This plugin intercepts the ORT WASM bundle at build time and replaces
 * the import() with a safe stub that throws if somehow called.
 * The stub is never reached at numThreads=1 + proxy=false.
 */
const ortMv3Plugin = {
  name: 'ort-mv3-compat',
  setup(build) {
    build.onLoad(
      { filter: /ort\.wasm\.bundle\.min\.mjs$/ },
      (args) => {
        let source = readFileSync(args.path, 'utf8');

        // Exact minified pattern confirmed from ort.wasm.bundle.min.mjs:
        // us=async n=>(await import(/*webpackIgnore:true*/ /*@vite-ignore*/n)).default
        //
        // Replace with a stub that:
        //   - Removes the import() keyword from the service worker bundle
        //   - Throws clearly if somehow called (should never happen)
        const before = source.indexOf('/*webpackIgnore:true*/');
        if (before !== -1) {
          // Walk back to find 'us=async ' start of the assignment
          const fnStart = source.lastIndexOf(',', before);
          // Walk forward to find the closing .default
          const defaultEnd = source.indexOf('.default', before) + '.default'.length;
          if (fnStart !== -1 && defaultEnd > before) {
            const original = source.slice(fnStart + 1, defaultEnd);
            const stub = `us = async function ortWorkerImportStub() {
  throw new Error('[ORT/MV3] Worker dynamic import() is disabled in Chrome MV3 service workers. ' +
    'Ensure ort.env.wasm.numThreads=1 and ort.env.wasm.proxy=false before InferenceSession.create().');
}`;
            source = source.slice(0, fnStart + 1) + stub + source.slice(defaultEnd);
            console.log('  [ortMv3Plugin] Patched ORT dynamic import() stub for MV3 compatibility');
          }
        }

        return { contents: source, loader: 'js' };
      },
    );
  },
};


async function build() {
  const startTime = Date.now();

  // 1. Service worker / background script
  // Plugin: ortMv3Plugin patches ORT's internal dynamic import() out of
  // the bundle. Chrome MV3 service workers reject any SW that contains
  // import() syntax — even in dead code that is never executed.
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/background/service-worker.ts')],
    outfile: join(distDir, 'service-worker.js'),
    format: isFirefox ? 'iife' : 'esm',
    plugins: [ortMv3Plugin],
  });


  // 2. Offscreen inference document (Chrome only)
  // Offscreen documents support Workers + dynamic import() natively.
  // DO NOT apply ortMv3Plugin here — it is not needed outside service workers.
  // Firefox has no offscreen API — skip for Firefox builds.
  if (!isFirefox) {
    await esbuild.build({
      ...commonOptions,
      entryPoints: [join(__dirname, 'src/offscreen/offscreen.ts')],
      outfile: join(distDir, 'offscreen.js'),
      format: 'iife',
      // No plugins — offscreen context allows import() and Workers
    });
  }

  // 3. Content script (always IIFE — injected into web pages)
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/content/content-script.ts')],
    outfile: join(distDir, 'content-script.js'),
    format: 'iife',
  });

  // 4. Popup
  await esbuild.build({
    ...commonOptions,
    entryPoints: [join(__dirname, 'src/ui/popup.ts')],
    outfile: join(distDir, 'popup.js'),
    format: 'iife',
  });

  // 5. Copy manifest
  const manifestSrc = join(__dirname, `manifest.${target}.json`);
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, join(distDir, 'manifest.json'));
  } else {
    console.error(`❌ Manifest not found: ${manifestSrc}`);
    process.exit(1);
  }

  // 6. Copy popup HTML + CSS
  copyFileSync(
    join(__dirname, 'src/ui/popup.html'),
    join(distDir, 'popup.html'),
  );
  const cssPath = join(__dirname, 'src/ui/popup.css');
  if (existsSync(cssPath)) {
    copyFileSync(cssPath, join(distDir, 'popup.css'));
  }

  // 6b. Copy offscreen HTML (Chrome only)
  // The offscreen document is a real extension page — not a data URL or blob URL.
  // It must be bundled as a static file in the extension package.
  if (!isFirefox) {
    const offscreenHtmlSrc = join(__dirname, 'src/offscreen/offscreen.html');
    if (existsSync(offscreenHtmlSrc)) {
      copyFileSync(offscreenHtmlSrc, join(distDir, 'offscreen.html'));
    } else {
      console.error('❌ offscreen.html not found:', offscreenHtmlSrc);
      process.exit(1);
    }
  }

  // 6c. Copy ORT smoke test page + external script + CSS (CSP-compliant — no inline JS)
  for (const f of ['ort-smoke-test.html', 'ort-smoke-test.js', 'ort-smoke-test.css']) {
    const src = join(__dirname, f);
    if (existsSync(src)) copyFileSync(src, join(distDir, f));
  }

  // 6d. Build + copy benchmark page (evaluation-only — not production)
  const benchmarkTs = join(__dirname, 'benchmark.ts');
  const benchmarkHtml = join(__dirname, 'benchmark.html');
  if (existsSync(benchmarkTs)) {
    await esbuild.build({
      ...commonOptions,
      entryPoints: [benchmarkTs],
      outfile: join(distDir, 'benchmark.js'),
      format: 'iife',
      // No ortMv3Plugin needed — benchmark runs in extension page context, not SW
    });
    if (existsSync(benchmarkHtml)) {
      copyFileSync(benchmarkHtml, join(distDir, 'benchmark.html'));
    }
    console.log('  → Built benchmark page');
  }

  // 7. Copy ONNX model assets → dist/{target}/models/

  // Models are accessed by the service worker at chrome-extension://<id>/models/*.onnx
  const modelsSrc = join(__dirname, 'assets/models');
  const modelsDst = join(distDir, 'models');
  if (existsSync(modelsSrc)) {
    mkdirSync(modelsDst, { recursive: true });
    for (const f of readdirSync(modelsSrc)) {
      copyFileSync(join(modelsSrc, f), join(modelsDst, f));
    }
    console.log(`  → Copied models: ${readdirSync(modelsSrc).join(', ')}`);
  }

  // 7. Copy ONNX Runtime Web WASM assets → dist/{target}/ort/
  // These files are loaded at runtime by ORT via chrome.runtime.getURL('ort/...')
  // NO CDN, NO external fetch — all WASM binaries are extension-local.
  //
  // Files required:
  //   ort-wasm-simd-threaded.wasm      → WASM backend (numThreads=1, SIMD)
  //   ort-wasm-simd-threaded.jsep.wasm → WebGPU/JSEP backend (navigator.gpu)
  const ortSrc = join(__dirname, 'assets/ort');
  const ortDst = join(distDir, 'ort');
  if (existsSync(ortSrc)) {
    mkdirSync(ortDst, { recursive: true });
    const ortFiles = readdirSync(ortSrc);
    for (const f of ortFiles) {
      copyFileSync(join(ortSrc, f), join(ortDst, f));
    }
    console.log(`  → Copied ORT runtime: ${ortFiles.join(', ')}`);
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
