#!/usr/bin/env python3
"""Run native regressions on Linux/WSL; build outputs stay in a temporary directory."""
from pathlib import Path
import concurrent.futures
import http.server
import os
import subprocess
import tempfile
import threading
import time
import sys

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)
os.environ['no_proxy'] = '127.0.0.1'
sanitize = os.environ.get('SANITIZE', '1') == '1'
flags = ['-Wall', '-Wextra', '-Werror', '-I.', '-pthread']
if sanitize:
    flags += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-fno-pie', '-no-pie']

class DelayedHost(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/fast':
            time.sleep(5)
        try:
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'paired')
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass

with tempfile.TemporaryDirectory(prefix='moonlight-native-') as output:
    output = Path(output)
    def compile_c(name):
        obj = output / (Path(name).stem + '.o')
        # The Samsung-compatible HTTP adapter retains legacy curl callbacks and
        # pre-existing signed length comparisons; keep all other warnings fatal.
        compatibility = ['-Wno-deprecated-declarations', '-Wno-sign-compare'] if name.endswith('/http.c') else []
        subprocess.run(['gcc', '-std=c11', *flags, *compatibility, '-c', name, '-o', str(obj)], check=True)
        return str(obj)

    extra = {
        'http_context_tests': ['libgamestream/http_context.c'],
        'http_buffer_tests': ['libgamestream/http_buffer.c'],
        'pairing_hex_tests': ['libgamestream/hex_utils.c'],
        'request_registry_tests': [compile_c('libgamestream/http_context.c')],
        'diagnostic_log_tests': ['wasm/diagnostic_log.cpp'],
        'web_audio_decode_tests': ['-Iopus/include', '-lopus'],
    }
    for test in sorted(Path('tests').glob('*_tests.c*')):
        if test.stem == 'http_pairing_integration_tests':
            continue
        if len(sys.argv) > 1 and test.stem not in sys.argv[1:]:
            continue
        cpp = test.suffix == '.cpp'
        binary = output / test.stem
        subprocess.run(['g++' if cpp else 'gcc', '-std=c++17' if cpp else '-std=c11', *flags,
                        str(test), *extra.get(test.stem, []), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True, timeout=45)
        print(test.stem + ': PASS', flush=True)

    if len(sys.argv) == 1 or 'http_pairing_integration_tests' in sys.argv[1:]:
        objects = [compile_c('libgamestream/' + n + '.c') for n in ['http', 'http_context', 'http_buffer']]
        binary = output / 'http_pairing_integration_tests'
        subprocess.run(['g++', '-std=c++17', *flags, 'tests/http_pairing_integration_tests.cpp',
                        *objects, '-lcurl', '-lssl', '-lcrypto', '-o', str(binary)], check=True)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), DelayedHost)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with concurrent.futures.ThreadPoolExecutor(3) as pool:
                jobs = [pool.submit(subprocess.run, [str(binary), 'http://127.0.0.1:' + str(server.server_port) + '/delay', mode],
                                    check=True, timeout=15) for mode in ['pair', 'regular', 'cancel']]
                for job in jobs:
                    job.result()
            print('http_pairing_integration_tests: PASS (delayed PIN, ordinary timeout, cancel and retry)', flush=True)
        finally:
            server.shutdown()
            server.server_close()
