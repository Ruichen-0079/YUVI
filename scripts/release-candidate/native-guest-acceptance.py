#!/usr/bin/env python3
"""Run only inside the disposable Debian RC guest; stdlib, actual packaged launcher/WebView."""
import os, json, time, pathlib, subprocess, urllib.request, urllib.parse, threading, http.server, base64, traceback, sys
ROOT=pathlib.Path('/home/tester/rc-evidence'); ROOT.mkdir(exist_ok=True)
PACKAGE=pathlib.Path('/home/tester/yuvi')
MODE=sys.argv[1] if len(sys.argv)>1 else 'install'
checks=[]; transcripts=[]
def passed(s):
    checks.append(s); print('PASS',s,flush=True)
def wait(fn, good=lambda x:bool(x), label='condition', timeout=90):
    end=time.monotonic()+timeout; last=None
    while time.monotonic()<end:
        try:
            last=fn()
            if good(last): return last
        except Exception as e: last=str(e)
        time.sleep(.25)
    raise RuntimeError('Timeout '+label+': '+str(last)[:1200])
class Model(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        try:
            b=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path.endswith('/embeddings'):
                values=b['input'] if isinstance(b['input'],list) else [b['input']]
                result={'data':[{'index':i,'embedding':[0.1]+[0.0]*1535} for i in range(len(values))], 'usage':{'prompt_tokens':1,'total_tokens':1},'model':b.get('model','fixture')}
                data=json.dumps(result).encode(); self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(data);return
            if b.get('stream') and any('RC_UNKNOWN_PROBE' in str(m.get('content','')) for m in b.get('messages',[])):
                count=ROOT/'fixture-unknown-dispatches.json'
                calls=json.loads(count.read_text()) if count.exists() else []
                calls.append({'receivedAt':time.time(),'fixture':True});count.write_text(json.dumps(calls))
                marker=ROOT/'fixture-unknown-accepted.json'
                assert not marker.exists(), 'An unresolved accepted effect was dispatched twice'
                marker.write_text(json.dumps({'accepted':True,'fixture':True,'receivedAt':time.time()}))
                time.sleep(120);return
            system=b.get('messages',[{}])[0].get('content',''); current=b.get('messages',[{}])[-1].get('content',''); whole=json.dumps(b.get('messages'))
            assert not any(p in whole for p in ['ydc_','yno_','yuh_'])
            if 'Evaluate every source for useful long-term memory' in system:
                x=json.loads(current); value=next((c for c in ['amber-gold','forest-green','lake-blue'] if c in x['source'].split('not ')[0]),'lake-blue')
                old=next((p for p in x['prior'] if value not in p['content'] and 'favorite color' in p['content']),None)
                ps=[]
                if 'favorite color' in x['source'] and not x['source'].rstrip().endswith('?'):
                    ps=[{'content':'My favorite color is '+value+'.','evidenceText':x['source'],'relation':'supersedes' if old is not None else 'new','targetIds':[old['id']] if old is not None else []}]
                answer=json.dumps({'propositions':ps})
            elif 'Decompose the untrusted question' in system:
                x=json.loads(current);answer=json.dumps({'needs':[{'quote':x['question'],'queries':['favorite color']}]})
            elif 'Evaluate whether each untrusted question' in system:
                x=json.loads(current);answer=json.dumps({'needs':[{**n,'verdict':'SUPPORTED' if x['claims'] else 'INSUFFICIENT','citations':[{'id':c['id'],'quote':c['text']} for c in x['claims'][:1]]} for n in x.get('needs',[{'id':'q0','quote':x['question']}])]})
            elif 'disposition' in system.lower(): answer='{"disposition":"RESPOND"}'
            else: answer='Your current favorite color is forest-green, from your correction.' if 'forest-green' in whole else 'Your statement was received; memory formation is verified separately.'
            transcripts.append({'model':b.get('model'),'input':b.get('messages'),'answer':answer,'fixture':True})
            usage={'prompt_tokens':50,'completion_tokens':20,'total_tokens':70}
            base={'id':'fixture-'+str(len(transcripts)),'created':int(time.time()),'model':b.get('model','fixture')}
            self.send_response(200)
            if b.get('stream'):
                self.send_header('Content-Type','text/event-stream');self.end_headers()
                for chunk in [{**base,'object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','content':answer},'finish_reason':None}]},{**base,'object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':usage}]: self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
            else:
                self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({**base,'object':'chat.completion','choices':[{'index':0,'message':{'role':'assistant','content':answer},'finish_reason':'stop'}],'usage':usage}).encode())
        except Exception:
            traceback.print_exc(); self.send_error(500)
model=http.server.ThreadingHTTPServer(('127.0.0.1',18085),Model);threading.Thread(target=model.serve_forever,daemon=True).start()
def wd(route,body=None,method=None):
    req=urllib.request.Request('http://127.0.0.1:4444'+route,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'},method=method or ('POST' if body is not None else 'GET'))
    try:
        with urllib.request.urlopen(req,timeout=120) as r: result=json.load(r)
    except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode())
    v=result.get('value');
    if isinstance(v,dict) and v.get('error'):raise RuntimeError(str(v))
    return v
# A restored headless OS may ask to unlock its original encrypted login keyring.
# Enter only this public Fixture password through the real OS dialog, never bypass Secret Service.
def unlock_fixture_keyring():
    assert os.uname().nodename=='yuvi-rc' and pathlib.Path.home()==pathlib.Path('/home/tester')
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        wins=subprocess.run(['xdotool','search','--onlyvisible','--name','^Unlock Login Keyring$'],capture_output=True,text=True).stdout.splitlines()
        for win in wins:
            try:
                pid=subprocess.check_output(['xdotool','getwindowpid',win],text=True).strip()
                if b'gcr-prompter' not in pathlib.Path('/proc/'+pid+'/cmdline').read_bytes():continue
                subprocess.run(['xdotool','windowfocus','--sync',win],check=True)
                subprocess.run(['xdotool','type','--window',win,'--clearmodifiers','synthetic-test-keyring-password'],check=True)
                subprocess.run(['xdotool','key','--window',win,'Return'],check=True)
                print('OS login keyring unlocked through its native dialog using the known synthetic test password',flush=True)
                return
            except (OSError,subprocess.CalledProcessError):pass
        time.sleep(.25)
threading.Thread(target=unlock_fixture_keyring,daemon=True).start()
session=None; fault_socket=None; original_version=None
def script(s,args=[]):return wd('/session/'+session+'/execute/sync',{'script':s,'args':args})
def text():return script('return document.body.innerText')
def click(label):return script("const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===arguments[0]);if(!b||b.disabled)throw Error('Unavailable '+arguments[0]);b.click();return true;",[label])
def fill(selector,value):return script("const e=document.querySelector(arguments[0]);if(!e)throw Error('Absent '+arguments[0]);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));return true;",[selector,value])
def confirm():
    raw=wait(lambda:subprocess.run(['xdotool','search','--onlyvisible','--name','YUVI · 本机身份确认'],capture_output=True,text=True).stdout.strip(),label='native consent')
    for win in raw.splitlines():
        pid=int(subprocess.check_output(['xdotool','getwindowpid',win])); env=pathlib.Path('/proc/'+str(pid)+'/environ').read_bytes()
        assert b'/YUVI/portable/' in env and b'/home/tester/' in env
        subprocess.run(['xdotool','windowfocus','--sync',win],check=True)
        subprocess.run(['xdotool','key','--window',win,'--clearmodifiers','Right','Return'],check=True)
        wait(lambda:subprocess.run(['xdotool','getwindowgeometry',win],capture_output=True).returncode,lambda x:x!=0,'dialog closes')
def screenshot(name): subprocess.run(['scrot',str(ROOT/(name+'.png'))],check=True)
def native(command,args={}):return script('return window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]);',[command,args])
def api(path,body=None):
    a={'path':path,'method':'GET' if body is None else 'POST'}
    if body is not None:a['body']=body
    r=native('native_product_request',a);assert r['status']==200,r
    return json.loads(r['body'])
def send(msg):
    before=text().count('Your ')
    fill('textarea',msg)
    script("const e=document.querySelector('textarea');const b=e.closest('form')?.querySelector('button[type=submit]')||document.querySelector('[aria-label=\"Send message\"],[aria-label=\"发送消息\"]');if(!b||b.disabled)throw Error('Send unavailable');b.click();return true;")
    wait(lambda:text(),lambda s:s.count('Your ')>before,'chat reply')
try:
    wait(lambda:wd('/status'),label='driver')
    start=time.monotonic()
    if MODE=='pg-conflict':
        import socket
        fault_socket=socket.socket();fault_socket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);fault_socket.bind(('127.0.0.1',55432));fault_socket.listen()
    if MODE=='major-mismatch':
        version_file=pathlib.Path('/home/tester/.local/share/YUVI/portable/0.1.2/data/Postgres/data/PG_VERSION')
        original_version=version_file.read_bytes();assert original_version.strip()==b'16'
        version_file.write_bytes(b'15\n')
    s=wd('/session',{'capabilities':{'alwaysMatch':{'tauri:options':{'application':str(PACKAGE/'yuvi'),'args':[]}}}});session=s['sessionId']
    wait(text,lambda t:'确认本机所有权' in t or '当前身份' in t or '以 RC Synthetic 进入' in t,'native window')
    window_seconds=time.monotonic()-start
    screenshot('first-window')
    if MODE in ('pg-conflict','major-mismatch','keyring-unavailable'):
        view=wait(lambda:native('native_product_activation',{'action':'status'}),lambda v:v.get('serviceUnavailable') and v.get('memoryConfigured'),'closed configured identity')
        wait(text,lambda t:'已启用本机记忆，身份服务暂不可用' in t,'unavailable is not first run')
        time.sleep(5)
        assert not pathlib.Path('/home/tester/.local/share/YUVI/portable/0.1.2/data/Postgres/data/postmaster.pid').exists()
        try:api('/host/v1/product/status');raise AssertionError('Unavailable private Host accepted')
        except RuntimeError:pass
        if MODE=='major-mismatch':assert version_file.read_bytes()==b'15\n'
        screenshot('fault-'+MODE)
        passed('Actual packaged '+MODE+' refuses private access and never overwrites or starts the cluster')
        (ROOT/('result-'+MODE+'.json')).write_text(json.dumps({'status':'PASS','checks':checks,'seconds':time.monotonic()-start},indent=2))
        sys.exit(0)
    if MODE=='install':
        assert not pathlib.Path('/usr/bin/node').exists() and not pathlib.Path('/usr/bin/psql').exists()
        passed('Fresh Debian VM has no system Node/PG; actual release launcher owns its services')
        click('确认本机所有权');confirm();wait(text,lambda t:'配置对话服务' in t,'ownership')
        script("document.querySelector('.native-provider-setup').open=true")
        for label,value in [('服务地址','http://127.0.0.1:18085/v1'),('对话模型','fixture-chat'),('推理模型','fixture-reasoning'),('服务密钥','synthetic-fixture-only')]:fill('input[aria-label="'+label+'"]',value)
        click('保存对话服务');confirm();confirm();wait(text,lambda t:'服务设置已保存' in t,'configured provider')
        passed('Empty first run uses native ownership and normal settings/Secret Service; no pre-created Person or configuration')
        click('启用本机记忆');confirm();wait(lambda:native('native_product_activation',{'action':'status'}),lambda v:not v.get('serviceUnavailable',False),'private PG migrations and R5',timeout=120)
        passed('Native opt-in initializes bundled private PG and all migrations through the owned Supervisor')
    if MODE in ('install','activate'):
        wait(lambda:script("return ![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='启用本机记忆')"),label='owned private Runtime ready',timeout=120)
        fill('input[aria-label="你的名字"]','RC Synthetic');click('创建我的身份');confirm();wait(text,lambda t:'以 RC Synthetic 进入' in t,'A9 Person create')
        click('以 RC Synthetic 进入');confirm();wait(text,lambda t:'当前身份：RC Synthetic' in t,'restricted native Host')
        passed('Normal native creation selects the synthetic Person and a restricted Product Host')
    elif MODE not in ('install','activate'):
        wait(text,lambda t:'切换身份' in t or '以 RC Synthetic 进入' in t,'existing identity ready')
        if '以 RC Synthetic 进入' in text():click('以 RC Synthetic 进入');confirm()
    wait(text,lambda t:'切换身份' in t,'active')
    click('聊天')
    wait(lambda:script("return Boolean(document.querySelector('textarea'))"),label='actual chat surface ready')
    ready_seconds=time.monotonic()-start
    status=api('/host/v1/product/status'); scope='yuvi:v1:user:'+urllib.parse.quote(status['personId'],safe='')+':character:'+urllib.parse.quote(status['personaId'],safe='')
    if MODE=='diagnose':
        import runpy
        q=runpy.run_path('/home/tester/guest-db.py')['sql']
        print(q("select json_build_object('jobs',(select json_agg(t) from (select status,result,error_code,provider_model from memory_semantic_jobs)t))"),flush=True)
    current=lambda:api('/memory/v1/current?'+urllib.parse.urlencode({'scope':scope}))
    if MODE.startswith('managed-'):
        import runpy
        runpy.run_path('/home/tester/managed-lifecycle.py')['run'](MODE,native,api,scope,send,fill,script,wait)
        session=None
        sys.exit(0)
    if MODE in ('pg-crash','supervisor-crash'):

        import runpy,signal
        lab=pathlib.Path('/home/tester/.local/share/YUVI/portable/0.1.2')
        baseline=runpy.run_path('/home/tester/guest-db.py')['capture']()
        assert any('forest-green' in r['event']['content'] for r in current().get('records',[]))
        snapshot=native('get_service_status')
        runtime=next(x for x in snapshot['services'] if x['id']=='runtime')
        pgpid=int((lab/'data/Postgres/data/postmaster.pid').read_text().splitlines()[0])
        pgcmd=pathlib.Path('/proc/'+str(pgpid)+'/cmdline').read_bytes()
        assert b'/home/tester/yuvi/postgres/bin/postgres' in pgcmd and str(lab/'data/Postgres/data').encode() in pgcmd
        if MODE=='pg-crash':
            os.kill(pgpid,signal.SIGKILL)
            def closed():
                try:api('/memory/v1/current?'+urllib.parse.urlencode({'scope':scope}));return False
                except (RuntimeError,AssertionError):return True
            wait(closed,label='private API refuses disconnected PG',timeout=30)
            passed('SIGKILL of the owned private PG produces private API refusal, not successful empty knowledge')
            screenshot('fault-'+MODE)
            observations={'privateApiRefused':True}
        else:
            pointer=json.loads((lab/'supervisor/active-instance.json').read_text())
            supervisorpid=pointer['pid']
            assert b'/home/tester/yuvi/supervisor/yuvi-desktop-supervisor.cjs' in pathlib.Path('/proc/'+str(supervisorpid)+'/cmdline').read_bytes()
            os.kill(supervisorpid,signal.SIGKILL)
            wait(lambda:not pathlib.Path('/proc/'+str(supervisorpid)).exists(),label='supervisor process death')
            time.sleep(2)
            observations={'survivingOwnedProcesses':[]}
            for label,pid,expected in [('runtime',runtime['pid'],b'/home/tester/yuvi/runtime/yuvi-runtime-server.mjs'),('postgres',pgpid,b'/home/tester/yuvi/postgres/bin/postgres')]:
                try:
                    if expected in pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes():observations['survivingOwnedProcesses'].append({'service':label,'pid':pid})
                except FileNotFoundError:pass
            passed('Owned Supervisor SIGKILL observed; surviving child processes recorded without assuming automatic recovery')
            session=None
        (ROOT/('database-before-'+MODE+'.json')).write_text(json.dumps(baseline,indent=2))
        (ROOT/('result-'+MODE+'.json')).write_text(json.dumps({'status':'INJECTED_REQUIRES_RESTART_VERIFICATION','checks':checks,'observations':observations},indent=2))
        sys.exit(0)
    if MODE in ('install','activate','diagnose'):
        send('Please remember: my favorite color is lake-blue.')
        wait(current,lambda x:any('lake-blue' in r['event']['content'] for r in x.get('records',[])),'R5 fact',timeout=120)
        passed('Actual native chat flows through bundled Character/Journal/Worker to R5')
        send('Correction: my favorite color is forest-green, not lake-blue.')
        wait(current,lambda x:any('forest-green' in r['event']['content'] for r in x.get('records',[])),'R5 correction',timeout=120)
        passed('Natural correction supersedes the previous fact through the same product entry')
    elif MODE!='seal':
        if MODE=='reopen-managed':
            import runpy
            before=json.loads((ROOT/'before-last-managed-fault.json').read_text())
            after=runpy.run_path('/home/tester/guest-db.py')['capture']()
            assert before['identity']==after['identity']
            for table,rows in before['immutableRows'].items():
                assert all(after['immutableRows'][table].get(k)==v for k,v in rows.items()), 'Historical row changed: '+table
            assert all(after['completedIngestion'].get(k)==v for k,v in before['completedIngestion'].items())
            if (ROOT/'unresolved-at-backup.json').exists():
                q=runpy.run_path('/home/tester/guest-db.py')['sql']
                assert len(json.loads((ROOT/'fixture-unknown-dispatches.json').read_text()))==1
                for probe in json.loads((ROOT/'unresolved-at-backup.json').read_text()):
                    import re
                    assert re.fullmatch(r'ea1_[a-f0-9]{64}',probe['attempt_id'])
                    assert q("select count(*) from effect_observations where attempt_id='"+probe['attempt_id']+"' and category='TERMINAL' and evidence->>'certainty'='APPLIED'")=='0'
                passed('Accepted unresolved effect remains un-replayed and is never rewritten as APPLIED')
            passed('Managed crash preserves old immutable rows, Person, owner, creation receipts and completed ingestion')
        if MODE=='restore':
            import runpy
            before=json.loads(pathlib.Path('/home/tester/cold-seal.json').read_text())['snapshot']
            after=runpy.run_path('/home/tester/guest-db.py')['capture']()
            assert before['identity']==after['identity'], 'Person/owner/creation receipt changed'
            assert all(after['completedIngestion'].get(k)==v for k,v in before['completedIngestion'].items()), 'Completed user input was ingested again'
            for table,rows in before['immutableRows'].items():
                assert all(after['immutableRows'][table].get(k)==v for k,v in rows.items()), 'Historical row changed: '+table
            old=json.loads((ROOT/'revoked-credential.private.json').read_text())
            req=urllib.request.Request('http://127.0.0.1:16121/host/v1/product/status',headers={'Cookie':old['cookie'],'Origin':old['origin']})
            try:urllib.request.urlopen(req);raise AssertionError('Revoked credential revived')
            except urllib.error.HTTPError as e:assert e.code==401
            probes=json.loads((ROOT/'unresolved-at-backup.json').read_text())
            assert len(json.loads((ROOT/'fixture-unknown-dispatches.json').read_text()))==1
            q=runpy.run_path('/home/tester/guest-db.py')['sql']
            for probe in probes:
                import re
                assert re.fullmatch(r'ea1_[a-f0-9]{64}',probe['attempt_id'])
                assert q("select count(*) from effect_observations where attempt_id='"+probe['attempt_id']+"' and category='TERMINAL' and evidence->>'certainty'='APPLIED'")== '0'
            passed('Unresolved accepted dispatch is not replayed and is never rewritten as APPLIED')
            passed('Restored Person, native owner, creation receipts, Journal and A9 evidence are identical; revoked Host remains 401')
            (ROOT/'restore-comparison.json').write_text(json.dumps({'status':'PASS','verifiedOldRows':{k:len(v) for k,v in before['immutableRows'].items()},'identityUnchanged':True,'oldHostStatus':401},indent=2))
        if MODE in ('restore','reopen-managed'):
            script("for(const key of Object.keys(localStorage)){if(key.startsWith('yuvi.conversation-session.'))localStorage.removeItem(key)};location.reload();return true;")
            wait(text,lambda t:'切换身份' in t and 'Please remember:' not in t,'new conversation after restore')
            click('聊天')
            wait(lambda:script("return Boolean(document.querySelector('textarea'))"),label='fresh chat surface mounted')
        records=wait(current,lambda v:any('forest-green' in r['event']['content'] for r in v.get('records',[])),label='committed corrected current after recovery (production event lease may be 300s)',timeout=420)
        send('What is my favorite color?'); wait(text,lambda t:'Your current favorite color is forest-green' in t,'persistent recall')
        if MODE in ('restore','reopen-managed'):
            last=next(x for x in reversed(transcripts) if x['model']=='fixture-chat')
            assert 'forest-green' in last['input'][0]['content'], 'Recall did not receive actual R5 context'
            assert not any(m.get('role')=='user' and ('Correction:' in str(m.get('content')) or 'Please remember:' in str(m.get('content'))) for m in last['input']), 'Recall leaked old conversation instead of a fresh session'
            passed('Fresh conversation receives the corrected R5 fact in its actual model context')
        passed('Existing Person and corrected R5 memory recover without re-creation; new native chat recalls the fact')
    if MODE=='seal':
        vault=pathlib.Path('/home/tester/.local/share/YUVI/portable/0.1.2/config/com.yuvi.companion/native-product/owner.json')
        old=json.loads(vault.read_text())
        cookie=ROOT/'revoked-credential.private.json'
        fd=os.open(cookie,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:json.dump({'cookie':old['cookie'],'origin':old['origin']},f)
        click('退出身份');wait(text,lambda t:'以 RC Synthetic 进入' in t and '切换身份' not in t,'native sign out')
        passed('Native logout revokes the final product Host before the cold backup')
        import runpy
        runpy.run_path('/home/tester/cold-seal.py',run_name='__main__')
        passed('Owned services stopped, PG control state is shut down, next launch refuses the recovery gate')
        (ROOT/'result-seal.json').write_text(json.dumps({'status':'PASS','checks':checks},indent=2))
        session=None
        sys.exit(0)
    if MODE=='crash':
        fill('textarea','RC_UNKNOWN_PROBE: acknowledge this synthetic execution probe.')
        script("const e=document.querySelector('textarea');const b=e.closest('form')?.querySelector('button[type=submit]')||document.querySelector('[aria-label=\"Send message\"],[aria-label=\"发送消息\"]');if(!b||b.disabled)throw Error('Send unavailable');b.click();return true;")
        wait(lambda:(ROOT/'fixture-unknown-accepted.json').exists(),label='provider accepted unresolved request')
        runtime=next(x for x in native('get_service_status')['services'] if x['id']=='runtime')
        assert runtime['ownership']=='owned' and b'/home/tester/yuvi/runtime/yuvi-runtime-server.mjs' in pathlib.Path('/proc/'+str(runtime['pid'])+'/cmdline').read_bytes()
        import signal
        os.kill(runtime['pid'],signal.SIGKILL)
        passed('Owned packaged Runtime killed after Fixture accepted a real provider dispatch; no external real-world side effect')
        import runpy
        q=runpy.run_path('/home/tester/guest-db.py')['sql']
        unresolved=json.loads(q("select coalesce(json_agg(t),'[]') from (select attempt_id,adapter,dispatch_started_at,(select evidence->>'certainty' from effect_observations o where o.attempt_id=a.attempt_id and category='TERMINAL' order by observation_id desc limit 1) certainty from effect_attempts a where dispatch_started_at is not null and not exists(select 1 from effect_observations o where o.attempt_id=a.attempt_id and category='TERMINAL'))t"))
        assert unresolved, 'No durable unresolved dispatch'
        (ROOT/'unresolved-at-backup.json').write_text(json.dumps(unresolved,indent=2))
    else:
        click('记忆');wait(text,lambda t:'forest-green' in t,'native Memory UI');screenshot('native-memory-'+MODE)
        passed('Same actual native window renders Authority current knowledge')
        click('历史与纠正');wait(text,lambda t:'My favorite color is lake-blue.' in t and 'superseded' in t,'historical correction')
        screenshot('native-history-'+MODE)
        passed('Native history retains the superseded fact and correction')
    import runpy
    database=runpy.run_path('/home/tester/guest-db.py')['capture']()
    (ROOT/('database-'+MODE+'.json')).write_text(json.dumps(database,indent=2))
    passed('Private PG application role is restricted; durable SQL and owner identity inventory captured')
    (ROOT/('result-'+MODE+'.json')).write_text(json.dumps({'status':'PASS','mode':MODE,'checks':checks,'personId':status['personId'],'personaId':status['personaId'],'scope':scope,'seconds':time.monotonic()-start,'windowSeconds':window_seconds,'authenticatedReadySeconds':ready_seconds},indent=2))
except Exception as e:
    try:(ROOT/('failure-view-'+MODE+'.txt')).write_text(text());screenshot('failure-'+MODE)
    except:pass
    (ROOT/('result-'+MODE+'.json')).write_text(json.dumps({'status':'FAIL','checks':checks,'error':str(e)},indent=2));raise
finally:
    (ROOT/('fixture-transcripts-'+MODE+'.json')).write_text(json.dumps(transcripts,indent=2))
    if session:
        try:wd('/session/'+session,method='DELETE')
        except:pass

    if fault_socket:fault_socket.close()
    if original_version is not None:version_file.write_bytes(original_version)
