import { test, expect } from '@playwright/test';
import { createServer, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURE_HTML = readFileSync(path.join(__dirname, 'ares-fixture.html'), 'utf8');

let fixtureServer: Server | null = null;

test.beforeAll(async () => {
  fixtureServer = createServer((_req, res) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Type', 'text/html');
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => fixtureServer!.listen(7789, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  if (fixtureServer) {
    await new Promise<void>((resolve) => fixtureServer!.close(() => resolve()));
  }
});

test('proxy strips X-Frame-Options and injects companion script', async ({ page }) => {
  const response = await page.goto('http://localhost:7788/app/');
  expect(response?.headers()['x-frame-options']).toBeUndefined();
  const content = await page.content();
  expect(content).toContain('/_companion/inject.js');
});

test('pointer Alt+Click captures element', async ({ page }) => {
  await page.goto('http://localhost:7788/app/');
  await page.waitForTimeout(500); // wait for inject script to bootstrap
  const button = page.locator('#save-btn');
  // simulate Alt+Click via keyboard + mouse
  await page.keyboard.down('Alt');
  await button.click({ modifiers: ['Alt'] });
  await page.keyboard.up('Alt');
  await page.waitForTimeout(500);

  const resp = await page.request.post('http://localhost:7788/_companion/mcp/get_pointed_element', { data: {} });
  const body = await resp.json();
  expect(body).not.toBeNull();
  expect(body.tagName).toBe('button');
});
