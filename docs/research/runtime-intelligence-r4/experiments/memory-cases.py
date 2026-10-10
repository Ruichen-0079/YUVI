"""Synthetic HTTP cases adapted from the R3 private server-cases.py.
Use only an isolated Server/database. DATABASE_URL is inherited, never recorded.
The Server uses the existing R3 fetch recorder; this runner never scripts a model.
"""
import json, os, secrets, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

base, destination, phase = sys.argv[1:4]
root = Path(destination); root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
records = []

def save(name, value):
    path = root / name; path.write_text(json.dumps(value, ensure_ascii=False, indent=2)); path.chmod(0o600)

def sql(query, values=()):
    script = """import pg from 'pg';let b='';for await(const chunk of process.stdin)b+=chunk;const v=JSON.parse(b);const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();try{console.log(JSON.stringify((await c.query(v.query,v.values)).rows))}finally{await c.end()}"""
    result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(dict(query=query, values=values)), capture_output=True, text=True, check=True)
    return json.loads(result.stdout)

def req(path, body=None):
    start = time.monotonic()
    request = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=120) as response: status, output = response.status, json.load(response)
    except urllib.error.HTTPError as error: status, output = error.code, json.load(error)
    except Exception as error: status, output = None, {'transportError':type(error).__name__}
    records.append(dict(path=path, input=body, status=status, output=output, latencyMs=round((time.monotonic()-start)*1000)))
    save(phase+'-requests.json',records)
    return status,output

def say(subject, label, text, write=False):
    status,out=req('/message',dict(sessionId=subject+'-'+phase+'-'+label,text=text,subjectUserId=subject,options=dict(readMemory=True,writeMemory=write,voiceOutput=False,promptPreview=True)))
    print(json.dumps(dict(subject=subject,label=label,status=status,answer=out.get('payload',{}).get('content'),error=out.get('error')),ensure_ascii=False),flush=True)
    return status,out

def ledger(subject):
    return sql('select t.*, e.status as event_status, e.backend_memory_id, e.event_payload from finalized_ingestion_turns t left join finalized_ingestion_events e using(finalized_turn_id) where subject_user_id=$1 order by t.created_at,e.created_at',[subject])

def wait(subject, text):
    for _ in range(60):
        rows=sql('select t.* from finalized_ingestion_turns t join conversation_messages m on m.id=t.source_user_event_id where t.subject_user_id=$1 and m.content=$2 order by t.created_at desc limit 1',[subject,text])
        if rows and rows[0]['status'] in ['complete','skipped','terminal_failed']:
            records.append(dict(path='ledger-wait',input=dict(subject=subject,text=text),output=rows[0]));save(phase+'-requests.json',records);return rows[0]
        time.sleep(.5)
    raise RuntimeError('Formal ingestion did not finish; pending is not success')

def expire_l1(subject):
    # Controlled synthetic TTL expiry, preserving Journal and Conversation history.
    sql("update recent_episodes set expires_at='2020-01-01',status='expired' where subject_user_id=$1",[subject])

if phase == 'initial':
    trial_id=secrets.token_hex(4)
    trials=[]
    patterns=[lambda a,b:f'刚才我把编辑器的代号说错了。实际用的是{b}，{a}那条记录不对了。',
              lambda a,b:f'不是{a}，我现在实际使用的编辑器代号是{b}。之前那份信息记错了。',
              lambda a,b:f'I gave you the wrong editor code earlier. I actually use {b}, not {a}. Please retain this correction.']
    for index,pattern in enumerate(patterns):
        a='A-'+secrets.token_hex(4);b='B-'+secrets.token_hex(4);subject=f'r4-synthetic-{trial_id}-{index}'
        initial=f'请记住：本次隔离实验中，我使用的编辑器代号是{a}。';correct=pattern(a,b)
        trial=dict(subject=subject,a=a,b=b,initial=initial,correction=correct);trials.append(trial);save('trials.json',trials)
        trial['initialResponse']=say(subject,'store',initial,True)[0];trial['initialLedger']=wait(subject,initial)
        trial['recallA']=say(subject,'recall-a','我的编辑器代号是什么？只按你实际保存的记忆回答。')[1].get('payload',{}).get('content')
        trial['correctionResponse']=say(subject,'correct',correct,True)[0];trial['correctionLedger']=wait(subject,correct)
        expire_l1(subject)
        trial['recallB']=say(subject,'recall-b','我目前使用什么编辑器代号？旧代号还有效吗？')[1].get('payload',{}).get('content')
        trial['ledger']=ledger(subject);save('trials.json',trials)
    first=trials[0];subject=first['subject'];a=first['a'];b=first['b'];q='Q-'+secrets.token_hex(4)
    quote=f'我在引用这句话："请把{b}改成{q}"。我只是在讨论它的措辞，没有提出真实纠正。'
    say(subject,'quotation',quote,True);wait(subject,quote)
    hypo=f'假设我的编辑器是{q}，应该如何表达把{b}改成{q}？这是假设。'
    say(subject,'hypothetical',hypo,True);wait(subject,hypo)
    expire_l1(subject);say(subject,'negative-recall','我实际使用的编辑器代号是什么？')
    person_y=dict(subject=f'r4-synthetic-{trial_id}-person-y',a=a,initial=f'请记住：本次隔离实验中，我使用的编辑器代号是{a}。')
    say(person_y['subject'],'store',person_y['initial'],True);wait(person_y['subject'],person_y['initial']);expire_l1(person_y['subject']);save('person-y.json',person_y)
    conflict_subject=f'r4-synthetic-{trial_id}-conflict';conflict=[]
    for name in ['C-'+secrets.token_hex(4),'D-'+secrets.token_hex(4)]:
        text=f'请记住：我使用的编辑器代号是{name}。';say(conflict_subject,name,text,True);wait(conflict_subject,text);conflict.append(name)
    expire_l1(conflict_subject);say(conflict_subject,'recall-conflict','我的编辑器代号是什么？如果记忆存在冲突，请说明来源，别擅自确定唯一答案。')
    save('conflict.json',dict(subject=conflict_subject,values=conflict,ledger=ledger(conflict_subject)))
    save('negative-ledger.json',ledger(subject))
elif phase == 'restart':
    trials=json.loads((root/'trials.json').read_text())
    for trial in trials:
        expire_l1(trial['subject']);say(trial['subject'],'recall-restart','我目前使用什么编辑器代号？旧代号还有效吗？')
    y=json.loads((root/'person-y.json').read_text());say(y['subject'],'person-isolation','我使用的编辑器代号是什么？')
elif phase in ['failure','failure-retry']:
    fault_path = os.environ.get('R4_FAULT_FILE')
    if not fault_path: raise RuntimeError('Failure cases require an isolated fetch recorder R4_FAULT_FILE')
    subject='r4-synthetic-failure-'+secrets.token_hex(4)
    a='F-A-'+secrets.token_hex(4); b='F-B-'+secrets.token_hex(4)
    initial=f'请记住：本次隔离实验中，我使用的编辑器代号是{a}。'
    correction=f'刚才说错了，我实际用的是{b}，{a}是错误信息。请记住这个纠正。'
    if phase == 'failure-retry':
        previous=json.loads((root/'failure.json').read_text());subject=previous['subject'];a=previous['a'];b=previous['b'];initial=previous['initial'];initial_ledger=previous['initialLedger']
        correction=f'之前提供的{a}是错误信息，我实际用的是{b}，请记住这个更正。'
    else:
        say(subject,'store',initial,True); initial_ledger=wait(subject,initial)
    scope='yuvi:v1:user:'+subject+':character:character-instance%3Ar4-isolated'
    fault=Path(fault_path);fault.write_text(json.dumps(dict(scope=scope)));fault.chmod(0o600)
    try:
        status,out=say(subject,'correction-write-rejected',correction,True)
        failed=wait(subject,correction)
    finally: fault.unlink(missing_ok=True)
    expire_l1(subject)
    status,recall=say(subject,'recall-after-failed-write','我的编辑器代号是什么？请只根据实际持久保存的记忆回答。')
    save(phase+'.json',dict(subject=subject,a=a,b=b,initial=initial,correction=correction,initialLedger=initial_ledger,failureLedger=failed,correctionResponse=out,recall=recall,ledger=ledger(subject)))
else:
    raise ValueError('phase must be initial, restart or failure')
