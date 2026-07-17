#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

import { MEDIA_PALETTES } from "./fixtures.mjs";
import { renderDocument } from "./render.mjs";
import { resolveViewMode } from "./view-mode.mjs";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function send(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, { ...BASE_HEADERS, "Content-Type": contentType, ...extraHeaders });
  response.end(body);
}

function renderMediaSvg(key) {
  const palette = MEDIA_PALETTES[key];
  if (!palette) return undefined;
  const [background, foreground, label] = palette;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480" role="img" aria-label="${label}">
    <rect width="720" height="480" fill="${background}"/>
    <g fill="none" stroke="${foreground}" stroke-width="2" opacity=".72">
      <circle cx="132" cy="168" r="62"/><circle cx="360" cy="238" r="96"/><circle cx="590" cy="128" r="42"/>
      <path d="M188 190 278 224M452 204 548 150M360 334v72M80 398h560"/>
    </g>
    <text x="48" y="440" fill="${foreground}" font-family="ui-monospace,monospace" font-size="22" letter-spacing="5">${label}</text>
  </svg>`;
}

async function serveStatic(response, filename, contentType) {
  const body = await readFile(new URL(filename, import.meta.url));
  send(response, 200, contentType, body);
}

export function createPrototypeServer() {
  return createServer(async (request, response) => {
    try {
      if (!new Set(["GET", "HEAD"]).has(request.method)) {
        send(response, 405, "text/plain; charset=utf-8", "method not allowed");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        const mode = resolveViewMode(url, request.headers.cookie ?? "");
        send(response, 200, "text/html; charset=utf-8", request.method === "HEAD" ? "" : renderDocument({ mode }), {
          "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'",
        });
        return;
      }
      if (url.pathname === "/styles.css") {
        await serveStatic(response, "styles.css", "text/css; charset=utf-8");
        return;
      }
      if (url.pathname === "/client.mjs") {
        await serveStatic(response, "client.mjs", "text/javascript; charset=utf-8");
        return;
      }
      if (url.pathname === "/view-mode.mjs") {
        await serveStatic(response, "view-mode.mjs", "text/javascript; charset=utf-8");
        return;
      }
      const mediaMatch = url.pathname.match(/^\/media\/([a-z]+)\.svg$/);
      if (mediaMatch) {
        const svg = renderMediaSvg(mediaMatch[1]);
        if (svg) {
          send(response, 200, "image/svg+xml; charset=utf-8", request.method === "HEAD" ? "" : svg);
          return;
        }
      }
      send(response, 404, "text/plain; charset=utf-8", "not found");
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", "prototype error");
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    }
  });
}

function readPort(args) {
  const index = args.indexOf("--port");
  const value = index < 0 ? 4174 : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("--port must be in 1024..65535");
  return value;
}

async function main() {
  const port = readPort(process.argv.slice(2));
  const server = createPrototypeServer();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Waterfall SSR prototype: http://127.0.0.1:${port}/\n`);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
