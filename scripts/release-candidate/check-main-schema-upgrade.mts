/** Isolated schema rehearsal, not a binary downgrade or production migration. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { applySqlMigrations, readSqlMigrations } from '../../packages/memory/src/migrations.js';
const url=process.env.YUVI_MEMORY_R5_TEST_DATABASE_URL;
const output=process.argv[process.argv.indexOf('--output')+1];
if(!process.argv.includes('--run') || !url || !output?.startsWith('/')) throw Error('Explicit --run --output /absolute/evidence.json and isolated YUVI_MEMORY_R5_TEST_DATABASE_URL required');
const target=new URL(url);
if(!['127.0.0.1','localhost'].includes(target.hostname)||!/^\/(?:yuvi_smoke|yuvi_rc_[a-z0-9_]+)$/.test(target.pathname)) throw Error('Only explicit loopback synthetic test databases are allowed');
const main=execFileSync('git',['rev-parse','origin/main'],{encoding:'utf8'}).trim();
const paths=execFileSync('git',['ls-tree','--name-only',main,'packages/memory/migrations/'],{encoding:'utf8'}).trim().split('\n').filter(p=>p.endsWith('.sql')).sort();
if(paths.length!==25)throw Error('This rehearsal supports the verified main 001–025 boundary only');
const old=paths.map(p=>({name:p.split('/').at(-1)!,sql:execFileSync('git',['show',main+':'+p],{encoding:'utf8'})}));
const latest=await readSqlMigrations();
if(latest.length!==45 || old.some((m,i)=>m.name!==latest[i]?.name||m.sql!==latest[i]?.sql))throw Error('Applied historical migration changed or unsupported candidate schema');
const schema='rc_upgrade_'+randomUUID().replaceAll('-','');
const admin=new pg.Pool({connectionString:url});
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema},public`});
try {
 await admin.query(`create schema ${schema}`);
 const first=await applySqlMigrations(pool,old);
 await pool.query("insert into memories(type,source,content,subject_user_id,persona_id,metadata) values('semantic','synthetic-main','Legacy retained RC fixture','rc-person','rc-persona','{}')");
 const upgraded=await applySqlMigrations(pool,latest);
 const repeated=await applySqlMigrations(pool,latest);
 const counts=(await pool.query('select (select count(*) from yuvi_schema_migrations)::int migrations,(select count(*) from memories)::int legacy,(select count(*) from memory_authority_records)::int authority')).rows[0];
 if(counts.migrations!==45||counts.legacy!==1||counts.authority!==0||repeated.length)throw Error('Upgrade receipts, legacy retention or idempotency failed');
 let failed=false;
 try {await applySqlMigrations(pool,[{name:'999_rc_fault.sql',sql:"create table rc_uncommitted(x int);do $$ begin raise exception 'RC_FAULT';end $$;"}]);}
 catch(e){if(!String(e).includes('RC_FAULT'))throw e;failed=true;}
 const rollback=(await pool.query("select to_regclass('rc_uncommitted') is null as no_partial_table,not exists(select 1 from yuvi_schema_migrations where name='999_rc_fault.sql') as no_false_receipt")).rows[0];
 if(!failed||!rollback.no_partial_table||!rollback.no_false_receipt)throw Error('Failed migration did not roll back atomically');
 const evidence={schema:'yuvi.rc-schema-rehearsal.v1',status:'PASS',main,candidate:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),initial:first.length,upgraded:upgraded.length,repeated:repeated.length,counts,rollback,
 migrations:latest.map(m=>({name:m.name,sha256:createHash('sha256').update(m.sql).digest('hex')})),
 limitations:['Current runner applied historical main SQL, not an old installed binary upgrade','No automatic activation of legacy assets','No post-execution rollback, PITR or production migration authorization']};
 await writeFile(output,JSON.stringify(evidence,null,2));console.log('PASS main 001–025 → candidate 045, repeat, retained legacy and atomic migration failure');
} finally {await pool.end();await admin.query(`drop schema if exists ${schema} cascade`);await admin.end();}
