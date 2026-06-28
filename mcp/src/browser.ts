import { chromium, type Browser, type Page } from 'playwright';

// Where the transcoder UI (with its window API) is served. The hosted site
// already sends COOP/COEP, so SharedArrayBuffer works in a headless browser and
// the transcode runs locally — the input file is never uploaded. Point this at a
// local server later for fully-offline operation; the tool contract is unchanged.
export const TRANSCODER_URL = process.env.TRANSCODER_URL ?? 'https://transcoder.eyejack.io';
const HEADFUL = process.env.TRANSCODER_MCP_HEADFUL === '1';
const READY_TIMEOUT_MS = Number(process.env.TRANSCODER_MCP_READY_TIMEOUT_MS ?? 60000);

let browser: Browser | null = null;
let page: Page | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function getPage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!browser) {
    browser = await chromium.launch({ headless: !HEADFUL });
  }
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(TRANSCODER_URL, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(
    () => !!(window as unknown as { transcodeFile?: unknown }).transcodeFile &&
          !!(window as unknown as { probeMedia?: unknown }).probeMedia,
    undefined,
    { timeout: READY_TIMEOUT_MS },
  );
  page = p;
  return p;
}

// The transcoder pipeline (one FFmpeg WASM instance per page) is not
// concurrency-safe, so jobs run one at a time, queued in arrival order.
export function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const run = chain.then(() => getPage().then(fn));
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  page = null;
  if (b) await b.close().catch(() => {});
}
