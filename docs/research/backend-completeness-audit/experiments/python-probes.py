"""Control-flow probes of actual sidecar functions. ASR/audio generation are recorders, not quality measurements."""
import importlib.util, json, sys, threading, types
from pathlib import Path
import numpy as np
root=Path(sys.argv[1]).resolve()
sys.path.insert(0,str(root/'services/local-stt'))
sys.modules['sherpa_onnx']=types.ModuleType('sherpa_onnx')
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
stt=load('audit_stt',root/'services/local-stt/server.py')
audio=np.arange(2000,dtype=np.float32);stt._decode_audio=lambda *args:(1000,audio)
def case(diarize):
 e=stt.SttEngine.__new__(stt.SttEngine);e._lock=threading.Lock();calls=[]
 def transcribe(rate,clip,language):
  calls.append({'samples':len(clip),'first':int(clip[0]),'language':language});return {'text':f'CLIP_{int(clip[0])}_{len(clip)}','language':'zh'}
 e.transcribe=transcribe;e.diarize=lambda *args:[{'segmentId':'A','speakerClusterId':'cluster-A','startMs':0,'endMs':700},{'segmentId':'B','speakerClusterId':'cluster-B','startMs':1000,'endMs':1800}]
 out=e.handle_transcribe({'audioBase64':'fixture','diarize':diarize,'identify':False});return {'calls':calls,'output':out}
normal=case(False);spans=case(True)
assert len(normal['calls'])==1 and normal['output']['segments'] is None
assert [s['text'] for s in spans['output']['segments']]==['CLIP_0_700','CLIP_1000_800']
assert len(spans['calls'])==3
# Negative sidecar audio decoding: invalid actual WAV payload must fail before inference.
original=load('audit_decode',root/'services/local-stt/server.py');failure=None
try: original._decode_audio('bm90LWEtd2F2','audio/wav')
except Exception as exc: failure=type(exc).__name__
assert failure is not None
# Dots TTS bounds/cancellation are runtime guarantees, no GPU run or quality assertion.
tts=load('audit_tts',root/'services/dots-tts/server.py');s=tts.Service(start_idle_watcher=False);s.state='ready';s.runtime=object();s._ensure_runtime_locked=lambda:None;s._generate_wav_bytes=lambda *args:b'fixture-audio'
small=s.synthesize({'requestId':'small','text':'x'*2000});large=s.synthesize({'requestId':'large','text':'x'*2001});s.cancel('cancelled');cancel=s.synthesize({'requestId':'cancelled','text':'hello'})
assert small[0]==200 and large[0]==400 and cancel[0]==409
out={'sourceSHA':__import__('subprocess').check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'kind':'sidecar-control-probes','actualModelCalls':0,'stt':{'normal':normal,'diarized':spans,'invalidWavError':failure,'counterfactual':'Without per-span recognition only CLIP_0_2000 would remain; actual STT produces distinct timed segment text. Downstream conversion requires separate audit.','scope':'Real SttEngine.handle_transcribe/_decode_audio; mocked ASR/diarizer, numpy fixture, sherpa import stub; no acoustic identification or quality claim'},'dotsTTS':{'normalStatus':small[0],'overflowStatus':large[0],'overflowError':large[1],'cancelStatus':cancel[0],'counterfactual':'Two <=2000-character requests could pass the sidecar input bound; not proof production splits long replies.','scope':'Real Service.synthesize validation/locks/cancel; generated audio mocked, no GPU, hibernate/reload or provider end-to-end claim'}}
Path(__file__).with_name('python-results.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out,ensure_ascii=False))
