const CORE = 'http://127.0.0.1:8080'
function set(id, state, text) {
  const dot = document.getElementById(id + '-dot')
  dot.className = 'dot' + (state ? ' ' + state : '')
  document.getElementById(id + '-val').textContent = text
}
async function check() {
  set('core', '', '检查中...')
  try {
    const health = await fetch(CORE + '/health')
    if (!health.ok) throw new Error('HTTP ' + health.status)
    set('core', 'on', '运行中')
  } catch (e) {
    set('core', 'off', '未启动')
    set('agent', 'off', '-')
    set('ws', 'off', '-')
    document.getElementById('open-web').disabled = true
    return
  }
  try {
    const res = await fetch(CORE + '/api/plugins')
    const plugins = await res.json()
    const agent = (plugins || []).find(function (p) { return p.name === 'agent' })
    if (agent) {
      set('agent', 'on', '已注册 ' + (agent.version || ''))
      document.getElementById('open-web').disabled = false
    } else {
      set('agent', 'off', '未注册')
    }
  } catch (e) { set('agent', 'off', '查询失败') }
  try {
    const res = await fetch(CORE + '/api/agent/workspace')
    const ws = await res.json()
    const path = ws && ws.path ? ws.path : ''
    set('ws', path ? 'on' : 'off', path || '未知')
  } catch (e) { set('ws', 'off', '未知') }
}
document.getElementById('recheck').addEventListener('click', check)
document.getElementById('open-web').addEventListener('click', function () {
  window.open(CORE + '/', '_blank')
})
check()
