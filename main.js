const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let mainWindow;
let tray;

const SERVER_URL = process.env.NEXUS_URL || 'http://localhost:3000';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Chat-Nexus',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0a0e17',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    },
    titleBarStyle: 'hidden',
    frame: process.platform !== 'darwin',
    autoHideMenuBar: true,
  });

  mainWindow.loadURL(SERVER_URL);

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // System tray
  try {
    tray = new Tray(nativeImage.createEmpty());
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open Chat-Nexus', click: () => mainWindow.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('Chat-Nexus');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow.show());
  } catch (e) {
    // Tray may fail on some systems
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
