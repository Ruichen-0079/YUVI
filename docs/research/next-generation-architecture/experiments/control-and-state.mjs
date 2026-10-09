import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/workspace/YUVI-source';
const mod = (p) => import(pathToFileURL(path.join(root,p)).href);
const core = await mod('packages/core/dist/index.js');
const memory = await mod('packages/memory/dist/index.js');
const providers = await mod('packages/providers/dist/index.js');
const { PromptBuilder } = await mod('packages/prompt-builder/dist/index.js');
const { InMemoryEventBus } = await mod('packages/event-bus/dist/index.js');
const { createServerCharacterPort } = await mod('apps/server/dist/character-runtime.js');
const { LegacyProfileMemorySourceReader } = await mod('packages/memory/dist/profile-source-reader.js');
const { materializeProfileSnapshot, canonicalizeGroundedLineage, rootsForLineage } = await mod('packages/memory/dist/profile-materializer.js');
const { modelContextBudget, compressHierarchicalContext } = await mod('packages/memory/dist/context-compression.js');
const { buildMemoryScope } = memory;
const scope = buildMemoryScope('probe-user','probe-character');
const now = '2026-10-09T00:00:00.000Z';
const subject = { kind:'MEMORY_SCOPE', scope };
const authority = {
  principal:{state:'UNRESOLVED',reason:'offline probe'},
  binding:{state:'UNRESOLVED',reason:'offline probe'},
  audience:{kind:'UNKNOWN',reason:'offline probe'}
};
function lineage(n) {
  return canonicalizeGroundedLineage({
    version:'memory-lineage.v1',state:'GROUNDED',
    parents:[{ref:{kind:'JOURNAL_EVENT',namespace:'probe',eventId:`jev1_${n.toString(16).padStart(16,'0')}`},
      selector:{version:'source-selector.v1',modality:'TEXT',payload:{namespace:'probe',payloadId:`p-${n}`,version:'v1'},range:{unit:'UNICODE_CODE_POINT',start:0,end:20}}}],
    sourceAvailability:{state:'RETAINED_SELECTABLE'},consumerKey:`probe-${n}`,
    derivation:{kind:'RULE_BASED_EXTRACTION',producer:'probe',producerVersion:'1',policyVersion:'probe.v1'},
    origin:'USER_ASSERTION',authority,sourceTime:{recordedAt:now,occurrenceTime:{state:'UNKNOWN'}}
  });
}
function source(n,content) {
  const lin=lineage(n), id=`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
  return {version:'yuvi-profile-evidence-source.v1',memory:{memoryId:`legacy:${id}`,backend:'legacy',sourceRecordId:id},scope,nativeScope:{kind:'user',scopeId:null},kind:'fact',subtype:null,content,claimClass:null,lineage:lin,lineageDigest:'0'.repeat(64),lifecycle:{state:'ACTIVE',coverage:'NATIVE',validFrom:now,validUntil:null,expiresAt:null},relationships:{coverage:'NATIVE',supersedes:[],supersededBy:null,contradicts:[]},roots:rootsForLineage(lin)};
}

const traces=[];
for (const escalation of [false,true]) {
  const calls=[];
  const chat={name:'offline-probe-chat',async generateReply(input) {
    const gate=input.messages[0].content.includes('Decide control flow only');
    const after=input.messages[0].content.includes('after one bounded Cognition round-trip');
    calls.push({kind:gate?'gate':'body',after,characters:JSON.stringify(input.messages).length});
    return {message:{role:'assistant',content:gate?JSON.stringify(escalation&&!after?{disposition:'NEED_COGNITION',focus:'verification'}:{disposition:'RESPOND'}):'离线探针正文。'},finishReason:'stop',model:'scripted'};
  }};
  chat.streamReply=async function* (input) {
    const output=await chat.generateReply(input);
    yield {type:'text-delta',text:output.message.content};
    yield {type:'completed',output};
  };
  let cognitionCalls=0;
  const runtime=new core.RuntimeOrchestrator({
    eventBus:new InMemoryEventBus(),memory:new memory.MemoryService(new memory.InMemoryMemoryRepository()),
    promptBuilder:new PromptBuilder(),conversation:new memory.InMemoryConversationRepository(),
    character:createServerCharacterPort(),
    characterCognition:async(request)=>{cognitionCalls++;return {version:'character-harness-5h.v1',request,result:{version:'character-cognition-result.v1',status:'SUCCESS',answer:'offline normalized result'}};},
    providers:{getChatProvider:()=>chat,getReasoningProvider:()=>providers.createMockReasoningProvider(),getSTTProvider:()=>providers.createMockSTTProvider(),getTTSProvider:()=>providers.createMockTTSProvider(),getVisionProvider:()=>providers.createMockVisionProvider(),getEmbeddingProvider:()=>new providers.MockEmbeddingProvider()}
  });
  const result=await runtime.handleUserMessage({sessionId:`probe-${escalation}`,content:'请给出一个具体答案。'},{readMemory:false,writeMemory:false,voiceOutput:false});
  assert.equal(result.payload.content,'离线探针正文。');
  assert.equal(calls.length,escalation?3:2);
  assert.equal(cognitionCalls,escalation?1:0);
  traces.push({escalation,calls,cognitionExecutorCalls:cognitionCalls,note:'Executor is scripted; actual Cognition may issue several provider/capability calls.'});
}

const semanticSnapshot=materializeProfileSnapshot({subject,backend:'legacy',generatedAt:now,sources:[source(1,'我喜欢黑咖啡。'),source(2,'我讨厌黑咖啡。')]});
assert.equal(semanticSnapshot.generationState,'COMPLETE');
assert.ok(semanticSnapshot.entries.every(x=>x.semanticConflictAssessment==='NOT_ASSESSED'));

const repo=new memory.InMemoryMemoryRepository();
await repo.createGroundedMemory({memory:{type:'episodic',content:'我喜欢黑咖啡。',source:'probe',subjectUserId:'probe-user',personaId:'probe-character',observedAt:now,validFrom:now},lineage:lineage(1),payloadDigest:'1'.padStart(64,'0')});
const original=await repo.listProfileSourceSnapshot({scope,rawLimit:4096});
assert.equal(original.records.length,1);
const boundResults=[];
for(const n of [4096,4097]) {
  // Exercise the production reader over a repository-contract snapshot. All rows
  // have valid unique identities; no DB/network or semantic model is involved.
  const rows=Array.from({length:n},(_,i)=>({...original.records[0],id:`00000000-0000-4000-8000-${(i+1).toString(16).padStart(12,'0')}`,lineage:lineage(i+1),lineageConsumerKey:`probe-${i+1}`}));
  const read=await new LegacyProfileMemorySourceReader({listProfileSourceSnapshot:async()=>({records:rows,exhausted:true,rawBytesExceeded:false})}).listEligibleSources({subject,asOf:now});
  boundResults.push({rawRecords:n,state:read.state,reasons:read.reasons,eligible:read.sources.length});
  assert.equal(read.state,n===4096?'COMPLETE':'PARTIAL');
}

let reasonerCalls=0;
const extractor=new memory.LlmMemoryExtractor({name:'offline',async generateReasoning(){reasonerCalls++;throw Error('should not run');}},undefined,{enabled:true,providerConfigured:true});
const extracted=await extractor.extractCandidates({userMessage:'我喜欢简短的回答。',assistantMessage:'好的。'});
assert.equal(reasonerCalls,0);

const budgets=[16384,32768,131072,1048576].map(window=>modelContextBudget(window));
const compressionCases=[
  {name:'three-lines',text:'用户先说可以发送草稿。\n'+'填充文本。'.repeat(1000)+' UNKNOWN：旧资料有不确定性。\n用户后来撤回：不要发送草稿。'},
  {name:'four-lines',text:'用户先说可以发送草稿。\n'+'填充文本。'.repeat(1000)+'\nUNKNOWN：旧资料有不确定性。\n用户后来撤回：不要发送草稿。'}
];
const compression=compressionCases.map(({name,text})=>{
  const compressed=compressHierarchicalContext({sections:[{name:'MEMORY_EVIDENCE',content:text}],maxCharacters:300});
  return {name,before:text.length,after:compressed.sections[0].content.length,retractionRetained:compressed.sections[0].content.includes('不要发送草稿'),unknownMarkerRetained:compressed.sections[0].content.includes('UNKNOWN'),epistemicMarkersPreserved:compressed.metrics.epistemicMarkersPreserved,note:'Only newline placement differs; illustrative bounded evidence text, not a prevalence estimate.'};
});
assert.equal(compression[0].retractionRetained,false);
assert.equal(compression[1].retractionRetained,true);
assert.ok(compression.every(x=>x.unknownMarkerRetained&&x.epistemicMarkersPreserved));

const costs=[];
for(const promptTokens of [2000,8000,20000]) for(const cacheHitFraction of [0,0.9]) {
  // Parametric arithmetic, not tokenizer counts or provider invoices.
  const outputTokens=200,gateTokens=30,cacheDiscount=0.1,turns=100;
  const effectiveInput=promptTokens*((1-cacheHitFraction)+cacheHitFraction*cacheDiscount);
  costs.push({promptTokens,cacheHitFraction,turns,currentSimpleInputTokens:2*turns*effectiveInput,onePassInputTokens:turns*effectiveInput,currentOutputTokens:turns*(outputTokens+gateTokens),onePassOutputTokens:turns*outputTokens});
}
const baseline=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const sourceDirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
const result={baseline,sourceDirty,mode:'offline production control flow / contract inputs / parametric arithmetic',traces,profile:{generationState:semanticSnapshot.generationState,narrative:semanticSnapshot.narrative,entries:semanticSnapshot.entries.map(({content,status,epistemicStatus,semanticConflictAssessment})=>({content,status,epistemicStatus,semanticConflictAssessment}))},boundResults,extractor:{reasonerCalls,status:extractor.getStatus(),candidateCount:extracted.length},budgets,compression,costs};
const output=path.join(import.meta.dirname,'results.json');
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,traces,profile:result.profile,boundResults,extractor:result.extractor,budgets,compression},null,2));
