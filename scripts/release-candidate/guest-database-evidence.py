#!/usr/bin/env python3
"""Read-only evidence for synthetic data inside the explicitly named disposable guest."""
import pathlib,os,subprocess,json,hashlib,hmac
assert os.uname().nodename=='yuvi-rc'
ROOT=pathlib.Path('/home/tester/.local/share/YUVI/portable/0.1.2');PKG=pathlib.Path('/home/tester/yuvi')
def sql(query,role='yuvi'):
 secret=subprocess.check_output(['secret-tool','lookup','service','YUVI-portable-0.1.2','username','YUVI/postgres/local'],text=True).strip()
 if role=='yuvi_runtime':secret=hmac.new(secret.encode(),b'yuvi.private-runtime-role.v1',hashlib.sha256).hexdigest()
 env={**os.environ,'PGPASSWORD':secret,'PGOPTIONS':'-c default_transaction_read_only=on'}
 port=json.loads((ROOT/'data/Postgres/runtime/listen.json').read_text())['port']
 return subprocess.check_output([str(PKG/'postgres/bin/psql'),'-XAtq','-h','127.0.0.1','-p',str(port),'-U',role,'-d','yuvi','-v','ON_ERROR_STOP=1','-c',query],env=env,text=True).strip()
def capture():
 tables=json.loads(sql("select json_agg(tablename order by tablename) from pg_tables where schemaname='public'"))
 # One read-only MVCC transaction for the SQL inventory. Nothing is imported or re-executed.
 selects=[]
 for t in tables:
  ident='"'+t.replace('"','""')+'"'
  selects.append("select json_build_object('table','"+t+"','count',count(*),'digest',md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' order by row_to_json(t)::text),''))) from "+ident+' t')
 inventory=[json.loads(x) for x in sql('begin isolation level repeatable read read only;'+ ';'.join(selects)+';commit;').splitlines()]
 immutable={}
 for t,key in [('memory_authority_records',"scope||'/'||id"),('journal_events',"journal_namespace||'/'||event_id"),('effect_observations',"observation_id::text")]:
  immutable[t]=json.loads(sql("select coalesce(json_object_agg(k,d),'{}') from (select "+key+" k,md5(row_to_json(t)::text) d from "+t+" t) s"))
 role=json.loads(sql("select row_to_json(t) from (select current_user,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,has_schema_privilege('public','CREATE') schema_create,has_table_privilege('memory_authority_records','UPDATE') rewrite_history,has_table_privilege('memory_authority_records','TRUNCATE') truncate_history,has_table_privilege('memory_authority_current','INSERT') projection_insert from pg_roles where rolname=current_user)t",'yuvi_runtime'))
 assert role['current_user']=='yuvi_runtime' and role['projection_insert'] and not any(role[x] for x in ['rolsuper','rolcreaterole','rolcreatedb','rolbypassrls','schema_create','rewrite_history','truncate_history'])
 settings=json.loads((ROOT/'config/product-settings.json').read_text());vault=json.loads((ROOT/'config/com.yuvi.companion/native-product/owner.json').read_text())
 identity={'people':settings['people'],'nativeOwnerDigest':hashlib.sha256(vault['ownerId'].encode()).hexdigest(),'ownerAssociations':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in settings.get('nativeOwnerByPersonId',{}).items()},'personAuthorityRevisionById':settings.get('personAuthorityRevisionById'), 'productCommandReceiptDigest':hashlib.sha256(json.dumps(settings.get('productCommandReceipts'),sort_keys=True).encode()).hexdigest()}
 completed=json.loads(sql("select coalesce(json_object_agg(finalized_turn_id,to_jsonb(t)),'{}') from (select finalized_turn_id,source_digest,status,attempt_count,complete_event_count,unchanged_event_count from finalized_ingestion_turns where status in ('complete','skipped'))t"))
 processes=[]
 for line in subprocess.check_output(['ps','-eo','comm=,rss=,pcpu='],text=True).splitlines():
  name,rss,cpu=line.split()
  if name in ('MainThread','postgres','yuvi-desktop') or name.startswith('WebKit'):
   processes.append({'comm':name,'rssKiB':int(rss),'lifetimeCpuPercent':float(cpu)})
 resources={'processes':processes,'rssSumIncludesSharedPages':True,'packageKiB':int(subprocess.check_output(['du','-sk',str(PKG)],text=True).split()[0]),'stateKiB':int(subprocess.check_output(['du','-sk',str(ROOT)],text=True).split()[0])}
 return {'resourceSample':resources,'completedIngestion':completed,'tables':inventory,'immutableRows':immutable,'role':role,'identity':identity,'effectCertainties':json.loads(sql("select coalesce(json_agg(t),'[]') from (select evidence->>'certainty' certainty,count(*) from effect_observations where category='TERMINAL' group by 1)t"))}
