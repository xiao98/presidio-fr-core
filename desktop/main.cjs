// presidio-fr desktop: tray app that runs the gateway (src/cli.mjs) as a child process using Electron's
// own Node (ELECTRON_RUN_AS_NODE), and shows the control panel served by the gateway in a window.
// No renderer code of its own: the window simply loads http://127.0.0.1:<port>/.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.PFR_PORT || 8787);
const locale = () => { const l = (app.getLocale() || "fr").toLowerCase(); return l.startsWith("fr") ? "fr" : l.startsWith("zh") ? "zh" : "en"; };
const STR = {
  fr: { open: "Ouvrir le panneau", start: "Lancer au démarrage", quit: "Quitter", status: "Passerelle", running: "en service", starting: "démarrage…", stopped: "arrêtée", failed: "La passerelle n'a pas pu démarrer", site: "Site et documentation" },
  en: { open: "Open panel", start: "Start at login", quit: "Quit", status: "Gateway", running: "running", starting: "starting…", stopped: "stopped", failed: "The gateway could not start", site: "Website and docs" },
  zh: { open: "打开面板", start: "开机自启", quit: "退出", status: "网关", running: "运行中", starting: "启动中…", stopped: "已停止", failed: "网关无法启动", site: "网站与文档" },
};
const T = () => STR[locale()];

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, core = null, coreState = "starting", quitting = false;
const dataDir = path.join(app.getPath("userData"), "data");
const logFile = path.join(app.getPath("userData"), "gateway.log");

function startCore() {
  fs.mkdirSync(dataDir, { recursive: true });
  const cli = path.join(__dirname, "..", "src", "cli.mjs");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  // stdin is a pipe the child watches: when this process dies for any reason, the pipe closes and the
  // gateway exits with it (works on Windows too, where no signal reaches the child).
  core = spawn(process.execPath, [cli], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PFR_DATA_DIR: dataDir, PFR_PORT: String(PORT), PFR_PARENT_WATCH: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  core.stdout.pipe(log); core.stderr.pipe(log);
  coreState = "starting"; refreshTray();
  core.on("exit", (code) => {
    coreState = "stopped"; refreshTray();
    if (!quitting) setTimeout(startCore, 3000);      // keep the gateway up
    if (code && code !== 0 && !quitting) log.write(`[desktop] gateway exited with code ${code}, restarting\n`);
  });
}

function waitHealthy(tries = 60) {
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 1000 }, (res) => { res.resume(); if (res.statusCode === 200) { coreState = "running"; refreshTray(); resolve(true); } else retry(); });
      req.on("error", retry); req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => { if (--tries <= 0) return resolve(false); setTimeout(tick, 500); };
    tick();
  });
}

function createWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 600, show: false,
    title: "presidio-fr", icon: iconPath("icon.png"),
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });     // close = minimise to tray
  win.on("closed", () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

function iconPath(name) { return path.join(__dirname, "icons", name); }

function refreshTray() {
  if (!tray) return;
  const t = T();
  const state = coreState === "running" ? t.running : coreState === "starting" ? t.starting : t.stopped;
  tray.setToolTip(`presidio-fr — ${t.status} ${state}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${t.status} : ${state}`, enabled: false },
    { type: "separator" },
    { label: t.open, click: createWindow },
    { label: t.start, type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: t.site, click: () => shell.openExternal("https://github.com/xiao98/presidio-fr-core") },
    { type: "separator" },
    { label: t.quit, click: () => { quitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(async () => {
  app.setAppUserModelId("fr.presidio.desktop");
  tray = new Tray(nativeImage.createFromPath(iconPath(process.platform === "win32" ? "icon.ico" : "icon32.png")));
  tray.on("click", createWindow);
  refreshTray();
  startCore();
  const ok = await waitHealthy();
  if (!ok) { dialog.showErrorBox("presidio-fr", T().failed + "\n" + logFile); }
  else if (!process.argv.includes("--hidden")) createWindow();
});
app.on("second-instance", createWindow);
app.on("window-all-closed", () => { /* stay in the tray */ });
app.on("before-quit", () => { quitting = true; if (core) core.kill(); });
