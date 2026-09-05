(() => {
  if (!(location.hostname === 'gameh5pro.com' || location.hostname.endsWith('.gameh5pro.com'))) return;
  // These production WebViews have no devtools. Avoid retaining game objects
  // in high-volume debug console messages; warnings and errors stay available.
  for (const method of ['log', 'debug', 'info']) console[method] = () => {};
})();
