import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appProtocolHandler, contentType, pageUrl, resolveAppFile } from './app-protocol.js';

const o = { rendererDir: '/app/src/renderer', noticesFile: '/app/THIRD-PARTY-NOTICES' };

describe('askfiles:// scheme', () => {
  it('maps page URLs into the renderer folder', () => {
    expect(pageUrl('ask')).toBe('askfiles://app/ask/index.html');
    expect(resolveAppFile('askfiles://app/ask/index.html', o)).toBe('/app/src/renderer/ask/index.html');
    expect(resolveAppFile('askfiles://app/api/client.js?x=1#y', o)).toBe('/app/src/renderer/api/client.js');
    expect(resolveAppFile('askfiles://app/onboarding/', o)).toBe('/app/src/renderer/onboarding/index.html');
    expect(resolveAppFile('askfiles://app/THIRD-PARTY-NOTICES', o)).toBe('/app/THIRD-PARTY-NOTICES');
  });

  it('refuses other hosts, schemes and paths that leave the folder', () => {
    expect(resolveAppFile('askfiles://other/ask/index.html', o)).toBeNull();
    expect(resolveAppFile('file:///app/src/renderer/ask/index.html', o)).toBeNull();
    // The URL parser already folds dot segments at the root, so this one stays inside.
    expect(resolveAppFile('askfiles://app/%2e%2e/%2e%2e/main/index.js', o)).toBe('/app/src/renderer/main/index.js');
    expect(resolveAppFile('askfiles://app/..%2f..%2fpackage.json', o)).toBeNull();
    expect(resolveAppFile('askfiles://app/ask/%00.html', o)).toBeNull();
    expect(resolveAppFile('askfiles://app/%E0%A4%A', o)).toBeNull();
  });

  it('serves files with the type an ES module needs, and 404 otherwise', async () => {
    expect(contentType('x.js')).toBe('text/javascript; charset=utf-8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-proto-'));
    fs.mkdirSync(path.join(dir, 'ask'));
    fs.writeFileSync(path.join(dir, 'ask', 'ask.js'), 'export {};');
    const handler = appProtocolHandler({ rendererDir: dir, noticesFile: path.join(dir, 'missing') });
    const ok = await handler({ url: 'askfiles://app/ask/ask.js' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await ok.text()).toBe('export {};');
    expect((await handler({ url: 'askfiles://app/ask/nope.js' })).status).toBe(404);
    expect((await handler({ url: 'askfiles://app/THIRD-PARTY-NOTICES' })).status).toBe(404);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
