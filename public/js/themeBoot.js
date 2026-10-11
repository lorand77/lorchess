// Paints with the cached colour scheme before the first frame; theme.js takes
// over once the page has loaded. Loaded as a blocking <script src> in <head>
// rather than inline, so the Content-Security-Policy can refuse inline scripts.
try { if (JSON.parse(localStorage.getItem("lorchess.theme")).scheme === "light") document.documentElement.dataset.scheme = "light"; } catch (e) {}
