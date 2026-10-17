"""Real models through the normal Server/Character + trusted Host + R5 worker.
Reuses the R5 fetch recorder. Synthetic private data only; no installed DB/config reads.
Usage: python3 accepted-dialogue.py CHECKOUT NEW_PRIVATE_OUTPUT CASES_JSON --run
"""
from http.client import HTTPConnection
import json
import base64
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

checkout, output, cases_file = map(Path, sys.argv[1:4])
resume = sys.argv[4:] == ['--resume']
if sys.argv[4:] not in [['--run'], ['--resume']]:
    raise SystemExit('Explicit --run required')
if not resume: output.mkdir(parents=True, exist_ok=False, mode=0o700)
prior = json.loads((output / 'result.json').read_text()) if resume else None
if resume: (output / ('result-before-resume-' + str(int(time.time())) + '.json')).write_text(json.dumps(prior, ensure_ascii=False, indent=2))
location = urllib.parse.urlsplit(os.environ.get('DATABASE_URL', ''))
if location.hostname != '127.0.0.1' or location.port != 31508 or not location.path.startswith('/yuvi_pr_'):
    raise SystemExit('Only explicitly isolated experiment PostgreSQL is allowed')
cases = json.loads(cases_file.read_text())
if not (0 if resume else 1) <= len(cases['turns']) <= 16:
    raise SystemExit('Bounded semantic task set required')
keys = ['PATH', 'DATABASE_URL', 'OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_API_BASEURL', 'OPENAI_COMPATIBLE_CHAT_MODEL']
env = {key: os.environ[key] for key in keys}
# This is an explicit experiment route, never an automatic fallback or installed setting change.
if os.environ.get('YUVI_EXPERIMENT_VISION_MODEL'):
    env['YUVI_EXPERIMENT_VISION_MODEL'] = os.environ['YUVI_EXPERIMENT_VISION_MODEL']
env['OPENAI_COMPATIBLE_REASONING_MODEL'] = os.environ.get('YUVI_EXPERIMENT_REASONING_MODEL', os.environ.get('OPENAI_COMPATIBLE_REASONING_MODEL', env['OPENAI_COMPATIBLE_CHAT_MODEL']))
root = output / 'env'
if not resume: root.mkdir(mode=0o700)
instance = json.loads((output / 'character.json').read_text())['instanceId'] if resume else 'ec-live-' + uuid.uuid4().hex
persona = 'character-instance:' + instance
character = output / 'character.json'
character.write_text(json.dumps({'version': 1, 'instanceId': instance, 'envDirectory': str(root),
    'definition': {'id': instance, 'revision': 'evidence-synthetic-v1', 'name': 'Synthetic Alice',
    'persona': 'Use actual evidence and uncertainty. Respond naturally in the user language. Never assert persistent memory completed merely because a user asked. Use authorized tools when needed. This is an isolated synthetic research persona.'}}))
character.chmod(0o600)
recorder = Path(__file__).resolve().parents[2] / 'runtime-memory-r5/experiments/record-isolated-fetch.mjs'
env.update({'NODE_ENV': 'development', 'PROVIDER_ALLOW_MOCKS': 'false', 'SERVER_HOST': '127.0.0.1', 'SERVER_PORT': '31505',
    'DEFAULT_CHAT_PROVIDER': 'openai-compatible', 'CHAT_PROVIDER_CHAIN': 'openai-compatible',
    'DEFAULT_REASONING_PROVIDER': 'openai-compatible', 'REASONING_PROVIDER_CHAIN': 'openai-compatible',
    'OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW': '65536', 'LOG_LEVEL': 'warn',
    'YUVI_RUNTIME_ENV_DIR': str(root), 'YUVI_CONFIG_ROOT': str(root), 'YUVI_RUNTIME_DATA_DIR': str(output / 'data'),
    'YUVI_DATA_ROOT': str(output / 'data'), 'YUVI_CACHE_ROOT': str(output / 'cache'), 'YUVI_CHARACTER_CONFIG_PATH': str(character),
    'MEMORY_BACKEND': 'postgres', 'MEMORY_QUERY_EXPANSION_ENABLED': 'true' if cases.get('queryExpansion') else 'false', 'MEMORY_REPOSITORY': 'postgres', 'CONVERSATION_REPOSITORY': 'postgres', 'MEMORY_EXTRACTOR': 'llm',
    'MEMORY_INGESTION_COORDINATOR_ENABLED': 'true', 'MEMORY_INGESTION_POLL_INTERVAL_MS': '200', 'MEMORY_INGESTION_CONCURRENCY': '1',
    'MEMORY_MAINTENANCE_ENABLED': 'false', 'MEMORY_VECTOR_INDEX_ENABLED': 'false', 'YUVI_AUTO_MIGRATE': '0',
    'YUVI_OBSERVATION_RETENTION_SECONDS': '1200', 'YUVI_OBSERVATION_RETAIN_IMAGES': 'true' if cases.get('retainSyntheticImages') else 'false',
    'COGNITION_MAX_REASONING_ROUNDS': '1', 'DASHBOARD_DEV_TOKEN': 'synthetic-experiment-operator'})
schema = prior['databaseSchema'] if resume else 'ec_live_' + uuid.uuid4().hex
env['YUVI_JOURNAL_NAMESPACE'] = schema
base = 'http://127.0.0.1:31505'
try:
    urllib.request.urlopen(base + '/health', timeout=1)
except (urllib.error.URLError, TimeoutError):
    pass
else:
    raise SystemExit('Isolated port occupied; do not replace a service')
def node(code, extra=None):
    return subprocess.check_output(['node', '--conditions=development', '--import', 'tsx', '--input-type=module', '-e', code],
        cwd=checkout, env={**env, **(extra or {})}, text=True).strip()
if not resume: node("import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});await p.query('create schema '+process.env.EC_SCHEMA);await p.end();", {'EC_SCHEMA': schema})
query = urllib.parse.parse_qsl(location.query) + [('options', '-c search_path=' + schema + ',public')]
env['DATABASE_URL'] = urllib.parse.urlunsplit(location._replace(query=urllib.parse.urlencode(query)))
if not resume:
 with (output / 'migrate.log').open('w') as log:
    subprocess.run(['pnpm', 'db:migrate'], cwd=checkout, env=env, stdout=log, stderr=log, check=True)
if not resume: node("""import {importLegacyConfiguration,commitProductSettings,writeProductSettings} from './apps/server/src/services/product-store.ts';
const {readCharacterComposition}=await import('./apps/server/src/character-composition.ts');
const {claimCharacterFiles}=await import('./apps/server/src/character-storage.ts');
const composition=readCharacterComposition(process.env.YUVI_CHARACTER_CONFIG_PATH,process.env);
claimCharacterFiles(composition.binding,composition.env,false);
const s=importLegacyConfiguration(process.env);s.people=['person-a','person-b'].map(id=>({id,displayName:id,personaId:process.env.EC_PERSONA,notes:''}));s.primaryPersonId='person-a';
if(process.env.YUVI_EXPERIMENT_VISION_MODEL){
 const provider=s.configuration.providers.find(p=>p.id==='import-openai-compatible');
 s.configuration.models.push({id:'isolated-vision',providerId:provider.id,displayName:'Synthetic experiment Vision',modelId:process.env.YUVI_EXPERIMENT_VISION_MODEL,temperature:0,contextWindow:65536,enabled:true,capabilities:['vision']});
 s.configuration.routes.vision=['isolated-vision'];
}
writeProductSettings(commitProductSettings(s,null));""", {'EC_PERSONA': persona})
def sql(query, values=None):
    return json.loads(node("import pg from 'pg';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});const r=await p.query(process.env.EC_SQL,JSON.parse(process.env.EC_VALUES));console.log(JSON.stringify(r.rows));await p.end();",
        {'EC_SQL': query, 'EC_VALUES': json.dumps(values or [])}))
def http(path, body=None, token=None, method=None):
    headers = {'content-type': 'application/json'} if body is not None else {}
    if token: headers['authorization'] = 'Bearer ' + token
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response: return response.status, json.load(response)
    except urllib.error.HTTPError as error: return error.code, json.load(error)
child = None
logs = []
restart = len(list(output.glob('server-*.log'))) if resume else 0
def stop():
    global child
    if child is None: return
    child.terminate()
    try: child.wait(timeout=15)
    except subprocess.TimeoutExpired: child.kill(); child.wait()
    child = None
    logs[-1].close()
def start():
    global child, restart
    result.setdefault('executionSegments', []).append({'startedAt':time.time(),
        'sha':subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip(),
        'trackedDiffDigest':hashlib.sha256(subprocess.check_output(['git','diff','HEAD'],cwd=checkout)).hexdigest()})
    env['YUVI_EXPERIMENT_TRACE'] = str(output / ('wire-' + str(restart) + '-calls'))
    log = (output / ('server-' + str(restart) + '.log')).open('w')
    logs.append(log)
    restart += 1
    child = subprocess.Popen(['node', '--import', str(recorder), '--conditions=development', '--import', 'tsx', 'apps/server/src/index.ts'], cwd=checkout, env=env, stdout=log, stderr=log)
    for _ in range(150):
        if child.poll() is not None: raise RuntimeError('Server exited; inspect protected log')
        try:
            if urllib.request.urlopen(base + '/health', timeout=1).status == 200: return
        except (urllib.error.URLError, TimeoutError): time.sleep(.1)
    raise RuntimeError('Server startup timeout')
def usage():
    total = {'calls': 0, 'input': 0, 'output': 0, 'cached': 0, 'estimatedCostUSD': 0., 'unknownCostCalls': 0}
    for path in output.glob('*-calls/call-*.json'):
        record = json.loads(path.read_text())
        if not record['url'].endswith('/chat/completions'): continue
        total['calls'] += 1
        payload = record.get('output', '')
        usages = []
        try: usages = [json.loads(payload).get('usage') or {}]
        except ValueError:
            for line in payload.splitlines():
                if line.startswith('data: {'): usages.append(json.loads(line[6:]).get('usage') or {})
        u = next((u for u in reversed(usages) if u.get('prompt_tokens') is not None), {})
        total['input'] += u.get('prompt_tokens', 0)
        total['output'] += u.get('completion_tokens', 0)
        total['cached'] += (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)
        if u.get('estimated_cost') is None: total['unknownCostCalls'] += 1
        else: total['estimatedCostUSD'] += float(u['estimated_cost'])
    return total
result = {'schema': 'evidence-continuity-model-run.v1', 'databaseSchema': schema, 'sha': subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip(),
    'dirty': bool(subprocess.check_output(['git','status','--porcelain'],cwd=checkout,text=True)), 'models': {k:env[k] for k in ['OPENAI_COMPATIBLE_CHAT_MODEL','OPENAI_COMPATIBLE_REASONING_MODEL']}, 'visionModel': env.get('YUVI_EXPERIMENT_VISION_MODEL'),
    'provider': env['OPENAI_COMPATIBLE_API_BASEURL'], 'persona': persona, 'personaVersion': 'evidence-synthetic-v1', 'memoryScope': 'yuvi:v1:user:person-a:character:' + urllib.parse.quote(persona, safe=''),
    'temperature': 0, 'maxTokens': 2048, 'callCap': 60, 'costCapUSD': .10, 'turns': [], 'status': 'RUNNING'}
if resume:
    result = {**prior, 'status':'RUNNING', 'resumedFromStatus':prior['status']}
    result.pop('error',None)
def save(): (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
try:
    start()
    grants = {}
    for person in ['person-a','person-b']:
        status, granted = http('/host/v1/conversation-grants/issue', {'personId': person}, 'synthetic-experiment-operator')
        if status != 200: raise RuntimeError('Synthetic Host grant failed')
        grants[person] = granted['token']
    for ordinal, case in enumerate(cases['turns'], start=len(result['turns']) if resume else 0):
        if usage()['estimatedCostUSD'] >= .10: raise RuntimeError('Known estimated spend budget reached')
        if case.get('clearShortContext'):
            stop()
            node("import pg from 'pg';import {PostgresRecentEpisodeStore} from './packages/memory/src/index.ts';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});const s=new PostgresRecentEpisodeStore(p);for(const r of (await p.query('select episode_id from recent_episodes')).rows)await s.markStatus(r.episode_id,'expired');await p.end();")
            start()
        elif case.get('restart'): stop(); start()
        token = grants[case.get('person','person-a')]
        session = case.get('session', str(uuid.uuid4()))
        if case.get('authorizeFile'):
            artifact = output / ('authorized-' + str(ordinal) + '.txt')
            artifact.write_text(case['authorizeFile'])
            artifact.chmod(0o600)
            status, authorized = http('/capabilities/read-text/authorize', {'sessionId': session, 'path': str(artifact), 'personId': case.get('person','person-a')}, 'synthetic-experiment-operator')
            if status != 200: raise RuntimeError('Explicit synthetic controller authorization failed')
        payload = {'sessionId': session, 'content': case['text'], 'options': {'readMemory': True, 'writeMemory': case.get('writeMemory',True)}}
        if case.get('syntheticImage'):
            artifact = cases_file.parent / case['syntheticImage']
            payload['imageAttachment'] = {'mimeType':'image/png','imageBase64':base64.b64encode(artifact.read_bytes()).decode()}
        if case.get('eraseObservations'):
            for record in sql('select observation_id from retained_observations where erased_at is null'):
                erasure_status, _ = http('/observations/v1/' + record['observation_id'] + '?sessionId=' + session, token=token, method='DELETE')
                if erasure_status != 200: raise RuntimeError('Synthetic observation erasure did not complete')
        started = time.monotonic()
        if case.get('cancel'):
            connection = HTTPConnection('127.0.0.1',31505,timeout=15)
            connection.request('POST','/v1/messages/stream',body=json.dumps(payload),headers={'content-type':'application/json','authorization':'Bearer '+token})
            response = connection.getresponse()
            status, body = response.status, {'transport':'CANCELLED_AFTER_HEADERS'}
            response.close(); connection.close()
        else: status, body = http('/message',payload,token)
        item = {'ordinal':ordinal,'input':case['text'],'sessionId':session,'person':case.get('person','person-a'),'httpStatus':status,
            'elapsedMs':(time.monotonic()-started)*1000,'response':body,'shortContextCleared':case.get('clearShortContext',False)}
        result['turns'].append(item);save()
        if status != 200: raise RuntimeError('Provider/Character failure; retained source remains independently processable')
        if case.get('writeMemory',True):
            for _ in range(90):
                rows = sql("select cm.id,cm.source_journal_ref,cm.ingestion_requested,fit.finalized_turn_id,fit.status,fit.last_error_code,fit.rejected_propositions from conversation_messages cm left join finalized_ingestion_turns fit using(finalized_turn_id) where cm.role='user' and cm.session_id=$1 and cm.content=$2 order by cm.sequence desc limit 1",[session,case['text']])
                if rows and rows[0]['status'] in ['complete','skipped','partial','terminal_failed']:
                    item['ingestion'] = rows[0]; save();break
                time.sleep(1)
            else: raise RuntimeError('Formal ingestion did not finish; pending is not success')
            if item['ingestion']['status'] not in ['complete','skipped']: raise RuntimeError('Formal ingestion was not complete')
        item['knowledgeAfter'] = sql("select r.id,r.event,r.version,c.state from memory_authority_records r join memory_authority_current c using(scope,id) order by r.version")
        print('turn',ordinal,'http',status,'ingestion',item.get('ingestion',{}).get('status'),flush=True)
    result['authorityState'] = sql("select scope,id,event,version from memory_authority_records order by version")
    result['projection'] = sql("select scope,id,state,version from memory_authority_current order by version")
    result['relations'] = sql("select * from memory_authority_relations order by version")
    result['semanticJobs'] = sql("select scope,job_id,status,attempts,provider_model,token_usage,duration_ms,input_context,result from memory_semantic_jobs order by created_at")
    result['retrievalEvidence'] = sql("select * from memory_retrieval_runs order by created_at")
    result['contexts'] = sql('select * from memory_retrieval_contexts order by created_at')
    result['observations'] = sql("select observation_id,kind,provider,model,evidence,expires_at,erased_at,to_jsonb(ro)->>'commit_digest' as commit_digest from retained_observations ro order by observed_at")
    result['effects'] = sql("select i.contract_ref,a.attempt_id,a.dispatch_started_at,o.evidence from effect_intents i join effect_attempts a using(intent_id) join effect_observations o using(attempt_id) where o.category='TERMINAL' order by a.created_at")
    result['status'] = 'COMPLETED'
except Exception as error:
    result['status'] = 'FAILED'; result['error'] = type(error).__name__ + ': ' + str(error)
    raise
finally:
    stop(); result['usage'] = usage(); save()
