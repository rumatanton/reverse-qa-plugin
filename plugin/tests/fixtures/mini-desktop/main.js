// mini-desktop: one window, pages loaded from renderer/, notes kept in a JSON file in the app's data folder.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const UPDATE_URL = 'https://updates.example.test/mini-desktop/latest.json'; // read by renderer/about.html, never by a test
const notesFile = () => path.join(app.getPath('userData'), 'notes.json');
const readNotes = () => {
  try {
    return JSON.parse(fs.readFileSync(notesFile(), 'utf8'));
  } catch {
    return [];
  }
};

ipcMain.handle('notes:list', () => readNotes());
ipcMain.handle('notes:add', (_event, note) => {
  const notes = [...readNotes(), { id: Date.now(), owner: String(note.owner), text: String(note.text).slice(0, 200) }];
  fs.writeFileSync(notesFile(), JSON.stringify(notes));
  return notes;
});
ipcMain.handle('notes:clear', () => {
  fs.rmSync(notesFile(), { force: true });
  return [];
});
ipcMain.handle('app:update-url', () => UPDATE_URL);

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
