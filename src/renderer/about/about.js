// About page: version from the bridge (window.askfiles.app.info, src/main/preload.ts) and the
// THIRD-PARTY-NOTICES file, which the app serves at askfiles://app/THIRD-PARTY-NOTICES.
const $ = (id) => document.getElementById(id);

async function main() {
  try {
    const info = await window.askfiles?.app?.info();
    if (info) $('version').textContent = `Version ${info.version}`;
  } catch {
    // The version line is cosmetic; the notices below still load.
  }
  try {
    const res = await fetch('/THIRD-PARTY-NOTICES');
    if (!res.ok) throw new Error(String(res.status));
    $('notices').textContent = await res.text();
  } catch (e) {
    $('notices').textContent = `The notices file could not be read (${e.message}).`;
  }
}

main();
