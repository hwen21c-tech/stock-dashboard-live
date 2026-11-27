#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""로컬 미리보기 서버 (Python 전용 · node 없이도 관제탑을 띄워 본다)

    python3 scripts/dev_server.py                 # http://127.0.0.1:8787
    python3 scripts/dev_server.py --port 9000

public/ 정적 파일을 서빙하고, /api/* 는 라이브 Vercel 함수로 프록시한다(로컬에 node가 없을 때).
프록시가 실패하면 200 + {"ok": false} 를 돌려줘 화면이 콘솔 오류 없이 폴백하도록 한다.
"""
import argparse
import http.server
import json
import os
import socketserver
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PUB = os.path.join(os.path.dirname(HERE), "public")
UPSTREAM = os.environ.get("API_UPSTREAM", "https://stock-dashboard-live-bice.vercel.app")

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
        ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".mp3": "audio/mpeg"}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):     # 조용히
        pass

    def _send(self, code, body, ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_OPTIONS(self):               # noqa: N802
        self._send(204, b"", extra={"Access-Control-Allow-Origin": "*",
                                    "Access-Control-Allow-Methods": "GET,OPTIONS"})

    def do_GET(self):                   # noqa: N802
        path = self.path.split("?")[0]
        if path.startswith("/api/"):
            return self._proxy()
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(PUB, path.lstrip("/")))
        if not full.startswith(PUB) or not os.path.isfile(full):
            return self._send(404, "404 Not Found".encode())
        with open(full, "rb") as f:
            body = f.read()
        ctype = MIME.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        self._send(200, body, ctype)

    def _proxy(self):
        url = UPSTREAM + self.path
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (local-preview)"})
            with urllib.request.urlopen(req, timeout=25) as r:
                body = r.read()
                ctype = r.headers.get("Content-Type", "application/json; charset=utf-8")
            self._send(200, body, ctype, {"Access-Control-Allow-Origin": "*"})
        except Exception as e:          # noqa: BLE001
            payload = json.dumps({"ok": False, "reason": "upstream", "message": str(e)}).encode()
            self._send(200, payload, "application/json; charset=utf-8", {"Access-Control-Allow-Origin": "*"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), Handler) as httpd:
        print(f"관제탑 로컬 미리보기: http://127.0.0.1:{args.port}  (API → {UPSTREAM})", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            sys.exit(0)


if __name__ == "__main__":
    main()
