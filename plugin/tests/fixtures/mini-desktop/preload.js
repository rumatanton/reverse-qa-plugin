// The only bridge between the pages and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  notes: () => ipcRenderer.invoke('notes:list'),
  addNote: (note) => ipcRenderer.invoke('notes:add', note),
  clearNotes: () => ipcRenderer.invoke('notes:clear'),
  updateUrl: () => ipcRenderer.invoke('app:update-url'),
});
