const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const assets = [
  { file: 'generate-og-image.html', width: 1200, height: 630, output: 'og-image.png' },
  { file: 'generate-youtube-thumbnail.html', width: 1280, height: 720, output: 'youtube-thumbnail.png' },
  { file: 'generate-devpost-thumbnail.html', width: 1200, height: 800, output: 'devpost-thumbnail.png' },
  { file: 'generate-devpost-gallery.html', width: 1200, height: 800, output: 'devpost-gallery.png' },
  { file: 'generate-readme-hero.html', width: 1280, height: 640, output: 'readme-hero.png' }
];

(async () => {
  const startTime = Date.now();
  console.log('🚀 Starting DocDrift visual assets export pipeline...');

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      deviceScaleFactor: 2 // High-DPI 2x screenshot export
    });
    const page = await context.newPage();

    // 1. Process HTML assets
    for (const asset of assets) {
      const startAssetTime = Date.now();
      const filePath = path.resolve(__dirname, asset.file);
      const fileUrl = `file://${filePath}`;

      await page.setViewportSize({ width: asset.width, height: asset.height });
      await page.goto(fileUrl);
      
      // Wait for fonts to load to prevent fallback font rendering
      await page.evaluate(() => document.fonts.ready);

      await page.screenshot({
        path: path.resolve(__dirname, asset.output),
        fullPage: false,
        animations: 'disabled' // Freeze transitions/pulses at peak state
      });

      const duration = Date.now() - startAssetTime;
      console.log(`✓ Exported ${asset.output} (${asset.width}x${asset.height}) in ${duration}ms`);
    }

    // 2. Process icon.svg rasterization (512px & 1024px) — from the cute icon outside docs/assets
    const svgPath = path.resolve(__dirname, '../../public/icon.svg');
    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    for (const size of [512, 1024]) {
      const startIconTime = Date.now();
      await page.setViewportSize({ width: size, height: size });
      
      // Inject transparent background container and render SVG
      await page.setContent(`
        <style>
          html, body {
            margin: 0;
            padding: 0;
            background: transparent;
            overflow: hidden;
          }
          svg {
            width: ${size}px;
            height: ${size}px;
            display: block;
          }
        </style>
        ${svgContent}
      `);

      await page.evaluate(() => document.fonts.ready);

      await page.screenshot({
        path: path.resolve(__dirname, `icon-${size}.png`),
        omitBackground: true, // Preserve transparency
        animations: 'disabled'
      });

      const duration = Date.now() - startIconTime;
      console.log(`✓ Exported icon-${size}.png (${size}x${size}) in ${duration}ms`);
    }

    console.log(`🎉 Pipeline completed successfully in ${((Date.now() - startTime) / 1000).toFixed(2)}s!`);
  } catch (error) {
    console.error('❌ Pipeline execution failed:', error);
    process.exit(1);
  } finally {
    await browser.close(); // Prevent zombie chromium processes
  }
})().catch(err => {
  console.error('Fatal unhandled error:', err);
  process.exit(1);
});
