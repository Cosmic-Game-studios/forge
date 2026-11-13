// A headless browser page driven over the DevTools protocol.
//
// Used by the screenshot and scene3d tools. Compared with starting the browser
// once per screenshot, a driven page can be scripted, can wait for the page to
// settle, and - most useful of all - reports what the page wrote to its error
// console, so "the screen is black" comes with the reason.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

let browserPath: string | null | undefined;

export function findBrowser(): string | null {
  if (browserPath !== undefined) return browserPath;
  const candidates: string[] = [];
  if (process.env.FORGE_BROWSER) candidates.push(process.env.FORGE_BROWSER);
  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter((r): r is string => !!r);
    for (const r of roots) {
      candidates.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const name of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
      const r = spawnSync("which", [name], { encoding: "utf8" });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  browserPath = candidates.find((p) => fs.existsSync(p)) ?? null;
  return browserPath;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".txt": "text/plain; charset=utf-8",
};

export interface Target {
  url: string;
  /** How the address is shown to the model. */
  label: string;
  close(): void;
}

/**
 * Turn what the model passed into an address the browser can open. A URL is
 * used as it is. A local file is served from a small web server on this
 * machine for as long as the tool runs: opened straight from disk, a page
 * cannot load ES modules or fetch its own files, which is how most pages are
 * written today. Null when the file does not exist.
 */
export async function resolveTarget(target: string, cwd: string): Promise<Target | null> {
  if (/^https?:\/\//i.test(target)) return { url: target, label: target, close() {} };
  const file = path.resolve(cwd, target);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  // Serve the working directory when the file is inside it (so /vendor, /assets resolve), else the file's folder.
  const inside = !path.relative(cwd, file).startsWith("..") && !path.isAbsolute(path.relative(cwd, file));
  const root = path.resolve(inside ? cwd : path.dirname(file));
  const server = http.createServer((req, res) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      rel = "/";
    }
    const wanted = path.resolve(root, "." + rel);
    // Nothing outside the served folder, whatever the path says.
    if (wanted !== root && !wanted.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(wanted, (err, data) => {
      if (err) {
        // Browsers ask for an icon on their own; a missing one is not the page's error.
        if (rel === "/favicon.ico") return void res.writeHead(204).end();
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(wanted).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" }).end(data);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join("/");
  return {
    url: `http://127.0.0.1:${port}/${rel}`,
    label: path.relative(cwd, file).split(path.sep).join("/") || path.basename(file),
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

export interface PageOptions {
  width: number;
  height: number;
  mobile?: boolean;
  signal: AbortSignal;
  /** Script that runs in the page before any of its own scripts. */
  init?: string;
  /** How long to let the page run after it has loaded, in ms. */
  settleMs?: number;
}

export interface BrowserPage {
  /** Run an expression in the page and return its (JSON-serialisable) value. */
  evaluate(expression: string): Promise<any>;
  screenshot(): Promise<Buffer>;
  /** Errors the page reported: uncaught exceptions, console.error, failed requests. */
  errors: string[];
  close(): void;
}

export async function openPage(url: string, opts: PageOptions): Promise<BrowserPage> {
  const browser = findBrowser();
  if (!browser) throw new Error("No Chrome, Edge or Chromium installation was found (FORGE_BROWSER can point to a browser executable).");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "forge-browser-"));
  const child: ChildProcess = spawn(
    browser,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(work, "profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      // Software rendering, so WebGL pages draw without a GPU.
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      `--window-size=${opts.width},${opts.height}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
  );
  let ws: WebSocket | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    child.kill();
    setTimeout(() => fs.rm(work, { recursive: true, force: true, maxRetries: 3 }, () => {}), 500);
  };
  opts.signal.addEventListener("abort", close, { once: true });

  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let err = "";
      const timer = setTimeout(() => reject(new Error("the browser did not start within 20 seconds")), 20_000);
      child.stderr!.on("data", (d: Buffer) => {
        err += d.toString("utf8");
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on("error", (e) => (clearTimeout(timer), reject(e)));
      child.on("close", () => (clearTimeout(timer), reject(new Error("the browser exited before it was ready"))));
    });

    const socket = (ws = new WebSocket(endpoint));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("could not connect to the browser")), { once: true });
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, ((params: any) => void)[]>();
    const errors: string[] = [];
    const note = (text: string) => {
      const line = text.replace(/\s+/g, " ").trim().slice(0, 300);
      if (line && errors.length < 20 && !errors.includes(line)) errors.push(line);
    };
    socket.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") note(`Uncaught: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "error"}`);
      else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") note(`console.error: ${msg.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
      else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") note(`${msg.params.entry.text}${msg.params.entry.url ? ` (${msg.params.entry.url})` : ""}`);
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    });
    let sessionId: string | undefined;
    const send = (method: string, params: object = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        if (closed) return reject(new Error("the browser is closed"));
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        // unref: an answered call must not keep the process alive for the rest of its timeout.
        setTimeout(() => pending.delete(id) && reject(new Error(`the browser did not answer ${method}`)), 30_000).unref();
      });
    const once = (method: string, timeoutMs: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        (listeners.get(method) ?? listeners.set(method, []).get(method)!).push(() => (clearTimeout(timer), resolve()));
      });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Log.enable")]);
    await send("Emulation.setDeviceMetricsOverride", { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: !!opts.mobile });
    if (opts.init) await send("Page.addScriptToEvaluateOnNewDocument", { source: opts.init });
    const loaded = once("Page.loadEventFired", 20_000);
    const nav = await send("Page.navigate", { url });
    if (nav.errorText) throw new Error(/CONNECTION_REFUSED/.test(nav.errorText) ? "nothing is listening at that address - is the dev server running?" : nav.errorText);
    await loaded;
    await new Promise((r) => setTimeout(r, opts.settleMs ?? 1200));

    return {
      errors,
      close,
      async evaluate(expression) {
        const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "evaluation failed");
        return res.result?.value;
      },
      async screenshot() {
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        return Buffer.from(data, "base64");
      },
    };
  } catch (err) {
    close();
    throw err;
  }
}
