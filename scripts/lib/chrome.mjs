/**
 * Minimal headless-Chrome driver over the DevTools pipe.
 *
 * Printing a PDF with `chrome --print-to-pdf` costs ~0.85 s per document,
 * because almost all of it is Chrome starting up (the print itself is ~0.1 s).
 * With three variants per build that dominated the whole rebuild.
 *
 * This module keeps ONE Chrome process alive and drives it over
 * `--remote-debugging-pipe`: DevTools messages are NUL-terminated JSON written
 * to fd 3 and read from fd 4, so no WebSocket client (and no dependency) is
 * needed. One browser boot is then shared by every PDF in the build.
 *
 * Printing uses Page.printToPDF with `preferCSSPageSize`, so the `@page` rule
 * in the stylesheet stays authoritative, exactly like before.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  return CHROME_CANDIDATES.filter(Boolean).find((candidate) =>
    existsSync(candidate),
  );
}

class PipeConnection {
  #child;
  #out;
  #in;
  #buffer = "";
  #nextId = 0;
  #pending = new Map();
  #stderr = [];
  #closed = false;

  constructor(child) {
    this.#child = child;
    this.#out = child.stdio[3];
    this.#in = child.stdio[4];

    this.#in.setEncoding("utf8");
    this.#in.on("data", (chunk) => this.#receive(chunk));
    this.#in.on("error", () => {});

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      /* keep only the tail: Chrome is chatty and we want it for diagnostics */
      this.#stderr.push(chunk);
      if (this.#stderr.length > 40) this.#stderr.shift();
    });
    child.stderr.on("error", () => {});

    child.on("exit", (code, signal) => {
      this.#failAll(
        new Error(
          `Chrome exited unexpectedly (code ${code}, signal ${signal}).\n${this.stderrTail()}`,
        ),
      );
    });
  }

  stderrTail() {
    return this.#stderr.join("").trim().split("\n").slice(-8).join("\n");
  }

  #receive(chunk) {
    this.#buffer += chunk;

    let index;
    while ((index = this.#buffer.indexOf("\0")) !== -1) {
      const raw = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);

      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }

      if (message.id !== undefined && this.#pending.has(message.id)) {
        const { resolve, reject, timer } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        clearTimeout(timer);

        if (message.error) {
          const error = new Error(
            `${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`,
          );
          error.code = message.error.code;
          reject(error);
        } else {
          resolve(message.result ?? {});
        }
        continue;
      }

      /* page events are polled for instead of listened to */
    }
  }

  #failAll(error) {
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) {
      return Promise.reject(new Error("Chrome connection is closed."));
    }

    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} in time.`));
      }, 60_000);

      this.#pending.set(id, { resolve, reject, timer });
      this.#out.write(
        `${JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        })}\0`,
      );
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("Chrome connection closed."));

    const exited = new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        return resolve();
      }
      this.#child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    });

    this.#child.kill("SIGKILL");
    await exited;

    /* Release the pipe handles: Chrome's helper processes can hold them open
       for another ~2 s after the browser is gone, which would keep Node's
       event loop alive long after the build is finished. */
    for (const stream of [this.#out, this.#in, this.#child.stderr]) {
      try {
        stream.destroy();
      } catch {
        /* already gone */
      }
    }
    this.#child.unref();
  }
}

/**
 * One Chrome process, one tab per document printed on demand.
 *
 *   const browser = await launchBrowser();
 *   await browser.printPdf(url, "out.pdf");
 *   await browser.close();
 */
export async function launchBrowser({ executable, args = [] } = {}) {
  const chrome = executable ?? findChrome();
  if (!chrome) {
    throw new Error(
      "Chrome/Chromium not found. Set CHROME_PATH or use --html-only.",
    );
  }

  const profileDir = await mkdtemp(join(tmpdir(), "cv-chrome-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--run-all-compositor-stages-before-draw",
      "--remote-debugging-pipe",
      `--user-data-dir=${profileDir}`,
      ...args,
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );

  const connection = new PipeConnection(child);
  const browser = new ChromeBrowser(connection, profileDir);
  await browser.ready();
  return browser;
}

class ChromeBrowser {
  #connection;
  #profileDir;
  version = null;

  constructor(connection, profileDir) {
    this.#connection = connection;
    this.#profileDir = profileDir;
  }

  /** Waits until Chrome answers on the pipe. No tab is created here. */
  async ready() {
    const version = await this.#connection.send("Browser.getVersion");
    this.version = version.product;
    return this;
  }

  async #openPage(url) {
    const { targetId } = await this.#connection.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await this.#connection.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    const send = (method, params) =>
      this.#connection.send(method, params, sessionId);

    await send("Page.enable", {});

    if (url) {
      const { errorText } = await send("Page.navigate", { url });
      if (errorText) throw new Error(`Could not open ${url}: ${errorText}`);

      /* Poll instead of listening for Page.loadEventFired: the event can be
         missed, while a complete readyState cannot. */
      const deadline = Date.now() + 30_000;
      for (;;) {
        const { result } = await send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        });
        if (result.value === "complete") break;
        if (Date.now() > deadline) {
          throw new Error(`Timed out loading ${url}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    return { targetId, sessionId, send };
  }

  async #closePage(targetId) {
    try {
      await this.#connection.send("Target.closeTarget", { targetId });
    } catch {
      /* the tab is disposable */
    }
  }

  async #settle(send) {
    /* system fonts only, but make sure layout and paint have both run */
    await send("Runtime.evaluate", {
      expression: `new Promise((done) => {
        const tick = () => requestAnimationFrame(() => requestAnimationFrame(done));
        (document.fonts?.ready ?? Promise.resolve()).then(tick, tick);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  /**
   * Renders `url` (file:// or http://) to PDF bytes. `@page` size and margins
   * come from the stylesheet, so the output matches `--print-to-pdf`.
   */
  async printPdf(url, { printBackground = true } = {}) {
    const page = await this.#openPage(url);

    try {
      await this.#settle(page.send);
      const { data } = await page.send("Page.printToPDF", {
        printBackground,
        preferCSSPageSize: true,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      });
      return Buffer.from(data, "base64");
    } finally {
      await this.#closePage(page.targetId);
    }
  }

  /** Opens `url` with print media emulated and evaluates `expression`. */
  async evaluate(url, expression) {
    const page = await this.#openPage(url);

    try {
      await page.send("Emulation.setEmulatedMedia", {
        media: "print",
        features: [],
      });
      await this.#settle(page.send);

      const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });

      if (exceptionDetails) {
        throw new Error(
          exceptionDetails.exception?.description ??
            exceptionDetails.text ??
            "evaluate failed",
        );
      }
      return result.value;
    } finally {
      await this.#closePage(page.targetId);
    }
  }

  async close() {
    await this.#connection.close();
    await rm(this.#profileDir, { recursive: true, force: true });
  }
}
