/**
 * The two globals the webview expects from its host.
 *
 * `acquireVsCodeApi` is what the VS Code build calls; `standalonePostMessage` is
 * the JetBrains path. Both are provided here so the UI initialises instead of
 * throwing before it paints. Messages are logged, not answered — the host that
 * answers them is the next piece of work.
 */
// No `require` here on purpose: a sandboxed preload that touches `require`
// throws, and then neither global below is defined — which is exactly how the
// window ends up blank instead of reporting a missing host.
const state = {}
window.acquireVsCodeApi = () => ({
  postMessage: (message) => {
    try { console.log('[0kay-ide] ->', JSON.stringify(message).slice(0, 300)) } catch {}
  },
  getState: () => state,
  setState: (next) => Object.assign(state, next || {}),
})

window.standalonePostMessage = (json) => {
  try { console.log('[0kay-ide][standalone] ->', String(json).slice(0, 300)) } catch {}
}

// Surface Core availability so the shell is not silently offline.
window.addEventListener('DOMContentLoaded', () => {
  fetch('http://127.0.0.1:8080/health')
    .then((response) => console.log('[0kay-ide] core', response.status))
    .catch(() => console.log('[0kay-ide] core unreachable'))
})

