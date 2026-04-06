import * as esbuild from 'esbuild';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

const isTest = process.env.TEST === '1';
const outDir = resolve(import.meta.dirname, 'dist');

mkdirSync(outDir, { recursive: true });

async function buildBundle(
  entryPoint: string,
  outFile: string,
  format: 'iife' | 'esm' = 'iife',
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [resolve(import.meta.dirname, entryPoint)],
    bundle: true,
    format,
    minify: !isTest,
    sourcemap: isTest ? 'inline' : false,
    write: false,
    target: 'es2022',
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': isTest ? '"development"' : '"production"',
    },
    // Tree-shake unused code
    treeShaking: true,
    // Mark optional peer deps as external — they're dynamically imported
    // and we don't need them (we use @solana/kit, not legacy web3.js)
    external: ['@solana/web3.js'],
  });

  const code = result.outputFiles[0].text;
  const outPath = resolve(outDir, outFile);
  writeFileSync(outPath, code);
  console.log(`  ${outFile} (${(code.length / 1024).toFixed(1)} KB)`);
  return code;
}

/** Write a bundled JS string as a generated file for embedding in server implementations. */
function writeGenerated(code: string, outPath: string, exportName: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  // Escape backticks and backslashes for template literal embedding
  const escaped = code.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  writeFileSync(outPath, `// AUTO-GENERATED — do not edit. Run \`npm run build\` in html/ to regenerate.\nexport const ${exportName} = \`${escaped}\`;\n`);
}

async function main() {
  console.log('Building MPP payment link assets...');

  // 1. Build the payment UI (IIFE — inlined in HTML)
  const paymentUIRaw = await buildBundle('src/main.ts', 'payment-ui.js');
  // mppx injects `content` as raw HTML — wrap in <script> tags.
  const paymentUI = `<script>${paymentUIRaw}</script>`;

  // 2. Build the service worker for standalone servers (Rust/Go/Lua)
  const serviceWorker = await buildBundle('src/service-worker.ts', 'service-worker.js');

  // 3. Write generated embedding files for each language

  // Rust: write JS for include_str!
  const rustDir = resolve(import.meta.dirname, '..', 'rust', 'src', 'server', 'html');
  mkdirSync(rustDir, { recursive: true });
  writeFileSync(resolve(rustDir, 'payment_ui.gen.js'), paymentUIRaw);
  writeFileSync(resolve(rustDir, 'service_worker.gen.js'), serviceWorker);

  // Go: write JS for go:embed
  const goDir = resolve(import.meta.dirname, '..', 'go', 'server', 'html');
  mkdirSync(goDir, { recursive: true });
  writeFileSync(resolve(goDir, 'payment-ui.gen.js'), paymentUIRaw);
  writeFileSync(resolve(goDir, 'service-worker.gen.js'), serviceWorker);

  // Lua: write as Lua module string
  const luaDir = resolve(import.meta.dirname, '..', 'lua', 'mpp', 'server', 'html_assets');
  mkdirSync(luaDir, { recursive: true });
  const luaEscaped = paymentUIRaw.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  writeFileSync(
    resolve(luaDir, 'gen.lua'),
    `-- AUTO-GENERATED — do not edit. Run \`npm run build\` in html/ to regenerate.\nlocal M = {}\nM.payment_ui_js = '${luaEscaped}'\nreturn M\n`,
  );

  // TypeScript: write as .gen.ts export for @solana/mpp (with <script> wrapper for mppx)
  const tsDir = resolve(import.meta.dirname, '..', 'typescript', 'packages', 'mpp', 'src', 'server');
  const escaped = paymentUI.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  writeFileSync(
    resolve(tsDir, 'html-assets.gen.ts'),
    `// AUTO-GENERATED — do not edit. Run \`npm run build\` in html/ to regenerate.\nexport const PAYMENT_UI_JS = \`${escaped}\`;\n`,
  );

  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
