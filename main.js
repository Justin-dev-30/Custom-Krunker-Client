require('v8-compile-cache');
const { BrowserWindow, app, shell, Menu, ipcMain, net } = require('electron');
const shortcut = require('electron-localshortcut');
const consts = require('./constants.js');
const url = require('url');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const config = new Store();
const log = require('electron-log');
const fs = require('fs');
const DiscordRPC = require('discord-rpc');
const path = require("path")

let rpc = null;
let gameWindow = null,
	editorWindow = null,
	socialWindow = null,
	viewerWindow = null,
	splashWindow = null,
	promptWindow = null,
	current = 0;

const autoUpdateType = (/^(download|check|skip)$/.exec(consts.AUTO_UPDATE_TYPE || config.get("utilities_autoUpdateType")) || {input: "download"}).input
consts.DEBUG = consts.DEBUG || config.get("utilities_debugMode")	

const initLogging = () => {
	log.debug("-------------------- Client Start --------------------");

	console.log = log.info;
	console.info = log.info;
	console.warn = log.warn;
	console.error = log.error;
	console.debug = log.debug;

	process.on('uncaughtException', (error) => {
		if (error) console.error(error);
	});
};
initLogging();

const initSwitches = () => {
	// Usefull info
	// https://forum.manjaro.org/t/howto-google-chrome-tweaks-for-76-0-3809-100-or-newer-20190817/39946
	if (config.get('utilities_unlimitedFrames', true)) {
		if (consts.isAMDCPU) app.commandLine.appendSwitch('enable-zero-copy');
		app.commandLine.appendSwitch('disable-frame-rate-limit');
	}
	app.commandLine.appendSwitch('enable-quic');
	app.commandLine.appendSwitch('high-dpi-support',1);
	app.commandLine.appendSwitch('ignore-gpu-blacklist');
	if (config.get('utilities_d3d9Mode', false)) {
		app.commandLine.appendSwitch('use-angle', 'd3d9');
		app.commandLine.appendSwitch('enable-webgl2-compute-context');
		app.commandLine.appendSwitch('renderer-process-limit', 100);
		app.commandLine.appendSwitch('max-active-webgl-contexts', 100);
	}

};
initSwitches();

const initAppMenu = () => {
	if (process.platform == 'darwin') {
		const template = [{
			label: "Application",
			submenu: [
				{ label: "About Application", selector: "orderFrontStandardAboutPanel:" },
				{ type: "separator" },
				{ label: "Quit", accelerator: "Command+Q", click: _ => app.quit() }
			]
		}, {
			label: "Edit",
			submenu: [
				{ label: "Undo", accelerator: "CmdOrCtrl+Z", selector: "undo:" },
				{ label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", selector: "redo:" },
				{ type: "separator" },
				{ label: "Cut", accelerator: "CmdOrCtrl+X", selector: "cut:" },
				{ label: "Copy", accelerator: "CmdOrCtrl+C", selector: "copy:" },
				{ label: "Paste", accelerator: "CmdOrCtrl+V", selector: "paste:" },
				{ label: "Select All", accelerator: "CmdOrCtrl+A", selector: "selectAll:" }
			]
		}];
		Menu.setApplicationMenu(Menu.buildFromTemplate(template));
	}
};
initAppMenu();

const initDiscordRPC = () => {
	DiscordRPC.register(consts.DISCORD_ID);
	rpc = new DiscordRPC.Client({ transport: 'ipc' });
	rpc.isConnected = false;

	rpc.on('error', console.error);

	if (!config.get("utilities_disableDiscordRPC")) {
		rpc.login({ 'clientId': consts.DISCORD_ID })
		.then(() => {
			rpc.isConnected = true;
			rpc.setActivity2 = function(win, obj) {
				if (current == win) rpc.setActivity(obj);
			};
			rpc.on('RPC_MESSAGE_RECEIVED', (event) => {
				//console.log('RPC_MESSAGE_RECEIVED', event);
				if (!gameWindow) return;
				gameWindow.webContents.send('log', ['RPC_MESSAGE_RECEIVED', event]);
			});
			rpc.subscribe('ACTIVITY_JOIN', ({ secret }) => {
				if (!gameWindow) return;
				let parse = secret.split('|');
				if (parse[2].isCode()) {
					gameWindow.loadURL('https://' + parse[0] + '/?game=' + parse[2]);
				}
			});
			rpc.subscribe('ACTIVITY_INVITE', (event) => {
				if (!gameWindow) return;
				gameWindow.webContents.send('ACTIVITY_INVITE', event);
			});
				rpc.subscribe('ACTIVITY_JOIN_REQUEST', (user) => {
				if (!gameWindow) return;
				gameWindow.webContents.send('ACTIVITY_JOIN_REQUEST', user);
			});
		})
		.catch(console.error);
	}
};
initDiscordRPC();

const initGameWindow = () => {
	gameWindow = new BrowserWindow({
		width: 1600,
		height: 900,
		show: false,
		darkTheme: true,
		center: true,
		webPreferences: {
			nodeIntegration: false,
			webSecurity: false,
			preload: consts.joinPath(__dirname, 'preload.js')
		}
	});
	gameWindow.setMenu(null);
	gameWindow.rpc = rpc;

	let swapFolder = consts.joinPath(app.getPath('documents'), '/KrunkerResourceSwapper');
	try {fs.mkdir(swapFolder, { recursive: true }, e => {});}catch(e){};
	let swap = { filter: { urls: [] }, files: {} };
	const allFilesSync = (dir, fileList = []) => {
		fs.readdirSync(dir).forEach(file => {
			const filePath = consts.joinPath(dir, file);
			if (fs.statSync(filePath).isDirectory()) {
				if (!(/\\(docs)$/.test(filePath)))
					allFilesSync(filePath);
			} else {
				if (!(/\.(html|js)/g.test(file))) {
					let krunk = `*://krunker.io${filePath.replace(swapFolder, '').replace(/\\/g, '/')}*`
					swap.filter.urls.push(krunk, krunk.replace("://", "://beta."));
					swap.files[krunk.replace(/\*/g, '')] = url.format({
						pathname: filePath,
						protocol: 'file:',
						slashes: true
					});
				}
			}
		});
	};
	if (!config.get("utilities_disableResourceSwapper", false)) allFilesSync(swapFolder);
	if (swap.filter.urls.length) {
		gameWindow.webContents.session.webRequest.onBeforeRequest(swap.filter, (details, callback) => {
			callback({ cancel: false, redirectURL: swap.files[details.url.replace(/https|http|(\?.*)|(#.*)|(?<=:\/\/)beta./gi, '')] || details.url });
		});
	}

	// Resource Dumper
	if (config.get("utilities_dumpResources", false)) {
		let dumpedURLs = []
		gameWindow.webContents.session.webRequest.onCompleted(details => {
			if (details.statusCode == 200 && /^http(s?):\/\/(beta\.)?krunker.io\/*/.test(details.url) && !dumpedURLs.includes(details.url)) {
				dumpedURLs.push(details.url)
				const request = net.request(details.url)
				let raw = ""
				request.on("response", res => {
					if (res.statusCode == 200) {
						res.setEncoding("binary")
						res.on("data", chunk => raw += chunk)
						res.on("end", () => {
							let target = new url.URL(details.url)
							if (!fs.existsSync(path.join(config.get("utilities_dumpPath", ""), target.hostname, path.dirname(target.pathname)))) fs.mkdirSync(path.join(config.get("utilities_dumpPath", ""), target.hostname, path.dirname(target.pathname)), { recursive: true })
							fs.writeFileSync(path.join(config.get("utilities_dumpPath", ""), target.hostname, target.pathname == "/" ? "index.html" : target.pathname), raw, "binary")
						})
					}
				})
				request.end()
			}
		})
	}

	gameWindow.loadURL(`https://${config.get("utilities_betaServer", false) ? "beta." : ""}krunker.io`);

	let nav = (e, url) => {
		e.preventDefault();
		if (url.isKrunker()) {
			if (url.isEditor()) {
				if (!editorWindow) initEditorWindow();
				else editorWindow.loadURL(url);
			} else if (url.isSocial()) {
				if (!socialWindow) initSocialWindow(url);
				else socialWindow.loadURL(url);
			} else if (url.isViewer()) {
				if (!viewerWindow) initViewerWindow(url);
				else viewerWindow.loadURL(url);
			} else gameWindow.loadURL(url);
		} else shell.openExternal(url);
	};

	gameWindow.webContents.on('new-window', nav);
	gameWindow.webContents.on('will-navigate', nav);

	gameWindow.once('ready-to-show', () => {
		if (consts.DEBUG) gameWindow.webContents.openDevTools({ mode: 'undocked' });
		if (config.get('fullscreen', false)) gameWindow.setFullScreen(true);
		splashWindow.destroy();
		gameWindow.show();
	});

	gameWindow.on('focus', () => {
		current = 0;
	});

	gameWindow.once('closed', () => {
		gameWindow = null;
	});

	initShortcuts();
};

const initEditorWindow = () => {
	let size = gameWindow.getSize()
	editorWindow = new BrowserWindow({
		width: size[0] * consts.windowResize.editor,
		height: size[1] * consts.windowResize.editor,
		show: false,
		darkTheme: true,
		center: true,
		parent: gameWindow,
		webPreferences: {
			nodeIntegration: false,
			webSecurity: false,
			preload: consts.joinPath(__dirname, 'preload.js')
		}
	});

	editorWindow.setMenu(null);
	editorWindow.rpc = rpc;

	editorWindow.loadURL(`https://${config.get("utilities_betaServer", false) ? "beta." : ""}krunker.io/editor.html`);

	let nav = (e, url) => {
		e.preventDefault();
		if (url.isKrunker() && !url.isEditor()) {
			gameWindow.loadURL(url);
		}
	}

	editorWindow.webContents.on('new-window', nav);
	editorWindow.webContents.on('will-navigate', nav);

	editorWindow.once('ready-to-show', () => {
		if (consts.DEBUG) editorWindow.webContents.openDevTools({ mode: 'undocked' });
		editorWindow.show();
	});

	editorWindow.on('focus', () => {
		current = 1;
	});

	editorWindow.once('closed', () => {
		editorWindow = null;
	});
};

const initSocialWindow = (url) => {
	let size = gameWindow.getSize()
	socialWindow = new BrowserWindow({
		width: size[0] * consts.windowResize.social,
		height: size[1] * consts.windowResize.social,
		show: false,
		darkTheme: true,
		center: true,
		parent: gameWindow,
		webPreferences: {
			nodeIntegration: false,
			webSecurity: false,
			preload: consts.joinPath(__dirname, 'preload.js')
		}
	});

	socialWindow.setMenu(null);
	socialWindow.rpc = rpc;

	socialWindow.loadURL(url);

	let nav = (e, url) => {
		e.preventDefault();
		if (url.isKrunker()) {
			if (url.isEditor()) {
				if (!editorWindow) initEditorWindow();
				else editorWindow.loadURL(url);
			} else if (url.isSocial()) {
				socialWindow.loadURL(url);
			} else if (url.isViewer()) {
				if (!viewerWindow) initViewerWindow(url);
				else viewerWindow.loadURL(url);
			} else gameWindow.loadURL(url);
		}
	}

	socialWindow.webContents.on('new-window', nav);
	socialWindow.webContents.on('will-navigate', nav);

	socialWindow.once('ready-to-show', () => {
		if (consts.DEBUG) socialWindow.webContents.openDevTools({ mode: 'undocked' });
		socialWindow.show();
	});

	socialWindow.on('focus', () => {
		current = 2;
	});

	socialWindow.once('closed', () => {
		socialWindow = null;
	});
};

const initViewerWindow = (url) => {
	let size = gameWindow.getSize()
	viewerWindow = new BrowserWindow({
		width: size[0] * consts.windowResize.viewer,
		height: size[1] * consts.windowResize.viewer,
		show: false,
		darkTheme: true,
		center: true,
		parent: gameWindow,
		webPreferences: {
			nodeIntegration: false,
			webSecurity: false,
			preload: consts.joinPath(__dirname, 'preload.js')
		}
	});

	viewerWindow.setMenu(null);
	viewerWindow.rpc = rpc;

	viewerWindow.loadURL(url);

	let nav = (e, url) => {
		e.preventDefault();
		if (url.isKrunker()) {
			if (url.isEditor()) {
				if (!editorWindow) initEditorWindow();
				else editorWindow.loadURL(url);
			} else if (url.isSocial()) {
				if (!socialWindow) initSocialWindow(url);
				else socialWindow.loadURL(url);
			} else if (url.isViewer()) {
				viewerWindow.loadURL(url);
			} else gameWindow.loadURL(url);
		}
	}

	viewerWindow.webContents.on('new-window', nav);
	viewerWindow.webContents.on('will-navigate', nav);

	viewerWindow.once('ready-to-show', () => {
		if (consts.DEBUG) viewerWindow.webContents.openDevTools({ mode: 'undocked' });
		viewerWindow.show();
	});

	viewerWindow.on('focus', () => {
		current = 3;
	});

	viewerWindow.once('closed', () => {
		viewerWindow = null;
	});
};

const initSplashWindow = () => {
	splashWindow = new BrowserWindow({
		width: 650,
		height: 370,
		transparent: true,
		frame: false,
		// skipTaskbar: true, // Enabled by default
		center: true,
		resizable: false,
		webPreferences: {
			nodeIntegration: true
		}
	});
	splashWindow.setMenu(null);
	// splashWindow.loadFile(consts.joinPath(__dirname, 'splash.html'));
	splashWindow.loadURL(url.format({
		pathname: consts.joinPath(__dirname, 'splash.html'),
		protocol: 'file:',
		slashes: true
	}));
	splashWindow.webContents.once('did-finish-load', () => initUpdater());
	if (consts.DEBUG) splashWindow.webContents.openDevTools({ mode: 'undocked' }); // Disabled by default
};

const initPromptWindow = () => {
	let response;

	ipcMain.on('prompt', (event, opt) => {
		response = null;

		promptWindow = new BrowserWindow({
			width: 300,
			height: 157,
			show: false,
			frame: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			resizable: false,
			movable: false,
			darkTheme: true,
			center: true,
			webPreferences: {
				nodeIntegration: true
			}
		});

		promptWindow.loadURL(url.format({
			pathname: consts.joinPath(__dirname, 'prompt.html'),
			protocol: 'file:',
			slashes: true
		}));
		if (consts.DEBUG) promptWindow.webContents.openDevTools({ mode: 'undocked' });

		promptWindow.webContents.on('did-finish-load', () => {
			promptWindow.show();
			promptWindow.webContents.send('text', JSON.stringify(opt));
		});

		promptWindow.on('closed', () => {
			event.returnValue = response;
			promptWindow = null;
		})

	});
	ipcMain.on('prompt-response', (event, args) => {
		response = args === '' ? null : args;
	});
};
initPromptWindow();

const initUpdater = () => {
	if (consts.DEBUG || process.platform == 'darwin' || autoUpdateType == "skip") return initGameWindow();
	let updateCheckFallback = null;
	autoUpdater.on('checking-for-update', (info) => {
		splashWindow.webContents.send('checking-for-update');
		updateCheckFallback = setTimeout(function() { 
			splashWindow.webContents.send('update-not-available', info);
			setTimeout(() => initGameWindow(), 1000);
		}, 15000);
	});

	autoUpdater.on('error', (err) => {
		if (updateCheckFallback) clearTimeout(updateCheckFallback);
		splashWindow.webContents.send('update-error', err);
		setTimeout(() => initGameWindow(), 1000);
		//app.quit();
	});

	autoUpdater.on('download-progress', (info) => {
		if (updateCheckFallback) clearTimeout(updateCheckFallback);
		splashWindow.webContents.send('download-progress', info);
	});

	autoUpdater.on('update-available', (info) => {
		if (updateCheckFallback) clearTimeout(updateCheckFallback);
		splashWindow.webContents.send('update-available', info);
		if (autoUpdateType == "check") setTimeout(() => initGameWindow(), 1000);
	});

	autoUpdater.on('update-not-available', (info) => {
		if (updateCheckFallback) clearTimeout(updateCheckFallback);
		splashWindow.webContents.send('update-not-available', info);
		setTimeout(() => initGameWindow(), 1000);
	});

	autoUpdater.on('update-downloaded', (info) => {
		if (updateCheckFallback) clearTimeout(updateCheckFallback);
		splashWindow.webContents.send('update-downloaded', info);
		setTimeout(() => autoUpdater.quitAndInstall(), 2500);
	});
	autoUpdater.channel = "latest";
	autoUpdater.autoDownload = autoUpdateType == "download"
	autoUpdater.checkForUpdates();
}

const initShortcuts = () => {
	const KEY_BINDS = {
		escape: {
			key: 'Esc',
			press: _ => gameWindow.webContents.send('esc')
		},
		quit: {
			key: 'Alt+F4',
			press: _ => app.quit()
		},
		refresh: {
			key: 'F5',
			press: _ => gameWindow.webContents.reloadIgnoringCache()
		},
		fullscreen: {
			key: 'F11',
			press: _ => {
				let full = !gameWindow.isFullScreen();
				gameWindow.setFullScreen(full);
				config.set("fullscreen", full);
			}
		},
		clearConfig: {
			key: 'Ctrl+F1',
			press: _ => {
				config.store = {};
				app.relaunch();
				app.quit();
			}
		},
		openConfig: {
			key: 'Shift+F1',
			press: _ => config.openInEditor(),
		},
		toggleDevTools: {
			key: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
			press: () => gameWindow.toggleDevTools()
		}
	}
	Object.keys(KEY_BINDS).forEach(k => {
		shortcut.register(gameWindow, KEY_BINDS[k].key, () => KEY_BINDS[k].press());
	});
};

['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGBREAK'].forEach((signal) => {
  process.on(signal, _ => {
	app.quit()
  })
});

app.once('ready', () => initSplashWindow());
app.on('activate', () => {
	if (gameWindow === null && (splashWindow === null || splashWindow.isDestroyed())) initSplashWindow();
});
app.once('before-quit', () => {
	rpc.destroy().catch(console.error);
	shortcut.unregisterAll();
	gameWindow.close();
});
app.on('window-all-closed', () => app.quit());
app.on('quit', () => app.quit());