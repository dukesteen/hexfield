/* eslint-disable no-await-in-loop -- Pointer moves model one continuous gesture. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { BoardRenderer } from '@cp2p/renderer';

interface FrameSampler {
  samples: number[];
  stop(): void;
}

async function rendererDiagnostics(page: Page) {
  return page.evaluate(() => {
    const preview: { renderer: BoardRenderer } | undefined = Reflect.get(window, '__cp2pBoard');
    return preview?.renderer.getDiagnostics() ?? null;
  });
}

async function sampleGesture(page: Page, gesture: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const samples: number[] = [];
    let active = true;
    let previous: number | null = null;
    const frame = (now: number) => {
      if (!active) return;
      if (previous !== null) samples.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    };
    const sampler: FrameSampler = {
      samples,
      stop: () => {
        active = false;
      },
    };
    Reflect.set(window, '__cp2pFrameSampler', sampler);
    requestAnimationFrame(frame);
  });
  await gesture();
  return page.evaluate(() => {
    const sampler: FrameSampler | undefined = Reflect.get(window, '__cp2pFrameSampler');
    sampler?.stop();
    Reflect.deleteProperty(window, '__cp2pFrameSampler');
    return sampler?.samples ?? [];
  });
}

function frameSummary(samples: readonly number[]) {
  const sorted = [...samples].toSorted((left, right) => left - right);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    count: samples.length,
    meanIntervalMs: mean,
    medianIntervalMs: sorted[Math.floor(sorted.length / 2)],
    p95IntervalMs: sorted[Math.floor(sorted.length * 0.95)],
    meanFps: 1000 / mean,
  };
}

test('mobile board gestures remain bounded under a four-times CPU throttle', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'CPU throttling uses Chromium CDP');
  test.setTimeout(90_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/#/dev/board');
    const canvas = page.locator('.board-view-canvas canvas');
    await expect(canvas).toBeVisible();
    await expect.poll(() => rendererDiagnostics(page)).not.toBeNull();
    const before = await rendererDiagnostics(page);
    const box = await canvas.boundingBox();
    if (!box || !before) throw new Error('Board preview is not ready');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const dragFrames = await sampleGesture(page, async () => {
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      for (let step = 0; step < 90; step++) {
        await page.mouse.move(center.x + 35 * Math.sin(step / 12), center.y + step / 4);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    });
    const zoomFrames = await sampleGesture(page, async () => {
      await page.mouse.move(center.x, center.y);
      for (let step = 0; step < 40; step++) {
        await page.mouse.wheel(0, step % 2 === 0 ? -20 : 20);
        await page.waitForTimeout(16);
      }
    });
    await expect
      .poll(async () => {
        const next = await rendererDiagnostics(page);
        return [next?.activeEffects, next?.queuedDisposals];
      })
      .toEqual([0, 0]);
    const after = await rendererDiagnostics(page);
    expect(after?.rebuiltLayers).toBe(before.rebuiltLayers);
    expect(after?.renderedFrames).toBeGreaterThan(before.renderedFrames);
    expect(dragFrames.length).toBeGreaterThan(15);
    expect(zoomFrames.length).toBeGreaterThan(10);
    expect(errors).toEqual([]);
    const report = JSON.stringify(
      {
        environment:
          'Chromium headless on macOS arm64, mobile viewport 390x844, 4x CDP CPU throttle',
        limitation: 'This is a controlled proxy, not a physical mid-range phone measurement.',
        drag: frameSummary(dragFrames),
        zoom: frameSummary(zoomFrames),
        before,
        after,
      },
      null,
      2,
    );
    await testInfo.attach('renderer-performance-proxy', {
      body: report,
      contentType: 'application/json',
    });
    await writeFile(
      fileURLToPath(
        new URL(
          '../../../docs/verification/stage05/renderer-performance-proxy.json',
          import.meta.url,
        ),
      ),
      report,
    );
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await context.close();
  }
});
