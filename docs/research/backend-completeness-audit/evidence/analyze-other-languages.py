"""Read-only pinned-source syntax index. No execution of product code or configuration."""
import ast, hashlib, json, pathlib, re, subprocess, sys, tomllib
from importlib.metadata import version
from tree_sitter import Language, Parser
import tree_sitter_rust
from pglast import parse_sql, ast as pgast
ROOT=pathlib.Path(sys.argv[1]).resolve(); HERE=pathlib.Path(sys.argv[2]).resolve() if len(sys.argv)>2 else pathlib.Path(__file__).resolve().parent
inventory=json.loads((HERE/'source-inventory.json').read_text())
rust_parser=Parser(Language(tree_sitter_rust.language()))
records=[]; entries=[]; state_candidates=[]; boundaries=[]
for f in inventory['files']:
    if not f['production'] or f['language'] in ['TypeScript','TSX','JavaScript','JSX']: continue
    p=ROOT/f['gitPath']; body=p.read_bytes(); text=body.decode('utf8',errors='replace')
    r={'path':f['gitPath'],'language':f['language'],'parser':None,'completed':False,'parseErrors':[], 'imports':[], 'calls':[], 'declarations':[], 'entryCandidates':[], 'states':[], 'questions':[]}
    if f['language'] in ['Python','Python-build-spec']:
        r['parser']='Python ast '+sys.version.split()[0]
        try:
            tree=ast.parse(text,filename=f['gitPath'])
            for n in ast.walk(tree):
                line=getattr(n,'lineno',1)
                if isinstance(n,(ast.Import,ast.ImportFrom)):
                    r['imports'].append({'line':line,'module':getattr(n,'module',None),'names':[a.name for a in n.names], 'level':getattr(n,'level',0)})
                if isinstance(n,ast.Call):
                    callee=ast.unparse(n.func); r['calls'].append({'line':line,'callee':callee,'arguments':[ast.unparse(a)[:200] for a in n.args],'keywords':[k.arg for k in n.keywords],'resolution':'UNRESOLVED_PYTHON_DISPATCH'})
                if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
                    decorators=[ast.unparse(d) for d in n.decorator_list]
                    d={'line':line,'name':n.name,'kind':type(n).__name__,'decorators':decorators,'annotation':ast.unparse(n.returns) if hasattr(n,'returns') and n.returns else None};r['declarations'].append(d)
                    if n.name in ['do_GET','do_POST','do_PUT','do_DELETE','main'] or any(re.search(r'\.(get|post|put|delete|on_event|lifespan)',d) for d in decorators):
                        r['entryCandidates'].append({'id':f"py:{f['gitPath']}:{line}", 'path':f['gitPath'],'line':line,'kind':'PYTHON_ROUTE_OR_LIFECYCLE','function':n.name,'decorators':decorators})
                    if isinstance(n,ast.ClassDef):
                        fields=[{'name':ast.unparse(a.target),'annotation':ast.unparse(a.annotation)} for a in n.body if isinstance(a,ast.AnnAssign)]
                        r['states'].append({'id':f"pytype:{f['gitPath']}:{line}:{n.name}",'path':f['gitPath'],'line':line,'name':n.name,'kind':'PYTHON_CLASS_CANDIDATE','fields':fields})
            r['completed']=True
        except Exception as e:r['parseErrors'].append(str(e))
    elif f['language']=='Rust':
        r['parser']='tree-sitter-rust '+version('tree-sitter-rust'); tree=rust_parser.parse(body)
        def walk(n,test_only=False):
            source=body[n.start_byte:n.end_byte].decode('utf8',errors='replace'); line=n.start_point.row+1
            prev=n.prev_named_sibling; attrs=[]
            while prev and prev.type=='attribute_item':attrs.insert(0,body[prev.start_byte:prev.end_byte].decode());prev=prev.prev_named_sibling
            test=test_only or any('cfg(test)' in a or '#[test]' in a for a in attrs)
            if n.type in ['ERROR'] or n.is_missing:r['parseErrors'].append({'line':line,'type':n.type})
            if n.type in ['use_declaration','mod_item']:r['imports'].append({'line':line,'text':source[:500],'testOnly':test})
            if n.type in ['function_item','struct_item','enum_item','type_item']:
                name=n.child_by_field_name('name'); d={'line':line,'name':body[name.start_byte:name.end_byte].decode() if name else '?','kind':n.type,'attributes':attrs,'testOnly':test};r['declarations'].append(d)
                if not test and n.type in ['struct_item','enum_item','type_item']:r['states'].append({'id':f"rusttype:{f['gitPath']}:{line}:{d['name']}",'path':f['gitPath'],**d})
                if not test and (any('tauri::command' in a for a in attrs) or d['name'] in ['main','run']):r['entryCandidates'].append({'id':f"rust:{f['gitPath']}:{line}",'path':f['gitPath'],**d,'entryKind':'TAURI_COMMAND_OR_ENTRY'})
            if n.type in ['call_expression','macro_invocation'] and not test:
                fun=n.child_by_field_name('function') or n.child_by_field_name('macro');r['calls'].append({'line':line,'callee':body[fun.start_byte:fun.end_byte].decode() if fun else source[:120],'text':source[:500],'resolution':'UNRESOLVED_RUST_TYPE_OR_MACRO'})
            for child in n.named_children:walk(child,test)
        walk(tree.root_node);r['completed']=not tree.root_node.has_error
        r['questions'].append('Syntax tree only; cfg macros, trait dispatch and generated Tauri handlers not compiled on all target platforms')
    elif f['language']=='SQL':
        r['parser']='pglast '+version('pglast')
        try:
            statements=parse_sql(text)
            for s in statements:
                n=s.stmt; d={'kind':type(n).__name__,'location':s.stmt_location}
                rel=getattr(n,'relation',None)
                if rel:d['relation']=getattr(rel,'relname',None)
                if isinstance(n,pgast.CreateStmt):
                    name=n.relation.relname; fields=[{'name':e.colname,'type':'.'.join(x.sval for x in e.typeName.names)} for e in n.tableElts or [] if isinstance(e,pgast.ColumnDef)]
                    r['states'].append({'id':'sqltable:'+name,'path':f['gitPath'],'name':name,'kind':'DATABASE_TABLE','fields':fields})
                r['declarations'].append(d)
            r['completed']=True
        except Exception as e:r['parseErrors'].append(str(e))
    elif f['language']=='Shell':
        r['parser']='bash -n + literal external-operation index'; check=subprocess.run(['bash','-n',str(p)],capture_output=True,text=True);r['completed']=check.returncode==0
        if check.returncode:r['parseErrors'].append(check.stderr.strip())
        r['questions'].append('Syntax validated; shell expansion, sourced paths and platform tools require targeted manual traces')
    elif f['language'] in ['JSON','TOML']:
        r['parser']='json/tomllib'
        try:
            obj=json.loads(text) if f['language']=='JSON' else tomllib.loads(text);r['declarations']=[{'topLevelKeys':list(obj) if isinstance(obj,dict) else 'ARRAY'}];r['completed']=True
        except Exception as e:r['parseErrors'].append(str(e))
    elif f['language'] in ['Binary-asset','CSS','GLSL','HTML','XML','YAML','PowerShell','Batch','Dockerfile','Text','Dependency-lock','Env-template','UNKNOWN']:
        r['parser']='Metadata/literal index only';r['questions'].append('No full syntax/semantic analysis for this format in the current pass; retained in denominator')
    for i,line in enumerate(text.splitlines(),1) if f['language']!='Binary-asset' else []:
        if f['language'] in ['Shell','PowerShell','Batch','Dockerfile','YAML','Text','Env-template','Dependency-lock','UNKNOWN'] and re.search(r'(\b(exec|source|node|python|uvicorn|cargo|pnpm|Start-Process|Invoke-WebRequest|docker)\b|\$env:|process\.env|localhost|127\.0\.0\.1)',line):r['calls'].append({'line':i,'literal':line.strip()[:500],'resolution':'UNRESOLVED_LITERAL_HINT'})
    records.append(r);entries+=r['entryCandidates'];state_candidates+=r['states']
(HERE/'other-language-relations.json').write_text(json.dumps({'baselineSHA':inventory['baselineSHA'],'tools':{'python':sys.version.split()[0],'tree-sitter':version('tree-sitter'),'tree-sitter-rust':version('tree-sitter-rust'),'pglast':version('pglast')},'limitations':['Python dynamic dispatch, Rust traits/cfg/macros, shell expansion and cross-process bindings are not a complete resolved call graph','Unsupported syntaxes retain explicit pending status; metadata is not claimed as completed structural analysis'],'records':records,'entrypoints':entries,'states':state_candidates},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'files':len(records),'completed':sum(r['completed'] for r in records),'parseErrors':[{'path':r['path'],'errors':r['parseErrors']} for r in records if r['parseErrors']],'entryCandidates':len(entries),'stateCandidates':len(state_candidates)},ensure_ascii=False))
