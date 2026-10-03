# YUVI Local STT third-party notices

This packaged sidecar redistributes generic speech models and runtime libraries.
It must never include user VoiceProfiles, speaker embeddings, enrollment
recordings, unknown-voice review samples, Memory, API keys, `.env` secrets,
machine-specific absolute paths, private TTS reference audio, Rei assets, or
private dots.tts weights/config/runtime.

Code/runtime licenses are recorded separately from model-weight licenses.

## Model weights

### SenseVoice Small INT8 ONNX

- Role: ASR
- Packaged file: `models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx`
- Upstream model: FunAudioLLM / SenseVoiceSmall
  (https://github.com/FunAudioLLM/SenseVoice,
  https://huggingface.co/FunAudioLLM/SenseVoiceSmall)
- Conversion artifact: k2-fsa/sherpa-onnx release
  `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
- Model-weight license: FunASR Model Open Source License Agreement v1.1
  (Alibaba Group). This is **not** Apache-2.0.
- Full license text: `licenses/FUNASR_MODEL_LICENSE.txt`
- Official model-card license label: `model-license`
- FunAudioLLM/SenseVoice **source code** is MIT; that grant does not cover
  these weights.
- sherpa-onnx conversion tooling is Apache-2.0; converted weights remain under
  the FunASR model license.
- Attribution required by §2.2: retain the SenseVoice / FunASR model name and
  author information (Alibaba Group / FunAudioLLM / FunASR).

### 3D-Speaker ERes2Net speaker embedding

- Role: speaker embedding
- Packaged file: `models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`
- Upstream: https://github.com/alibaba-damo-academy/3D-Speaker
- Redistribution: k2-fsa/sherpa-onnx speaker-recognition-models
- License: Apache License 2.0
- Full license text: `licenses/3D-Speaker.LICENSE.txt`

### pyannote speaker segmentation 3.0

- Role: diarization segmentation
- Packaged file: `models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`
- Upstream: https://huggingface.co/pyannote/segmentation-3.0
- Redistribution: k2-fsa/sherpa-onnx speaker-segmentation-models
- License: MIT (Copyright CNRS)
- Full license text: `licenses/pyannote-segmentation-3.0.LICENSE.txt`

### Silero VAD

- Role: voice-activity detection used by live speech activity
- Packaged file: `models/silero_vad.onnx`
- Upstream: https://github.com/snakers4/silero-vad
- Redistribution: k2-fsa/sherpa-onnx `asr-models/silero_vad.onnx`
- License: MIT License (silero-vad, Copyright Silero Team)
- Full license text: `licenses/silero-vad.LICENSE.txt`

## Runtime and native dependencies

These are bundled inside the self-contained sidecar (`yuvi-local-stt` /
`yuvi-local-stt.exe` plus `_internal`). They are not a system Python
environment.

| Component                      | Version pin                 | License                                    | Notes                                                                               |
| ------------------------------ | --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| sherpa-onnx                    | 1.13.6                      | Apache-2.0                                 | ASR / embedding / diarization / VAD runtime                                         |
| NumPy                          | 2.3.2                       | BSD-3-Clause                               |                                                                                     |
| CPython                        | 3.11.x (PyInstaller onedir) | PSF-2.0                                    | Isolated inside the artifact                                                        |
| PyInstaller                    | 6.13.0                      | GPL-2.0-or-later with bootloader exception | Bootloader exception permits bundling this application without applying GPL to YUVI |
| ONNX Runtime (via sherpa-onnx) | wheel-selected              | MIT                                        | Native inference                                                                    |

Exact native filenames vary by platform and appear under `_internal` after the
packaged build.

## Not redistributed

- User speaker manifests and generation files — writable app data only
- Enrollment / review audio
- Private dots.tts / Rei reference audio, transcripts, weights, or venv
- Hugging Face cache snapshots unrelated to the generic Local STT stack
- `0-four-speakers-zh.wav` and other upstream test clips

Development checkouts may still provision models with
`pnpm local-stt:provision`. Packaged public installs must use the sidecar and
the immutable `models/` tree next to it.
