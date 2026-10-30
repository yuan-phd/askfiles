// The browse view on a page of its own; in the app it sits next to Ask on the Ask page.
import { createBrowseView } from './view.js';

createBrowseView(document.getElementById('browse-root'));
document.documentElement.dataset.ready = 'true';
window.askfiles?.app?.pageReady({ page: 'browse' });
