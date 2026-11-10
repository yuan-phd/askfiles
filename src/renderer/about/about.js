// About page: version from the bridge (window.askfiles.app.info, src/main/preload.ts), the app's
// license text and the THIRD-PARTY-NOTICES file, which the app serves at askfiles://app/LICENSE and
// askfiles://app/THIRD-PARTY-NOTICES.
const $ = (id) => document.getElementById(id);

// The link opens the license in the page instead of navigating: the window has no back button.
async function toggleLicense(event) {
  event.preventDefault();
  const pre = $('license-text');
  if (!pre.hidden) {
    pre.hidden = true;
    return;
  }
  if (!pre.textContent) {
    try {
      const res = await fetch('/LICENSE');
      if (!res.ok) throw new Error(String(res.status));
      pre.textContent = await res.text();
    } catch (e) {
      pre.textContent = `The license text could not be read (${e.message}). It is the Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0.txt`;
    }
  }
  pre.hidden = false;
}

async function main() {
  $('license-link').addEventListener('click', toggleLicense);
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
