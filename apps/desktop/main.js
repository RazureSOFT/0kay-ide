const { app, BrowserWindow, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')

/**
 * 0KAY IDE: Cline's own webview, hosted outside VS Code.
 *
 * The webview was written against a host that answers postMessage calls. Until
 * that host exists here, this window is the shell: it proves the UI renders and
 * gives us the frame to attach the bridge to.
 */
// Cline's webview needs its host to answer proto requests before React mounts;
// until that is finished the window shows a real status surface rather than a
// blank frame. Set IDE_WEBVIEW=1 to load the webview build instead.
const WEBVIEW_DIR = path.join(__dirname, '..', 'vscode', 'webview-ui', 'build')
const useWebview = process.env.IDE_WEBVIEW === '1'
const UI = useWebview ? path.join(WEBVIEW_DIR, 'index.html') : path.join(__dirname, 'shell.html')

/**
 * Serve the webview build over HTTP.
 *
 * The bundle was built for a server: index.html references /assets/index.css and
 * /assets/index.js by absolute path. Under file:// those resolve to the disk
 * root, so neither the stylesheet nor the JS loads — React mounts into #root and
 * then lays out at zero width, which reads as a blank window.
 *
 * A loopback server also puts the page on http://, which is what its CSP expects.
 */
function serveBuild(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
  }
  const server = http.createServer((req, res) => {
    const requested = decodeURIComponent((req.url || '/').split('?')[0])
    const rel = requested === '/' ? '/index.html' : requested
    const clean = path.normalize(rel).split(path.sep).filter((part) => part !== '..' && part !== '.' && part !== '')
    const full = path.join(root, ...clean)
    if (!full.startsWith(root)) { res.writeHead(403).end(); return }
    fs.readFile(full, (error, data) => {
      if (error) {
        // A missing file is a client-router path; the shell handles it.
        fs.readFile(path.join(root, 'index.html'), (fallbackError, html) => {
          if (fallbackError) { res.writeHead(404).end(); return }
          res.writeHead(200, { 'Content-Type': types['.html'] }).end(html)
        })
        return
      }
      res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' }).end(data)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

let staticServer = null

async function createWindow() {
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
  if (useWebview) {
    staticServer = await serveBuild(WEBVIEW_DIR)
    win.loadURL('http://127.0.0.1:' + staticServer.port + '/')
  } else {
    win.loadFile(UI)
  }
  // A blank window is indistinguishable from a slow one without a picture.
  // Decide between "rendered but invisible" and "never mounted" before touching
  // any CSS again: the mount point's child count answers it in one run.
  if (process.env.IDE_DEBUG === '1') {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      try {
        const probe = await win.webContents.executeJavaScript(`(() => {
          const out = { bodyChildren: document.body.children.length, htmlLength: document.body.innerHTML.length }
          const ids = ['root','app','react-root']
          out.mounts = {}
          for (const id of ids) {
            const el = document.getElementById(id)
            if (!el) { out.mounts[id] = 'missing'; continue }
            const cs = getComputedStyle(el)
            out.mounts[id] = { children: el.children.length, display: cs.display, visibility: cs.visibility,
              opacity: cs.opacity, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }
          }
          out.rootHtml = (document.getElementById('root') || {}).innerHTML ? document.getElementById('root').innerHTML.slice(0, 600) : ''
          out.firstTags = Array.from(document.body.children).map((n) => n.tagName + '#' + (n.id || '') + '.' + (n.className || '').toString().slice(0,40))
          return JSON.stringify(out)
        })()`)
        console.log('[probe]', probe)
      } catch (error) {
        console.log('[probe] failed', error && error.message)
      }
    })
  }
  if (process.env.IDE_SHOT === '1') {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 6000))
      try {
        const image = await win.webContents.capturePage()
        require('node:fs').writeFileSync('D:/Cache/ide-shot.png', image.toPNG())
        console.log('[shot] written')
      } catch (error) {
        console.log('[shot] failed', error && error.message)
      }
    })
  }
  // Links inside the conversation belong in the browser, not in the IDE frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => { if (staticServer) staticServer.server.close() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
