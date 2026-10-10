import json,pathlib,sys
here=pathlib.Path(__file__).resolve().parent;root=pathlib.Path(sys.argv[1]).resolve();f=here/'residual-sample.json';d=json.loads(f.read_text())
notes={
'apps/server/src/speech-receipt-admission.ts':('WHOLE_SMALL_FILE_RISK_REVIEW','Voice receipt retains code-point selectors and unresolved principal/audience without treating acoustic match as Person authority; final Journal exception commit certainty needs actual DB failure probe'),
'packages/core/src/voice-binding-references.ts':('WHOLE_SMALL_FILE_RISK_REVIEW','Index completeness watermark checked against controller owner; file temp+rename preserves durability but process/multiwriter behavior remains OPEN'),
'packages/desktop-supervisor/src/postgres-port.ts':('WHOLE_SMALL_FILE_RISK_REVIEW','Port occupancy never authorizes killing foreign process; selected port still subject to later bind race'),
'services/dots-tts/audio_output.py':('WHOLE_SMALL_FILE_RISK_REVIEW','Bounded RMS leading silence trim; no new risk class beyond already indexed media transform; actual audio effect unmeasured'),
'services/memory-mem0/src/yuvi_mem0/schemas.py':('WHOLE_SMALL_FILE_RISK_REVIEW','Distinct in_flight/unknown reconciliation; update scope optional and byte/domain bounds require service-handler investigation, not UNUSED'),
'apps/web/src/speech-identity.ts':('WHOLE_SMALL_FILE_RISK_REVIEW','requestId + sequence comparison only; no persistence or effect entry'),
'packages/protocol/src/embodied-behavior.ts':('WHOLE_SMALL_FILE_RISK_REVIEW','Strict bounded opaque causal references and strength enums, canonicalization is not execution authority'),
'packages/character-harness/src/embodied-soft-smile-projection.ts':('SOURCE_EXCERPTS_OPEN','Revalidated proposal and canonicalizer injection; no device authority implied; remainder validation not fully reviewed'),
'packages/memory/src/temporal-projection.ts':('SOURCE_EXCERPTS_OPEN','Missing timestamps yield unknown; inventedGapEvents false. Full timezone/age semantics not established'),
'packages/providers/src/alibaba/DashScopeSTTProvider.ts':('SOURCE_EXCERPTS_OPEN','Audio inline byte bound, transport cancellation and normalized text inspected; full remote content/HTTP response envelope still OPEN'),
'services/local-stt/speaker_store.py':('SOURCE_EXCERPTS_OPEN','Observed native receipts/fences UNKNOWN and acoustic != Person identity; concurrency/generation filesystem behavior not fully reviewed'),
'packages/p8/src/persistence.ts':('SOURCE_EXCERPTS_OPEN','Append-only correction records and explicit UNKNOWN/CONFLICT exposed; grounded authority and full polymorphic store ownership not closed'),
'packages/prompt-builder/src/canonical-context.ts':('SOURCE_EXCERPTS_OPEN','Epistemic states retained, shared context/user-role projection examined; full role and compression effects need live-model experiment'),
'packages/host-environment/src/index.ts':('SOURCE_EXCERPTS_OPEN','Persistent/ephemeral checks and async file ownership identified; whole install/rollback not closed'),
'apps/server/src/services/voice-review.ts':('SOURCE_EXCERPTS_OPEN','Private bounded PCM retention and migration inspected; sample eviction vs in-flight enrollment references needs targeted probe'),
'scripts/accept-voice-capture.mts':('WHOLE_SMALL_FILE_RISK_REVIEW','Existing opt-in real STT acceptance script, isolated speaker store and owned child cleanup; unavailable model/device so not executed')}
for x in d['samples']:
 p=x['path'];s=(root/p).suffix
 if p in notes:x['review'],x['notes']=notes[p]
 elif s in ['.json','.yaml','.yml','.spec'] or p=='.env.example':x.update(review='CONFIG_OR_BUILD_RISK_REVIEW',notes='Full text inspected; build/config inputs not runtime semantic state. Defaults/deployment are not live activation proof.')
 elif s=='.png':x.update(review='BINARY_ASSET_METADATA_ONLY',notes='Image asset retained in inventory; no executable state/entry inferred; pixel presentation not audited.')
 else:x.update(review='PENDING',notes='No deep review claim')
 x['newHighRiskClassConfirmed']=False
 x['reason']='Sampling tests discovery method; excerpts/metadata never imply whole-file correctness'
d['stopDecision']='Stop this repair batch after confirmed P0/P1 and direct adjacent defects; not a completed six-range audit. Excerpt-only samples and dynamic/cross-process candidates remain explicit OPEN for next batch.'
f.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
