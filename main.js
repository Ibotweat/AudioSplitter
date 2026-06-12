const { app, BrowserWindow, ipcMain, desktopCapturer, Menu, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

let startMeasure = cpuAverage();

function cpuAverage() {
  const cpus = os.cpus();
  let idleMs = 0;
  let totalMs = 0;

  cpus.forEach((core) => {
    for (const type in core.times) {
      totalMs += core.times[type];
    }
    idleMs += core.times.idle;
  });

  return { idle: idleMs / cpus.length, total: totalMs / cpus.length };
}

ipcMain.handle('get-cpu-usage', async () => {
  const endMeasure = cpuAverage();
  const idleDifference = endMeasure.idle - startMeasure.idle;
  const totalDifference = endMeasure.total - startMeasure.total;
  
  let percentageCPU = 0;
  if (totalDifference > 0) {
    percentageCPU = 100 - Math.round((100 * idleDifference) / totalDifference);
  }
  
  startMeasure = endMeasure;
  return percentageCPU;
});

ipcMain.handle('get-sources', async () => {
  return await desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false });
});

// Helper to run PowerShell commands
const runPowerShell = (command) => {
    return new Promise((resolve, reject) => {
        exec(`powershell -ExecutionPolicy Bypass -Command "${command}"`, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout.trim());
        });
    });
};



ipcMain.handle('install-driver', async () => {
    const installerPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'drivers', 'VBCABLE_Setup_x64.exe');
    console.log(`Lancement de l'installateur: ${installerPath}`);
    
    // Check if file exists first (to avoid crash)
    const fs = require('fs');
    if (!fs.existsSync(installerPath)) {
        return { success: false, error: "L'installateur n'est pas présent dans le dossier 'drivers/'." };
    }

    return new Promise((resolve) => {
        // Use PowerShell to request elevation (UAC prompt)
        const psCommand = `Start-Process -FilePath "${installerPath}" -ArgumentList "/S" -Verb RunAs -Wait`;
        exec(`powershell -Command "${psCommand}"`, (error) => {
            if (error) {
                console.error('Erreur elevation:', error);
                // Fallback: Just try to run normally if PS fails
                exec(`"${installerPath}"`, (err2) => {
                    if (err2) resolve({ success: false, error: err2.message });
                    else resolve({ success: true });
                });
            } else {
                resolve({ success: true });
            }
        });
    });
});

ipcMain.handle('uninstall-driver', async () => {
    const installerPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'drivers', 'VBCABLE_Setup_x64.exe');
    console.log(`Lancement du désinstallateur: ${installerPath}`);
    
    const fs = require('fs');
    if (!fs.existsSync(installerPath)) {
        return { success: false, error: "L'installateur n'est pas présent dans le dossier 'drivers/'." };
    }

    return new Promise((resolve) => {
        // Run without /S so it is interactive and allows removing the driver
        const psCommand = `Start-Process -FilePath "${installerPath}" -Verb RunAs -Wait`;
        exec(`powershell -Command "${psCommand}"`, (error) => {
            if (error) {
                console.error('Erreur elevation:', error);
                exec(`"${installerPath}"`, (err2) => {
                    if (err2) resolve({ success: false, error: err2.message });
                    else resolve({ success: true });
                });
            } else {
                resolve({ success: true });
            }
        });
    });
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false, // For simpler audio access in renderer
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f13',
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();

  // Create Application Menu
  const menuTemplate = [
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Charger une configuration...',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow.webContents.send('load-config-trigger');
          }
        },
        {
          label: 'Exporter la configuration...',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow.webContents.send('export-config-trigger');
          }
        },
        { type: 'separator' },
        {
          label: 'Quitter',
          role: 'quit'
        }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Actualiser' },
        { role: 'forceReload', label: 'Actualiser de force' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Réinitialiser le zoom' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('save-config-file', async (event, dataString) => {
    const { filePath } = await dialog.showSaveDialog({
        title: 'Exporter la configuration',
        defaultPath: 'config-audiosplitter.json',
        filters: [{ name: 'Fichiers JSON', extensions: ['json'] }]
    });
    if (filePath) {
        fs.writeFileSync(filePath, dataString, 'utf-8');
        return { success: true, filePath };
    }
    return { success: false };
});

ipcMain.handle('load-config-file', async () => {
    const { filePaths } = await dialog.showOpenDialog({
        title: 'Importer la configuration',
        filters: [{ name: 'Fichiers JSON', extensions: ['json'] }],
        properties: ['openFile']
    });
    if (filePaths && filePaths.length > 0) {
        const content = fs.readFileSync(filePaths[0], 'utf-8');
        return { success: true, content, filePath: filePaths[0] };
    }
    return { success: false };
});

ipcMain.handle('install-extension', async (event, filePath) => {
    const extDir = path.join(app.getPath('userData'), 'extensions');
    if (!fs.existsSync(extDir)) {
        fs.mkdirSync(extDir, { recursive: true });
    }

    const tempFolderName = 'ext_' + Date.now();
    const extractPath = path.join(extDir, tempFolderName);
    fs.mkdirSync(extractPath);

    const yauzl = require('yauzl');

    return new Promise((resolve) => {
        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                console.error('yauzl open error:', err);
                try { fs.rmSync(extractPath, { recursive: true }); } catch(e){}
                resolve({ success: false, error: "Impossible d'ouvrir l'archive .aspack. Assurez-vous qu'il s'agit d'un fichier ZIP valide." });
                return;
            }

            const entries = [];
            zipfile.readEntry();

            zipfile.on('entry', (entry) => {
                entries.push(entry);
                zipfile.readEntry();
            });

            zipfile.on('error', (err2) => {
                console.error('yauzl entry error:', err2);
                try { fs.rmSync(extractPath, { recursive: true }); } catch(e){}
                resolve({ success: false, error: "Erreur lors de la lecture de l'archive .aspack." });
            });

            zipfile.on('end', () => {
                let pending = entries.length;
                if (pending === 0) {
                    finalize();
                    return;
                }

                // Re-open to read streams (lazyEntries doesn't keep streams open)
                yauzl.open(filePath, { lazyEntries: true }, (err2, zf2) => {
                    if (err2) {
                        resolve({ success: false, error: "Erreur de lecture du ZIP." });
                        return;
                    }
                    zf2.readEntry();
                    zf2.on('entry', (entry) => {
                        // Skip directories
                        if (/\/$/.test(entry.fileName)) {
                            // Directory entry — create it
                            const dirPath = path.join(extractPath, entry.fileName);
                            fs.mkdirSync(dirPath, { recursive: true });
                            pending--;
                            if (pending === 0) { zf2.close(); finalize(); }
                            zf2.readEntry();
                            return;
                        }
                        zf2.openReadStream(entry, (err3, readStream) => {
                            if (err3) {
                                pending--;
                                if (pending === 0) { zf2.close(); finalize(); }
                                zf2.readEntry();
                                return;
                            }
                            // Flatten: strip any leading folder prefix (e.g. theme-neon-glow/theme.css → theme.css)
                            const baseName = path.basename(entry.fileName);
                            const destPath = path.join(extractPath, baseName);
                            const writeStream = fs.createWriteStream(destPath);
                            readStream.pipe(writeStream);
                            writeStream.on('close', () => {
                                pending--;
                                if (pending === 0) { zf2.close(); finalize(); }
                            });
                            zf2.readEntry();
                        });
                    });
                });
            });
        });

        function finalize() {
            try {
                const manifestPath = path.join(extractPath, 'aspack.json');
                if (!fs.existsSync(manifestPath)) {
                    try { fs.rmSync(extractPath, { recursive: true }); } catch(e){}
                    resolve({ success: false, error: "Fichier de configuration 'aspack.json' manquant dans l'extension." });
                    return;
                }

                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

                if (!manifest.nom || !manifest.version || !manifest.type) {
                    throw new Error("Caractéristiques incomplètes dans aspack.json (nom, version, type requis).");
                }

                const cleanSlug = manifest.nom.toLowerCase().replace(/[^a-z0-9]/g, '_');
                const finalPath = path.join(extDir, cleanSlug);
                if (fs.existsSync(finalPath)) {
                    fs.rmSync(finalPath, { recursive: true });
                }
                fs.renameSync(extractPath, finalPath);

                let extData = {
                    nom:     manifest.nom,
                    version: manifest.version,
                    type:    manifest.type,
                    slug:    cleanSlug
                };

                if (manifest.type === 'theme') {
                    const cssFile = path.join(finalPath, 'theme.css');
                    if (fs.existsSync(cssFile)) {
                        extData.cssContent = fs.readFileSync(cssFile, 'utf-8');
                    } else {
                        throw new Error("Fichier theme.css manquant pour l'extension de type theme.");
                    }
                } else if (manifest.type === 'audio_effect') {
                    const jsFile = path.join(finalPath, 'effect.js');
                    if (fs.existsSync(jsFile)) {
                        extData.jsContent = fs.readFileSync(jsFile, 'utf-8');
                    } else {
                        throw new Error("Fichier effect.js manquant pour l'extension de type audio_effect.");
                    }
                }

                resolve({ success: true, extension: extData });
            } catch(err) {
                console.error('Manifest processing error:', err);
                try { fs.rmSync(extractPath, { recursive: true }); } catch(e){}
                resolve({ success: false, error: err.message });
            }
        }
    });

});

ipcMain.handle('load-extensions', async () => {
    const extDir = path.join(app.getPath('userData'), 'extensions');
    if (!fs.existsSync(extDir)) return [];

    const list = [];
    const folders = fs.readdirSync(extDir);
    for (const folder of folders) {
        const finalPath = path.join(extDir, folder);
        if (!fs.statSync(finalPath).isDirectory()) continue;

        const manifestPath = path.join(finalPath, 'aspack.json');
        if (fs.existsSync(manifestPath)) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                let extData = {
                    nom: manifest.nom,
                    version: manifest.version,
                    type: manifest.type,
                    slug: folder
                };
                if (manifest.type === 'theme') {
                    const cssFile = path.join(finalPath, 'theme.css');
                    if (fs.existsSync(cssFile)) {
                        extData.cssContent = fs.readFileSync(cssFile, 'utf-8');
                    }
                } else if (manifest.type === 'audio_effect') {
                    const jsFile = path.join(finalPath, 'effect.js');
                    if (fs.existsSync(jsFile)) {
                        extData.jsContent = fs.readFileSync(jsFile, 'utf-8');
                    }
                }
                list.push(extData);
            } catch(e) {
                console.error(`Error loading extension in ${folder}:`, e);
            }
        }
    }
    return list;
});

// ─── Delete a single installed extension ───────────────────────────────────
ipcMain.handle('delete-extension', async (event, slug) => {
    try {
        const extDir = path.join(app.getPath('userData'), 'extensions');
        const targetPath = path.join(extDir, slug);
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
            return { success: true };
        }
        return { success: false, error: 'Extension introuvable.' };
    } catch(err) {
        return { success: false, error: err.message };
    }
});

// ─── Get current app version ────────────────────────────────────────────────
ipcMain.handle('get-app-version', () => {
    const pkgPath = path.join(__dirname, 'package.json');
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
    } catch(e) {
        return '0.0.0';
    }
});

// ─── Check GitHub for latest release ────────────────────────────────────────
ipcMain.handle('check-for-update', async () => {
    const GITHUB_REPO = 'Ibotweat/AudioSplitter';
    const https = require('https');
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/releases/latest`,
            method: 'GET',
            headers: { 'User-Agent': 'AudioSplitter-App' }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        success: true,
                        latestVersion: json.tag_name ? json.tag_name.replace(/^v/, '') : null,
                        releaseUrl: json.html_url || null,
                        downloadUrl: (json.assets || []).find(a => a.name.endsWith('.exe'))?.browser_download_url || null
                    });
                } catch(e) {
                    resolve({ success: false, error: 'Impossible de lire la réponse GitHub.' });
                }
            });
        });
        req.on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
        req.setTimeout(8000, () => {
            req.destroy();
            resolve({ success: false, error: 'Timeout.' });
        });
        req.end();
    });
});

// ─── Download and launch latest release installer ────────────────────────────
ipcMain.handle('download-and-install-update', async (event, downloadUrl) => {
    const https = require('https');
    const os = require('os');
    const tmpPath = path.join(os.tmpdir(), 'AudioSplitter-Update.exe');

    return new Promise((resolve) => {
        const file = fs.createWriteStream(tmpPath);
        const request = https.get(downloadUrl, { headers: { 'User-Agent': 'AudioSplitter-App' } }, (response) => {
            // Handle redirects
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectReq = https.get(response.headers.location, { headers: { 'User-Agent': 'AudioSplitter-App' } }, (res2) => {
                    res2.pipe(file);
                    file.on('finish', () => {
                        file.close(() => {
                            exec(`"${tmpPath}"`, (err) => {
                                if (err) resolve({ success: false, error: err.message });
                                else resolve({ success: true });
                            });
                        });
                    });
                });
                redirectReq.on('error', (err) => resolve({ success: false, error: err.message }));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    const psCommand = `Start-Process -FilePath "${tmpPath}" -Verb RunAs`;
                    exec(`powershell -Command "${psCommand}"`, (err) => {
                        if (err) resolve({ success: false, error: err.message });
                        else resolve({ success: true });
                    });
                });
            });
        });
        request.on('error', (err) => {
            fs.unlink(tmpPath, () => {});
            resolve({ success: false, error: err.message });
        });
    });
});
