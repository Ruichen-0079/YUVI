import { createRequire, builtinModules } from 'node:module';
import { resolve,dirname,join,relative } from 'node:path';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
const here=process.argv[3]?resolve(process.argv[3]):dirname(new URL(import.meta.url).pathname),repo=resolve(process.argv[2]);
const ts=createRequire(join(repo,'package.json'))('typescript');
const inv=JSON.parse(readFileSync(join(here,'source-inventory.json'),'utf8'));
const candidates=inv.files.filter(f=>f.production&&['TypeScript','TSX','JavaScript','JSX'].includes(f.language));
const roots=candidates.map(f=>join(repo,f.gitPath));
const config=ts.readConfigFile(join(repo,'tsconfig.base.json'),ts.sys.readFile).config;
const opts=ts.convertCompilerOptionsFromJson(config.compilerOptions,repo).options;
Object.assign(opts,{allowJs:true,checkJs:false,noEmit:true});
const host=ts.createCompilerHost(opts);
function modulePath(spec,from) {
  if (spec.startsWith('.') && existsSync(resolve(dirname(from),spec))) return resolve(dirname(from),spec);
  if (spec.startsWith('/src/') && existsSync(join(repo,'apps/web',spec))) return join(repo,'apps/web',spec);
  if(spec.startsWith('@companion/')) {
    const [pkg,...sub]=spec.slice(11).split('/'),folder=join(repo,'packages',pkg),manifest=join(folder,'package.json');
    if(existsSync(manifest)) {
      const ex=JSON.parse(readFileSync(manifest,'utf8')).exports?.[sub.length?'./'+sub.join('/'):'.'];
      const target=typeof ex==='string'?ex:ex?.development??ex?.import;
      if(target) {const p=resolve(folder,target);if(existsSync(p))return p;}
    }
  }
  return ts.resolveModuleName(spec,from,opts,host).resolvedModule?.resolvedFileName;
}
host.resolveModuleNames=(names,containing)=>names.map(spec=>{const p=modulePath(spec,containing);return p?{resolvedFileName:p,isExternalLibraryImport:p.includes('/node_modules/'),extension:p.endsWith('.tsx')?ts.Extension.Tsx:p.endsWith('.ts')?ts.Extension.Ts:ts.Extension.Js}:undefined;});
const program=ts.createProgram(roots,opts,host),checker=program.getTypeChecker();
const records=[],allImports=[],allCalls=[],typeDeclarations=[],typeUses=[],entrypoints=[];
const rel=p=>relative(repo,p).replaceAll('\\','/');
const tracked=new Set(inv.files.map(f=>f.gitPath));
const loc=(node,sf)=>({path:rel(sf.fileName),line:sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1});
const declTarget=d=>d?{...loc(d,d.getSourceFile()),name:d.name?.getText(d.getSourceFile())??'(anonymous)',kind:ts.SyntaxKind[d.kind],container:d.parent?.name?.getText(d.getSourceFile())??null}:null;
const txt=(n,sf,max=200)=>n?.getText(sf).slice(0,max)??null;
const shape=(n,sf)=>({...(
  ts.isObjectLiteralExpression(n)?{kind:'OBJECT',fields:n.properties.map(p=>p.name?.getText(sf)??(ts.isSpreadAssignment(p)?'...spread':'computed'))}:ts.isArrowFunction(n)||ts.isFunctionExpression(n)?{kind:'CALLBACK',line:loc(n,sf).line}:ts.isStringLiteralLike(n)?{kind:'STRING',value:n.text.slice(0,240)}:{kind:ts.SyntaxKind[n.kind],expression:txt(n,sf,150)}),
  inferredType:checker.typeToString(checker.getTypeAtLocation(n)).slice(0,600)});
for(const f of candidates) {
  const sf=program.getSourceFile(join(repo,f.gitPath));if(!sf)throw Error('No source file '+f.gitPath);
  const imports=[],calls=[],decls=[],uses=[],entries=[];
  function visit(n,owner='MODULE') {
    let next=owner;
    if(ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isConstructorDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n))
      next=(n.name?.getText(sf)??(ts.isConstructorDeclaration(n)?'constructor':'callback'))+'@'+loc(n,sf).line;
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteralLike(n.moduleSpecifier)) {
      const spec=n.moduleSpecifier.text,p=modulePath(spec,sf.fileName);
      const e={...loc(n,sf),kind:ts.isImportDeclaration(n)?'IMPORT':'REEXPORT',specifier:spec,resolvedPath:p?rel(p):null,
        resolution:p?(tracked.has(rel(p))?'TRACKED':'EXTERNAL_OR_GENERATED'):(spec.startsWith('node:')||builtinModules.includes(spec)?'NODE_BUILTIN':'UNRESOLVED'),typeOnly:Boolean(n.importClause?.isTypeOnly||n.isTypeOnly)};
      imports.push(e);allImports.push(e);
    }
    if(ts.isCallExpression(n)||ts.isNewExpression(n)) {
      const name=txt(n.expression,sf,220),args=[...(n.arguments??[])];
      let signature;try{signature=checker.getResolvedSignature(n);}catch{}
      const d=signature?.declaration,target=declTarget(d);
      const c={...loc(n,sf),caller:next,kind:ts.isNewExpression(n)?'CONSTRUCT':'CALL',callee:name,
        arguments:args.map(a=>shape(a,sf)),target,resolution:target?(tracked.has(target.path)?'TRACKED':'EXTERNAL_OR_GENERATED'):'UNRESOLVED',
        computed:ts.isElementAccessExpression(n.expression),hasCallback:args.some(a=>ts.isArrowFunction(a)||ts.isFunctionExpression(a)),
        outputType:signature?checker.typeToString(checker.getReturnTypeOfSignature(signature)).slice(0,600):'UNRESOLVED'};
      calls.push(c);allCalls.push(c);
      if((name==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword)&&args[0]&&ts.isStringLiteralLike(args[0])) {
        const p=modulePath(args[0].text,sf.fileName),e={...loc(n,sf),kind:name==='require'?'REQUIRE':'DYNAMIC_IMPORT',specifier:args[0].text,resolvedPath:p?rel(p):null,resolution:p?(tracked.has(rel(p))?'TRACKED':'EXTERNAL_OR_GENERATED'):'UNRESOLVED',typeOnly:false};imports.push(e);allImports.push(e);
      }
      let kind;
      if(/\.(get|post|put|patch|delete|head|options|route)$/.test(name)&&args[0]&&(ts.isStringLiteralLike(args[0])&&args[0].text.startsWith('/')||name.endsWith('.route')))kind='HTTP_ROUTE_CANDIDATE';
      else if(/\.(subscribe|on|once|addEventListener|listen)$/.test(name))kind='EVENT_OR_CALLBACK_CANDIDATE';
      else if(/(^|\.)(setInterval|setTimeout)$/.test(name))kind='TIMER_CANDIDATE';
      else if(/\.(register|addHook|registerOwnerHandler|setCommandHandler)$/.test(name))kind='REGISTRATION_CANDIDATE';
      else if(/\.(generateReply|streamReply|generateReasoning|embedText|embedBatch|transcribeAudio|synthesizeSpeech|decide|observeImage)$/.test(name))kind='MODEL_BOUNDARY_CANDIDATE';
      else if(/\.(query|execute|fetch|request|callTool|invoke|dispatch)$/.test(name)||name==='fetch'||/\b(execFile|spawn|execFileSync|spawnSync)$/.test(name))kind='EXTERNAL_OR_STORAGE_CANDIDATE';
      if(kind){const e={id:`ts:${f.gitPath}:${c.line}:${calls.length}`,...c,entryKind:kind};entries.push(e);entrypoints.push(e);}
    }
    if(ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)||ts.isClassDeclaration(n)) {
      const name=n.name?.text??'(anonymous)',id=`type:${f.gitPath}:${loc(n,sf).line}:${name}`;
      const members=n.members??(ts.isTypeAliasDeclaration(n)&&ts.isTypeLiteralNode(n.type)?n.type.members:[]);
      const d={id,...loc(n,sf),name,kind:ts.SyntaxKind[n.kind],fields:[...members].map(m=>({name:m.name?.getText(sf)??'(signature)',type:txt(m.type,sf,240)})),importantStateCandidate:/(Repository|Store|Event|Result|Output|Observation|Snapshot|Policy|Command|Task|Job|Profile|Person|Projection|Memory|Receipt|Envelope|Grant|Capability|Context|State|Intent)/.test(name)};
      decls.push(d);typeDeclarations.push(d);
    }
    if(ts.isTypeReferenceNode(n)) {
      let symbol=checker.getSymbolAtLocation(n.typeName);if(symbol&&(symbol.flags&ts.SymbolFlags.Alias))try{symbol=checker.getAliasedSymbol(symbol);}catch{}
      const d=symbol?.declarations?.[0],u={...loc(n,sf),name:n.typeName.getText(sf),owner:next,target:declTarget(d),usage:ts.SyntaxKind[n.parent.kind]};uses.push(u);typeUses.push(u);
    }
    ts.forEachChild(n,c=>visit(c,next));
  }
  visit(sf);
  const diagnostics=sf.parseDiagnostics.map(d=>({line:sf.getLineAndCharacterOfPosition(d.start??0).line+1,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
  records.push({path:f.gitPath,parser:'TypeScript Compiler API '+ts.version,parseErrors:diagnostics,imports,calls,declarations:decls,typeUses:uses,entryCandidates:entries});
}
const output={schemaVersion:'yuvi-static-relations.v1',baselineSHA:inv.baselineSHA,tool:'TypeScript '+ts.version,
  limitations:['Signature target may be an interface declaration, not concrete dispatched implementation','Object literals, callback ownership and computed calls are indexed, not an alias-perfect whole-program graph','Third-party/generated imports and computed expressions retained as unresolved boundaries','No call graph equivalence with runtime reachability is assumed'],records,imports:allImports,calls:allCalls,typeDeclarations,typeUses,entrypoints};
writeFileSync(join(here,'typescript-relations.json'),JSON.stringify(output)+'\n');
console.log(JSON.stringify({files:records.length,imports:allImports.length,calls:allCalls.length,entryCandidates:entrypoints.length,typeDeclarations:typeDeclarations.length,importantStateCandidates:typeDeclarations.filter(d=>d.importantStateCandidate).length,parseErrors:records.filter(r=>r.parseErrors.length).length}));
