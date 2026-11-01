/**
 * The host half of Cline's webview protocol.
 *
 * The webview talks to whatever embeds it through postMessage: it sends
 * `grpc_request` and waits for `grpc_response` carrying the decoded proto
 * message. In VS Code that host is the extension; here it is this file.
 *
 * What it answers today is deliberately shallow — state, auth and the two UI
 * notification streams — because those are what the UI needs before it will
 * paint at all. Anything else is logged and left unanswered, so the next gap
 * is visible in the log instead of being guessed at.
 */
const pending = new Map()
const listeners = []

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
  // setProperty per variable instead of injecting a <style> element: the webview
  // page has a CSP that rejects an inline sheet, and a rejected sheet's text was
  // being rendered as page content.
  const root = document.documentElement
  for (const [key, value] of Object.entries(THEME)) {
    root.style.setProperty('--' + key, value)
  }
  root.style.colorScheme = 'dark'
  if (document.body) {
    // The app reads these to pick a theme; VS Code sets them before load.
    document.body.classList.add('vscode-dark', 'vscode-high-contrast-off')
  }
}

applyTheme()
document.addEventListener('DOMContentLoaded', applyTheme, { once: true })

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

/**
 * The state the UI boots from.
 *
 * `version` and the empty task fields are enough for the chat shell to render;
 * everything optional is left out rather than faked, so a missing feature shows
 * as missing instead of as wrong data.
 */
const extensionState = {
  version: '0.1.4',
  clineMessages: [],
  taskHistory: [],
  shouldShowAnnouncement: false,
  isNewUser: false,
  autoApprovalSettings: { version: 1, enabled: false, actions: {}, favorites: [] },
  browserSettings: {},
  apiConfiguration: {},
  mode: 'act',
  platform: 'vscode',
  telemetrySetting: 'disabled',
}

/**
 * The State message is one JSON string, not a structure of fields:
 *   message State { string state_json = 1; }
 * Sending the object directly is why the UI stayed blank — the client parses
 * state_json, found nothing, and never got an initial state to render from.
 */
const initialState = { state_json: JSON.stringify(extensionState) }

const host = {
  'cline.StateService': (method) => {
    if (method === 'subscribeToState' || method === 'getState' || method === 'getLatestState') {
      return { kind: 'once', message: initialState }
    }
    if (method === 'subscribeToWorkspaceState') {
      return { kind: 'once', message: {} }
    }
    if (method === 'getAvailableTerminalProfiles') {
      // No integrated terminal here, so the list is empty rather than invented.
      return { kind: 'once', message: { profiles: [] } }
    }
    return null
  },
  'cline.AccountService': (method) => {
    if (method === 'subscribeToAuthStatusUpdate' || method === 'getAuthStatus') {
      // No cloud account: the IDE runs against the local agent.
      return { kind: 'once', message: { authenticated: false, provider: '0kay-agent' } }
    }
    return null
  },
  'cline.UiService': (method) => {
    if (method === 'initializeWebview') return { kind: 'once', message: { success: true } }
    // Pure notification streams (menu clicks); an empty first frame completes
    // them without pretending something was clicked.
    if (method.startsWith('subscribeTo')) return { kind: 'once', message: {} }
    return null
  },
}

host['cline.McpService'] = (method) => {
  if (method.startsWith('subscribeTo')) return { kind: 'once', message: { mcpServers: [] } }
  return null
}

host['cline.ModelsService'] = (method) => {
  // Model catalogues come from Core, not from Cline's cloud. Advertising none
  // keeps the picker empty instead of offering models that cannot answer.
  if (method.startsWith('subscribeTo')) return { kind: 'once', message: { models: [] } }
  return null
}

// A blank frame is a crash somewhere we cannot see. These two listeners turn
// "nothing rendered" into a line pointing at the file and line that threw.
window.addEventListener('error', (event) => {
  console.log('[page-error]', event.message, (event.filename || '') + ':' + event.lineno + ':' + event.colno)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason
  console.log('[page-rejection]', reason && (reason.stack || reason.message) || String(reason))
})

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

function handle(message) {
  if (!message || message.type !== 'grpc_request') {
    if (message && message.type) console.log('[0kay-ide] unhandled', message.type)
    return
  }
  const request = message.grpc_request || {}
  const service = host[request.service]
  const answer = service ? service(String(request.method || '')) : null

  if (!answer) {
    console.log('[0kay-ide] no answer for', request.service + '.' + request.method)
    // An error frame completes the caller; a null message made the client log
    // "no response or error" and left the promise pending.
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
  respond(request, answer.message, answer.kind === 'stream')
}

// Requests arrive through either transport; the VS Code one posts to the page.
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'grpc_request') handle(event.data)
})

void pending
void listeners
