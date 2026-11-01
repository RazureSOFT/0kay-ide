const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')

/**
 * 0KAY IDE: Cline's own webview, hosted outside VS Code.
 *
 * The webview was written against a host that answers postMessage calls. Until
 * that host exists here, this window is the shell: it proves the UI renders and
 * gives us the frame to attach the bridge to.
 */
const UI = path.join(__dirname, '..', 'vscode', 'webview-ui', 'build', 'index.html')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: '0KAY IDE',
    backgroundColor: '#1f1f1f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  })
  // The page sets its own title ("Cline Webview"); the product is 0KAY IDE, and
  // the window title is what the taskbar and Alt-Tab show.
  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle('0KAY IDE')
  })
  // Renderer errors are invisible from outside; forward them so a blank window
  // says why it is blank instead of looking like a stylesheet problem.
  win.webContents.on('console-message', (_event, level, message) => {
    console.log('[renderer:' + level + ']', String(message).slice(0, 400))
  })
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.log('[load-failed]', code, description, url)
  })
  win.loadFile(UI)
  // Links inside the conversation belong in the browser, not in the IDE frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
