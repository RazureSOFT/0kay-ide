/**
 * The host half of Cline's webview protocol, plus the bridge to 0kay-core.
 *
 * The webview talks to whatever embeds it through postMessage: it sends
 * `grpc_request` and waits for `grpc_response` carrying the decoded proto
 * message. In VS Code that host is the extension; here it is this file.
 *
 * The conversation itself lives in 0kay-core: a prompt goes to
 * /api/agent/messages, and the agent's answer is read back from the session's
 * turns. There is deliberately no second agent loop in this process.
 */

/**
 * Theme variables.
 *
 * The webview was built for VS Code, which injects `--vscode-*` custom
 * properties before the app mounts. Without them every `var(--vscode-…)` falls
 * back to nothing: backgrounds go transparent and text inherits the same colour,
 * so the UI is technically rendered and completely invisible.
 */
const THEME = {
  'vscode-font-family': '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  'vscode-font-size': '13px',
  'vscode-foreground': '#e6e3ee',
  'vscode-descriptionForeground': '#b4aec2',
  'vscode-errorForeground': '#ffb4ab',
  'vscode-editor-background': '#1c1b23',
  'vscode-editor-foreground': '#e6e3ee',
  'vscode-editorWidget-background': '#24232d',
  'vscode-editorWidget-border': '#3a3846',
  'vscode-sideBar-background': '#191820',
  'vscode-sideBarSectionHeader-background': '#201f29',
  'vscode-sideBar-foreground': '#e6e3ee',
  'vscode-input-background': '#26252f',
  'vscode-input-foreground': '#e6e3ee',
  'vscode-input-border': '#4a4759',
  'vscode-input-placeholderForeground': '#9b96a8',
  'vscode-button-background': '#b9a6ff',
  'vscode-button-foreground': '#1a1526',
  'vscode-button-secondaryBackground': '#34323f',
  'vscode-button-secondaryForeground': '#e6e3ee',
  'vscode-button-hoverBackground': '#c9baff',
  'vscode-button-border': 'transparent',
  'vscode-badge-background': '#b9a6ff',
  'vscode-badge-foreground': '#1a1526',
  'vscode-focusBorder': '#b9a6ff',
  'vscode-list-hoverBackground': '#2b2935',
  'vscode-list-activeSelectionBackground': '#3a3550',
  'vscode-list-activeSelectionForeground': '#ffffff',
  'vscode-textLink-foreground': '#b9a6ff',
  'vscode-textCodeBlock-background': '#26252f',
  'vscode-textBlockQuote-background': '#23222b',
  'vscode-textBlockQuote-border': '#4a4759',
  'vscode-panel-background': '#1c1b23',
  'vscode-panel-border': '#34323f',
  'vscode-divider': '#34323f',
  'vscode-scrollbarSlider-background': '#4a475966',
  'vscode-scrollbarSlider-hoverBackground': '#4a475999',
  'vscode-scrollbarSlider-activeBackground': '#4a4759cc',
  'vscode-charts-green': '#7ee0a8',
  'vscode-charts-yellow': '#f2cf7d',
  'vscode-charts-red': '#ffb4ab',
  'vscode-charts-blue': '#8ab4ff',
  'vscode-charts-purple': '#b9a6ff',
  'vscode-charts-orange': '#ffb98a',
  'vscode-notifications-background': '#24232d',
  'vscode-notifications-foreground': '#e6e3ee',
  'vscode-editorError-foreground': '#ffb4ab',
  'vscode-editorWarning-foreground': '#f2cf7d',
  'vscode-editorInfo-foreground': '#8ab4ff',
}

function applyTheme() {
  // setProperty per variable instead of injecting a <style> element: the page has
  // a CSP that rejects an inline sheet, and a rejected sheet's text was being
  // rendered as page content.
  //
  // Guarded because preload runs before the document exists: touching
  // documentElement here threw, the whole preload failed to load, and the page
  // fell back to "postMessage fallback" with no bridge at all.
  const root = typeof document !== 'undefined' ? document.documentElement : null
  if (!root) return
  for (const [key, value] of Object.entries(THEME)) {
    root.style.setProperty('--' + key, value)
  }
  root.style.colorScheme = 'dark'
  if (document.body) document.body.classList.add('vscode-dark', 'vscode-high-contrast-off')
}

try {
  applyTheme()
} catch (error) {
  console.log('[0kay-ide] theme skipped', error && error.message)
}
document.addEventListener('DOMContentLoaded', () => {
  try {
    applyTheme()
  } catch (error) {
    console.log('[0kay-ide] theme skipped', error && error.message)
  }
}, { once: true })

// ---------------------------------------------------------------------------
// Crash reporting: a blank frame must say why it is blank
// ---------------------------------------------------------------------------

window.addEventListener('error', (event) => {
  console.log('[page-error]', event.message, (event.filename || '') + ':' + event.lineno + ':' + event.colno)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason
  console.log('[page-rejection]', (reason && (reason.stack || reason.message)) || String(reason))
})

// ---------------------------------------------------------------------------
// Core connection
// ---------------------------------------------------------------------------

// Same origin as the page: the shell proxies /api to Core's port, so no request
// here is cross-origin and the browser will not block it.
const CORE = ''

const extensionState = {
  version: '0.1.4',
  clineMessages: [],
  taskHistory: [],
  shouldShowAnnouncement: false,
  isNewUser: false,
  autoApprovalSettings: { version: 1, enabled: true, actions: {}, favorites: [] },
  browserSettings: {},
  apiConfiguration: {},
  mode: 'act',
  platform: 'vscode',
  telemetrySetting: 'disabled',
}

/**
 * The conversation, in ClineMessage shape.
 *
 * Enums travel by name (`type: 'SAY'`, `say: 'TEXT'`) because the client decodes
 * with protobuf's fromJSON, which expects the JSON mapping rather than numbers.
 */
const clineMessages = []
let sessionId = ''
let stateRequest = null
let pollTimer = 0
let lastReply = ''

const initialState = { stateJson: JSON.stringify({ ...extensionState, clineMessages }) }

function post(message) {
  window.postMessage(message, '*')
}

function respond(request, message, streaming) {
  post({
    type: 'grpc_response',
    grpc_response: {
      request_id: request.request_id,
      message,
      is_streaming: streaming === true,
    },
  })
}

function publishState() {
  if (!stateRequest) return
  const snapshot = { ...extensionState, clineMessages: clineMessages.slice(-60) }
  respond(stateRequest, { stateJson: JSON.stringify(snapshot) }, true)
}

function say(kind, text) {
  clineMessages.push({ ts: Date.now(), type: 'SAY', say: kind, text: String(text || '') })
  publishState()
}

async function ensureSession() {
  if (sessionId) return sessionId
  const response = await fetch(CORE + '/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '0KAY IDE' }),
  })
  if (!response.ok) throw new Error('Core refused a new session (HTTP ' + response.status + ')')
  const data = await response.json()
  sessionId = String(data.session_id || data.id || '')
  if (!sessionId) throw new Error('Core returned no session id')
  return sessionId
}

/**
 * Poll the session's turns until the answer stops changing.
 *
 * Core exposes the result per turn rather than a token stream, so the last
 * stable turn is the answer. Polling is crude but honest: it shows what the
 * agent actually said instead of what we hoped it would say.
 */
function startPolling() {
  if (pollTimer) return
  let idle = 0
  pollTimer = window.setInterval(async () => {
    try {
      const response = await fetch(CORE + '/api/agent/sessions/' + encodeURIComponent(sessionId) + '/turns?limit=5')
      if (!response.ok) return
      const data = await response.json()
      const rows = (data.tasks || []).filter((row) => row.kind !== 'user' && String(row.result || '').trim())
      const latest = rows.length ? String(rows[rows.length - 1].result).trim() : ''
      if (latest && latest !== lastReply) {
        lastReply = latest
        idle = 0
        const last = clineMessages[clineMessages.length - 1]
        if (last && last.say === 'TEXT' && last.partial) last.text = latest
        else clineMessages.push({ ts: Date.now(), type: 'SAY', say: 'TEXT', text: latest, partial: true })
        publishState()
      } else {
        idle += 1
        // Three quiet rounds means the turn finished; drop the partial flag so the
        // UI stops drawing a streaming caret.
        if (idle >= 3 && clineMessages.length) {
          const last = clineMessages[clineMessages.length - 1]
          if (last && last.partial) {
            delete last.partial
            publishState()
          }
          window.clearInterval(pollTimer)
          pollTimer = 0
        }
      }
    } catch {
      /* Core restarting; the next tick retries */
    }
  }, 1500)
}

async function startTask(request) {
  const text = String((request.message && request.message.text) || '').trim()
  if (!text) {
    respond(request, { value: '' }, false)
    return
  }
  lastReply = ''
  clineMessages.push({ ts: Date.now(), type: 'SAY', say: 'TASK', text })
  publishState()
  try {
    await ensureSession()
    console.log('[0kay-ide] session', sessionId)
    const response = await fetch(CORE + '/api/agent/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, prompt: text }),
    })
    if (!response.ok) throw new Error('the agent refused the message (HTTP ' + response.status + ')')
    startPolling()
  } catch (error) {
    console.log('[0kay-ide] task failed', (error && error.message) || String(error))
    say('ERROR', (error && error.message) || String(error))
  }
  respond(request, { value: sessionId }, false)
}

// ---------------------------------------------------------------------------
// The host table
// ---------------------------------------------------------------------------

const host = {
  'cline.StateService': (method) => {
    if (method === 'subscribeToState' || method === 'getState' || method === 'getLatestState') {
      // Kept open on purpose: this subscription is how later updates reach the UI,
      // so completing it after the first frame would freeze the conversation.
      return { kind: 'state', message: initialState }
    }
    if (method === 'subscribeToWorkspaceState') return { kind: 'once', message: {} }
    if (method === 'getAvailableTerminalProfiles') return { kind: 'once', message: { profiles: [] } }
    // Onboarding progress is a VS Code affordance; accepting it silently keeps the
    // console clean without pretending we tracked anything.
    if (method === 'captureOnboardingProgress') return { kind: 'once', message: {} }
    return null
  },
  'cline.AccountService': (method) => {
    if (method === 'subscribeToAuthStatusUpdate' || method === 'getAuthStatus') {
      // No cloud account: this IDE runs against the local agent.
      return { kind: 'once', message: { authenticated: false, provider: '0kay-agent' } }
    }
    return null
  },
  'cline.UiService': (method) => {
    if (method === 'initializeWebview') return { kind: 'once', message: { success: true } }
    if (method.startsWith('subscribeTo')) return { kind: 'once', message: {} }
    return null
  },
  'cline.McpService': (method) => {
    if (method.startsWith('subscribeTo')) return { kind: 'once', message: { mcpServers: [] } }
    return null
  },
  'cline.ModelsService': (method) => {
    // Model catalogues belong to Core, not to Cline's cloud. Empty lists keep the
    // picker honest instead of offering models that cannot answer; the refresh
    // calls are acknowledged so they stop logging failures.
    if (method.startsWith('subscribeTo')) return { kind: 'once', message: { models: [] } }
    if (method.startsWith('refresh') || method === 'resolveProviderModels') return { kind: 'once', message: {} }
    return null
  },
  'cline.TaskService': (method) => {
    if (method === 'newTask') return { kind: 'async', run: startTask }
    if (method === 'askResponse' || method === 'cancelTask') return { kind: 'once', message: {} }
    if (method === 'getTaskHistory') return { kind: 'once', message: { taskHistory: [] } }
    return null
  },
}

function handle(message) {
  if (!message || message.type !== 'grpc_request') {
    if (message && message.type) console.log('[0kay-ide] unhandled', message.type)
    return
  }
  const request = message.grpc_request || {}
  // Every request is logged once: when nothing happens, this line is what tells
  // you whether the bridge saw it at all.
  console.log('[0kay-ide] <-', request.service + '.' + request.method)
  const service = host[request.service]
  const answer = service ? service(String(request.method || '')) : null

  if (!answer) {
    console.log('[0kay-ide] no answer for', request.service + '.' + request.method)
    // An error frame completes the caller; a null message left the promise pending.
    post({
      type: 'grpc_response',
      grpc_response: {
        request_id: request.request_id,
        error: 'not supported by 0KAY IDE: ' + request.service + '.' + request.method,
        is_streaming: false,
      },
    })
    return
  }

  if (answer.kind === 'async') {
    answer.run(request)
    return
  }

  if (answer.kind === 'state') {
    // Remember the subscription before replying, so the first publish lands on it.
    stateRequest = request
    respond(request, answer.message, true)
    return
  }

  respond(request, answer.message, answer.kind === 'stream')
}

window.acquireVsCodeApi = () => ({
  postMessage: (message) => handle(message),
  getState: () => ({}),
  setState: () => {},
})

window.standalonePostMessage = (json) => {
  try {
    handle(JSON.parse(String(json)))
  } catch {
    /* the standalone transport is unused; ignore malformed input */
  }
}

// Requests can arrive through either transport; the VS Code one posts to the page.
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'grpc_request') handle(event.data)
})
