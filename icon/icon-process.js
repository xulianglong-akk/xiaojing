// 图标处理入口：隐藏窗口加载 process.html，拿 dataURL 后写文件
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false })
  await win.loadFile(path.join(__dirname, 'process.html'))
  const out = await win.webContents.executeJavaScript('window.processIcon()')
  console.log('裁剪区域', out.crop)
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    const b64 = out[size].split(',')[1]
    const file = path.join(__dirname, `icon-${size}.png`)
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    console.log('写出', file, fs.statSync(file).size, 'bytes')
  }
  app.quit()
})
