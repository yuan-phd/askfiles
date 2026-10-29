/** A plain page for start-up and failures, before any AskFiles page can load. */
export function messagePage(...lines: string[]): string {
  const body = lines.map((l) => `<p>${l.replace(/[<>&]/g, '')}</p>`).join('');
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>AskFiles</title>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:2em;line-height:1.5">
<h1>AskFiles</h1>${body}</body>`)
  );
}

/** Shown while the backend starts; the first launch can take a minute. */
export const STARTING_PAGE = messagePage('Starting. This can take a minute the first time.');
