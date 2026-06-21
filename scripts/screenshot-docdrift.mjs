import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log('📸 Initializing DocDrift screenshot script...');
  
  const server = http.createServer((req, res) => {
    let reqUrl = req.url.split('?')[0].split('#')[0];
    if (reqUrl === '/' || reqUrl === '/index.html') {
      reqUrl = '/bundle/index.html';
    }
    
    let filePath = path.join(__dirname, '..', reqUrl);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, '../bundle', reqUrl);
    }
    if (!fs.existsSync(filePath) && reqUrl.includes('/public/')) {
      filePath = path.join(__dirname, '..', reqUrl.substring(reqUrl.indexOf('/public/')));
    }

    let contentType = 'text/html';
    if (filePath.endsWith('.js')) contentType = 'application/javascript';
    else if (filePath.endsWith('.css')) contentType = 'text/css';
    else if (filePath.endsWith('.png')) contentType = 'image/png';
    else if (filePath.endsWith('.svg')) contentType = 'image/svg+xml';
    else if (filePath.endsWith('.json')) contentType = 'application/json';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });

  let port = 8000;
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log(`Local static server started at http://localhost:${port}`);
      resolve();
    });
  });

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ['--window-size=1300,900', '--no-sandbox']
  });

  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.toString()));
  
  const localUrl = `http://localhost:${port}/bundle/index.html`;
  console.log(`Navigating to local UI: ${localUrl}`);
  await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 15000 });

  // 1. Initial Screen: Type local path and click Scan
  console.log('Step 1: Configuring workspace audit path...');
  await page.waitForSelector('#workspace-path');
  await page.focus('#workspace-path');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(path.resolve(__dirname, '..'));
  await page.screenshot({ path: 'recording_step1_setup.png' });
  await delay(1000);

  // 2. Click Seed Demo for robust presentation data
  console.log('Step 2: Triggering Simulation Seeding...');
  await page.click('#seed-demo-btn');
  await delay(1500);
  await page.screenshot({ path: 'recording_step2_dashboard.png' });

  // 3. Click the first drift item row in the queue to trigger multi-view detailed review
  console.log('Step 3: Opening Drift Viewer card...');
  await page.waitForSelector('.drift-row');
  const rows = await page.$$('.drift-row');
  if (rows.length > 0) {
    await rows[0].click();
  }
  await delay(1000);
  await page.screenshot({ path: 'recording_step3_viewer.png' });

  // 4. Discuss drift with AI Auditor Agent chat
  console.log('Step 4: Interacting with AI Auditor Chat...');
  await page.waitForSelector('#chat-input-field');
  await page.focus('#chat-input-field');
  await page.keyboard.type('Why did this signature drift?');
  await page.click('#chat-send-btn');
  await delay(2000);
  await page.screenshot({ path: 'recording_step4_chat.png' });

  // 5. Accept current drift fix
  console.log('Step 5: Accepting fix and returning...');
  await page.click('#viewer-accept-btn');
  await delay(1000);
  await page.click('#viewer-back-btn');
  await delay(1000);
  await page.screenshot({ path: 'recording_step5_accepted.png' });

  // 6. Generate unified patch diff and export to R2
  console.log('Step 6: Running patchgen exporter...');
  await page.click('#export-btn');
  await page.waitForSelector('#patch-result-box', { visible: true, timeout: 5000 });
  await delay(1500);
  await page.screenshot({ path: 'recording_step6_exported.png' });

  console.log('📸 Screenshots captured successfully!');
  await browser.close();
  server.close();
}

main().catch(err => {
  console.error('Screenshot script failure:', err);
  process.exit(1);
});
