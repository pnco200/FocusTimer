"""Serve the repo on a separate loopback origin without caching. No OAuth credentials."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Referrer-Policy', 'no-referrer')
        super().end_headers()

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    print('Open http://127.0.0.1:8765/experiments/google-drive/; register this exact origin for both public web clients.')
    ThreadingHTTPServer(('127.0.0.1', 8765), partial(Handler, directory=str(root))).serve_forever()
