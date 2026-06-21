import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';

Menu.setApplicationMenu(null);

async function createWindow() {
  const dbPath = join(app.getPath('userData'), 'spotify-stats.sqlite');
  const { port } = await startServer({ host: '127.0.0.1', port: 0, dbPath });

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Spotify Lifetime Stats',
    autoHideMenuBar: true
  });

  await window.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
