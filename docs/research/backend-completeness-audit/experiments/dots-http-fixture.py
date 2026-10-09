"""Real sidecar HTTP handler and input policy; only expensive waveform generation is replaced."""
import importlib.util,sys
from http.server import ThreadingHTTPServer
from pathlib import Path
p=Path(sys.argv[1])/'services/dots-tts/server.py';spec=importlib.util.spec_from_file_location('dots_audit',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.Service(start_idle_watcher=False);s.state='ready';s.runtime=object();s._ensure_runtime_locked=lambda:None
wav=bytearray(48);wav[:4]=b'RIFF';wav[8:12]=b'WAVE';s._generate_wav_bytes=lambda *args:bytes(wav)
server=ThreadingHTTPServer(('127.0.0.1',0),m.Handler);server.service=s
print(server.server_address[1],flush=True);server.serve_forever()
