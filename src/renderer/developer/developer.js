// Developer page: the raw preset values and the data directory, read through
// window.askfiles.developer.info() (src/main/app.ts developerInfo). The main process refuses the
// call unless ASKFILES_DEVELOPER=1, and the menu entry exists only then.
const $ = (testid) => document.querySelector(`[data-testid="${testid}"]`);

$('open-models').addEventListener('click', async () => {
  try {
    await window.askfiles?.developer?.openModels();
  } catch (e) {
    $('message').textContent = e?.message || String(e);
    $('message').hidden = false;
  }
});

async function main() {
  try {
    const info = await window.askfiles?.developer?.info();
    $('data-dir').textContent = info.dataDir;
    $('presets-file').textContent = info.presetsFile;
    $('settings').textContent = JSON.stringify(info.settings, null, 2);
    $('effective-preset').textContent = JSON.stringify(info.effectivePreset, null, 2);
    $('machine-preset').textContent = JSON.stringify(info.machinePreset, null, 2);
  } catch (e) {
    $('message').textContent = e?.message || String(e);
    $('message').hidden = false;
  }
  document.documentElement.dataset.ready = 'true';
}

void main();
