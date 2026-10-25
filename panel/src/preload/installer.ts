// Preload of MLX Harness's install window (sandboxed, nothing but this bridge):
// the page shows what main sends and reports which button was pressed.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('installer', {
  act: (action: string): void => ipcRenderer.send('installer:act', String(action)),
  onScreen: (cb: (screen: unknown) => void): void => {
    ipcRenderer.on('installer:screen', (_e, screen) => cb(screen))
  },
  ready: (): void => ipcRenderer.send('installer:ready'),
})
