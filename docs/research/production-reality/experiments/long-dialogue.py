"""Normal Server startup + real Provider, reusing the R5 fetch recorder.

Credentials supplied through environment; never copy product configuration.
Usage: python3 long-dialogue.py CHECKOUT PRIVATE_OUTPUT CASES_FILE --run
The same cases file can be used with a baseline checkout. No fixed model answers.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request

checkout, output, cases_file = map(Path, sys.argv[1:4])
if sys.argv[4:] != ['--run']:
    raise SystemExit('Explicit --run required')
output.mkdir(parents=True, exist_ok=False, mode=0o700)
url = os.environ.get('DATABASE_URL', '')
location = urllib.parse.urlsplit(url)
if location.hostname != '127.0.0.1' or location.port != 31508 or not location.path.startswith('/yuvi_pr_'):
    raise SystemExit('Requires isolated production-reality PostgreSQL, never Alice database')
for key in ['OPENAI_COMPATIBLE_API_KEY', 'OPENAI_COMPATIBLE_CHAT_MODEL', 'OPENAI_COMPATIBLE_API_BASEURL']:
    if not os.environ.get(key):
        raise SystemExit('Missing real Provider configuration: ' + key)
cases = json.loads(cases_file.read_text())
if len(cases['turns']) != 30:
    raise SystemExit('Expected exactly 30 accepted turns')
env_directory = output / 'env'
env_directory.mkdir(mode=0o700)
character_id = 'pr-experiment-' + output.name
configuration = {
    'version': 1, 'instanceId': character_id, 'envDirectory': str(env_directory),
    'definition': {'id': character_id, 'revision': 'synthetic-continuity-v1',
                   'name': 'Synthetic Alice', 'persona': cases['persona']}}
character_file = output / 'character.json'
character_file.write_text(json.dumps(configuration))
character_file.chmod(0o600)
# This is the existing recorder, not a replacement Provider or model proxy.
recorder = Path(__file__).resolve().parents[2] / 'runtime-memory-r5/experiments/record-isolated-fetch.mjs'
env = {key: os.environ[key] for key in ['PATH', 'DATABASE_URL', 'OPENAI_COMPATIBLE_API_KEY',
       'OPENAI_COMPATIBLE_CHAT_MODEL', 'OPENAI_COMPATIBLE_API_BASEURL']}
env.update({
    'OPENAI_COMPATIBLE_REASONING_MODEL': env['OPENAI_COMPATIBLE_CHAT_MODEL'],
    'OPENAI_COMPATIBLE_CHAT_CONTEXT_WINDOW': '65536',
    'NODE_ENV': 'development', 'RUNTIME_MODE': 'development', 'PROVIDER_ALLOW_MOCKS': 'false',
    'DEFAULT_CHAT_PROVIDER': 'openai-compatible', 'CHAT_PROVIDER_CHAIN': 'openai-compatible',
    'DEFAULT_REASONING_PROVIDER': 'openai-compatible', 'REASONING_PROVIDER_CHAIN': 'openai-compatible',
    'SERVER_HOST': '127.0.0.1', 'SERVER_PORT': '31505', 'LOG_LEVEL': 'error',
    'YUVI_CHARACTER_CONFIG_PATH': str(character_file), 'YUVI_RUNTIME_ENV_DIR': str(env_directory),
    'YUVI_CONFIG_ROOT': str(env_directory), 'YUVI_DATA_ROOT': str(output / 'data'),
    'YUVI_CACHE_ROOT': str(output / 'cache'), 'YUVI_RUNTIME_DATA_DIR': str(output / 'data'),
    'YUVI_EXPERIMENT_TRACE': str(output / 'wire-calls'),
    'MEMORY_BACKEND': 'postgres', 'MEMORY_REPOSITORY': 'postgres',
    'CONVERSATION_REPOSITORY': 'postgres', 'MEMORY_EXTRACTOR': 'llm',
    'MEMORY_MAINTENANCE_ENABLED': 'false', 'MEMORY_INGESTION_COORDINATOR_ENABLED': 'false',
    'MEMORY_VECTOR_INDEX_ENABLED': 'false', 'YUVI_AUTO_MIGRATE': '0'})
# Character ownership is schema-level: do not claim even another synthetic history.
schema = 'pr_live_' + uuid.uuid4().hex
subprocess.run(['node', '--input-type=module', '-e',
    "import pg from 'pg'; const p=new pg.Pool({connectionString:process.env.DATABASE_URL}); "
    "await p.query('create schema '+process.env.PR_EXPERIMENT_SCHEMA); await p.end();"],
    cwd=checkout, env={**env, 'PR_EXPERIMENT_SCHEMA': schema}, check=True)
query = urllib.parse.parse_qsl(location.query)
query.append(('options', '-c search_path=' + schema + ',public'))
env['DATABASE_URL'] = urllib.parse.urlunsplit(location._replace(query=urllib.parse.urlencode(query)))
with (output / 'migrate.log').open('w') as migration_log:
    subprocess.run(['pnpm', 'db:migrate'], cwd=checkout, env=env,
                   stdout=migration_log, stderr=migration_log, check=True)
base = 'http://127.0.0.1:31505'
try:
    urllib.request.urlopen(base + '/health', timeout=2)
except (urllib.error.URLError, TimeoutError):
    pass
else:
    raise SystemExit('Isolated port already occupied; do not replace existing service')
result = {
    'schema': 'normal-entry-model-quality.v1',
    'gitSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=checkout, text=True).strip(),
    'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=checkout, text=True)),
    'entrypoint': 'apps/server/src/index.ts', 'provider': 'DeepInfra/OpenAI compatible',
    'model': env['OPENAI_COMPATIBLE_CHAT_MODEL'], 'declaredContextWindow': 65536,
    'temperature': 0, 'maxTokens': 2048, 'callCap': 60,
    'maximumEstimatedSpendUSD': 0.25,
    'scope': 'anonymous restricted, memory read/write disabled; Conversation continuity only',
    'persona': cases['persona'], 'turns': [], 'status': 'RUNNING',
    'limitations': ['Not product Host credential proof', 'One remote model series is not general reliability',
                    'Recorder caps calls; final estimated cost from Provider usage, not final invoice']}
with (output / 'server.log').open('w') as log:
    child = subprocess.Popen(['node', '--import', str(recorder), '--conditions=development', '--import',
                             'tsx', 'apps/server/src/index.ts'], cwd=checkout, env=env,
                            stdout=log, stderr=log)
    try:
        for attempt in range(100):
            if child.poll() is not None:
                raise RuntimeError('Isolated Server exited; inspect protected server.log')
            try:
                if urllib.request.urlopen(base + '/health', timeout=2).status == 200:
                    break
            except urllib.error.URLError:
                time.sleep(0.1)
        else:
            raise RuntimeError('Isolated Server startup timeout')
        for index, text in enumerate(cases['turns']):
            payload = {'sessionId': 'long-dialogue', 'text': text,
                       'options': {'readMemory': False, 'writeMemory': False, 'voiceOutput': False}}
            request = urllib.request.Request(base + '/message', data=json.dumps(payload).encode(),
                                             headers={'content-type': 'application/json'})
            start = time.monotonic()
            try:
                response = urllib.request.urlopen(request, timeout=150)
                status, body = response.status, json.load(response)
            except urllib.error.HTTPError as error:
                status, body = error.code, json.load(error)
            result['turns'].append({'turn': index + 1, 'input': text, 'httpStatus': status,
                                    'elapsedMs': (time.monotonic() - start) * 1000, 'result': body})
            (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
            print('turn', index + 1, 'status', status, flush=True)
            if status != 200:
                raise RuntimeError('Remote production turn failed; no silent fallback or retry')
            # Hard cost boundary checked between calls using actual recorded usage.
            costs = []
            for file in (output / 'wire-calls').glob('call-*.json'):
                wire = json.loads(file.read_text()).get('output', '')
                try:
                    usage = json.loads(wire).get('usage', {})
                    costs.append(float(usage.get('estimated_cost', 0)))
                except ValueError:
                    for line in wire.splitlines():
                        if not line.startswith('data: {'):
                            continue
                        usage = json.loads(line[6:]).get('usage', {})
                        costs.append(float(usage.get('estimated_cost', 0)))
            if sum(costs) >= 0.25:
                raise RuntimeError('Estimated cost budget reached; preserve evidence and stop')
        result['status'] = 'COMPLETED'
    except Exception as error:
        result['status'] = 'FAILED'
        result['error'] = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        (output / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
