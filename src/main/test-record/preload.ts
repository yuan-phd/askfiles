// Test build only (docs/test-build.md): a second preload script for every window, registered with
// session.registerPreloadScript next to src/main/preload.ts. It exposes window.askfilesTest and
// loads the test UI (src/renderer/test-record/ui.js) into the AskFiles pages. Like preload.ts it
// runs sandboxed, may load nothing but electron, and has no import or export, so tsc emits a plain
// script. The channel names repeat TEST_CHANNELS in index.ts (test-record.test.ts checks them).
// askfiles-test-record-module

// eslint-disable-next-line @typescript-eslint/no-require-imports
const testElectron = require('electron') as typeof import('electron');

const testInvoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  testElectron.ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
  });

testElectron.contextBridge.exposeInMainWorld('askfilesTest', {
  status: () => testInvoke('askfiles-test:status'),
  record: (event: unknown) => testInvoke('askfiles-test:record', event),
  pause: (paused: unknown) => testInvoke('askfiles-test:pause', paused === true),
  clear: () => testInvoke('askfiles-test:clear'),
  exportRecord: (mode: unknown) => testInvoke('askfiles-test:export', mode === 'full' ? 'full' : 'questions'),
  noticeShown: () => testInvoke('askfiles-test:notice-shown'),
});

// Only the AskFiles pages get the test UI: not the starting and message pages (data: URLs) and not
// the upstream interface behind the developer switch. tsconfig has no DOM types, hence the cast.
const testPage = globalThis as unknown as {
  location: { protocol: string };
  addEventListener(type: string, listener: () => void): void;
  document: {
    createElement(tag: string): { type: string; src: string };
    head: { append(node: unknown): void };
  };
};
if (testPage.location.protocol === 'askfiles:') {
  testPage.addEventListener('DOMContentLoaded', () => {
    const script = testPage.document.createElement('script');
    script.type = 'module';
    script.src = '/test-record/ui.js';
    testPage.document.head.append(script);
  });
}
