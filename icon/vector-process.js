// 矢量图标渲染：SVG → 各尺寸 PNG（无限清晰）
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadFile(path.join(__dirname, 'vector.html'))
  const out = await win.webContents.executeJavaScript('window.renderVector()')
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    const file = path.join(__dirname, `icon-${size}.png`)
    fs.writeFileSync(file, Buffer.from(out[size].split(',')[1], 'base64'))
    console.log('写出', file, fs.statSync(file).size, 'bytes')
  }
  app.quit()
})
