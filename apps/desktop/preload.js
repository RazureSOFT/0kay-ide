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
const initialState = {
  version: '0kay-ide',
  clineMessages: [],
  currentTaskItem: undefined,
  shouldShowAnnouncement: false,
  autoApprovalSettings: { version: 1, actions: {}, favorites: [] },
  browserSettings: {},
  apiConfiguration: {},
  mcpMarketplaceEnabled: false,
  isNewUser: false,
}

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
