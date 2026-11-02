// Google Analytics (GA4) — no-ops entirely if VITE_GA_MEASUREMENT_ID isn't
// set at build time, so this is safe to import unconditionally. gtag.js is
// only injected on the first tracked event, not at module load, so a
// deployment with analytics disabled never fetches anything from Google.
//
// Never pass names, emails, or other PII into event params — GA is a
// third party. Roles/ids/booleans are fine; a person's identity is not.
const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID || '';

let loaded = false;
function ensureLoaded() {
  if (loaded || !GA_ID) return;
  loaded = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); }; // eslint-disable-line prefer-rest-params
  window.gtag('js', new Date());
  // send_page_view: false — this is a single-page app with no real URL
  // changes between tabs, so we send page_view ourselves on tab switches
  // (see trackPageView) instead of relying on gtag's on-load default.
  window.gtag('config', GA_ID, { send_page_view: false });
}

/** Call on every tab/view change — this app's "pages" are React state, not URL routes. */
export function trackPageView(pageName) {
  if (!GA_ID) return;
  ensureLoaded();
  window.gtag('event', 'page_view', { page_title: pageName, page_path: `/${pageName}` });
}

/** Call for a meaningful user action (commitment logged, WIG saved, etc.). */
export function trackEvent(action, params = {}) {
  if (!GA_ID) return;
  ensureLoaded();
  window.gtag('event', action, params);
}
