// presidio-fr desktop: tray app that runs the gateway (src/cli.mjs) as a child process using Electron's
// own Node (ELECTRON_RUN_AS_NODE), and shows the control panel served by the gateway in a window.
// No renderer code of its own: the window simply loads http://127.0.0.1:<port>/.
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = Number(process.env.PFR_PORT || 8787);
const STR = {
  fr: { open: "Ouvrir le panneau", start: "Lancer au démarrage", quit: "Quitter", status: "Passerelle", running: "en service", starting: "démarrage…", stopped: "arrêtée",
        failed: "La passerelle n'a pas pu démarrer", site: "Site et documentation", gwStart: "Démarrer la passerelle", gwStop: "Arrêter la passerelle", gwRestart: "Redémarrer la passerelle",
        lang: "Langue", stoppedTitle: "Passerelle arrêtée", stoppedBody: "Vos outils ne peuvent plus envoyer de requêtes. Démarrez-la depuis le menu de l'icône dans la zone de notification.", startBtn: "Démarrer" },
  en: { open: "Open panel", start: "Start at login", quit: "Quit", status: "Gateway", running: "running", starting: "starting…", stopped: "stopped",
        failed: "The gateway could not start", site: "Website and docs", gwStart: "Start gateway", gwStop: "Stop gateway", gwRestart: "Restart gateway",
        lang: "Language", stoppedTitle: "Gateway stopped", stoppedBody: "Your tools cannot send requests. Start it from the tray icon menu.", startBtn: "Start" },
  zh: { open: "打开面板", start: "开机自启", quit: "退出", status: "网关", running: "运行中", starting: "启动中…", stopped: "已停止",
        failed: "网关无法启动", site: "网站与文档", gwStart: "启动网关", gwStop: "停止网关", gwRestart: "重启网关",
        lang: "语言", stoppedTitle: "网关已停止", stoppedBody: "你的工具现在无法发送请求。在托盘图标的右键菜单里启动。", startBtn: "启动" },
};
const LANG_NAMES = { fr: "Français", en: "English", zh: "中文" };

if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, core = null, coreState = "stopped", quitting = false, wanted = true;
const dataDir = path.join(app.getPath("userData"), "data");
const logFile = path.join(app.getPath("userData"), "gateway.log");
const settingsFile = path.join(app.getPath("userData"), "settings.json");
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")); } catch (_) { settings = {}; }
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
const lang = () => settings.lang || (() => { const l = (app.getLocale() || "fr").toLowerCase(); return l.startsWith("fr") ? "fr" : l.startsWith("zh") ? "zh" : "en"; })();
const T = () => STR[lang()];

// ---------- gateway child ----------
function startCore() {
  if (core) return;
  wanted = true;
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
    core = null;
    coreState = "stopped"; refreshTray();
    if (win && !win.isDestroyed()) showStoppedPage();
    if (!quitting && wanted) { log.write(`[desktop] gateway exited with code ${code}, restarting\n`); setTimeout(() => { if (wanted && !core) startCore().then(() => {}); }, 3000); }
  });
  return waitHealthy().then((ok) => { if (ok && win && !win.isDestroyed()) win.loadURL(panelUrl()); return ok; });
}
function stopCore() {
  wanted = false;
  if (core) { try { core.stdin.end(); } catch (_) {} setTimeout(() => { if (core) core.kill(); }, 1500); }
  coreState = "stopped"; refreshTray();
  if (win && !win.isDestroyed()) showStoppedPage();
}
function waitHealthy(tries = 60) {
  return new Promise((resolve) => {
    const tick = () => {
      if (!wanted) return resolve(false);
      const req = http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 1000 }, (res) => { res.resume(); if (res.statusCode === 200) { coreState = "running"; refreshTray(); resolve(true); } else retry(); });
      req.on("error", retry); req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => { if (--tries <= 0) return resolve(false); setTimeout(tick, 500); };
    tick();
  });
}

// ---------- window ----------
const panelUrl = () => `http://127.0.0.1:${PORT}/?lang=${lang()}`;
function stoppedPage() {
  const t = T();
  return "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html lang="${lang()}"><head><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;background:#f6f7f9;color:#14181f}
    @media(prefers-color-scheme:dark){body{background:#0f1218;color:#e8eaf0}}
    .box{max-width:420px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#6b7280;margin:0 0 18px}
    button{background:#0f766e;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}</style></head>
    <body><div class="box"><h1>⏸ ${t.stoppedTitle}</h1><p>${t.stoppedBody}</p><button onclick="location.href='presidio-fr://start'">${t.startBtn}</button></div></body></html>`);
}
function showStoppedPage() { if (win && !win.isDestroyed()) win.loadURL(stoppedPage()); }
function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 600, show: false,
    title: "presidio-fr", icon: iconPath("icon.png"), autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.loadURL(coreState === "running" ? panelUrl() : stoppedPage());
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });     // close = minimise to tray
  win.on("closed", () => { win = null; });
  // the stopped page's button navigates to presidio-fr://start: intercept and start the gateway
  win.webContents.on("will-navigate", (e, url) => { if (url.startsWith("presidio-fr://start")) { e.preventDefault(); startCore(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}
function iconPath(name) { return path.join(__dirname, "icons", name); }

// ---------- tray ----------
function refreshTray() {
  if (!tray) return;
  const t = T();
  const state = coreState === "running" ? t.running : coreState === "starting" ? t.starting : t.stopped;
  tray.setToolTip(`presidio-fr — ${t.status} ${state}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${t.status} : ${state}`, enabled: false },
    { type: "separator" },
    { label: t.open, click: createWindow },
    coreState === "stopped" ? { label: t.gwStart, click: () => startCore() } : { label: t.gwStop, click: stopCore },
    { label: t.gwRestart, enabled: coreState !== "stopped", click: () => { wanted = true; if (core) core.kill(); else startCore(); } },
    { type: "separator" },
    { label: t.lang, submenu: Object.entries(LANG_NAMES).map(([code, name]) => ({ label: name, type: "radio", checked: lang() === code, click: () => { settings.lang = code; saveSettings(); refreshTray(); if (win && !win.isDestroyed()) win.loadURL(coreState === "running" ? panelUrl() : stoppedPage()); } })) },
    { label: t.start, type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }) },
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
  const ok = await startCore();
  if (!ok && wanted) dialog.showErrorBox("presidio-fr", T().failed + "\n" + logFile);
  if (!process.argv.includes("--hidden")) createWindow();
});
app.on("second-instance", createWindow);
app.on("window-all-closed", () => { /* stay in the tray */ });
app.on("before-quit", () => { quitting = true; wanted = false; if (core) core.kill(); });
