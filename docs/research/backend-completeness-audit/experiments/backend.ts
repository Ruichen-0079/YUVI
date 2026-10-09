import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawn} from 'node:child_process';
import {DotsTTSProvider} from '#repo/packages/providers/src/local/DotsTTSProvider.ts';
import {executeProductionCognition} from '#repo/apps/server/src/cognition-production.ts';
import {readAuthorizedLocalText} from '#repo/apps/server/src/read-text-effect.ts';
import {SERVER_MCP_READ_TEXT_CAPABILITY_REF} from '#repo/apps/server/src/mcp-capability-binding.ts';
import {registerWebSocketRoutes,ActiveTraceRegistry} from '#repo/apps/server/src/routes/websocket.ts';
import {InMemoryEventBus} from '@companion/event-bus';
import {createEvent,AssistantMessagePayloadSchema} from '@companion/protocol';
import {PromptBuilder} from '@companion/prompt-builder';
import {createServerCharacterPort} from '#repo/apps/server/src/character-runtime.ts';
const dir=await mkdtemp(join(tmpdir(),'yuvi-read-audit-'));
async function readCase(length:number,abort=false){
 const started=performance.now();
 const path=join(dir,`${length}.txt`),text='X'.repeat(length-6)+'END_OK';await writeFile(path,text);
 const calls:any[]=[],responses:any[]=[],reads:any[]=[],controller=new AbortController();if(abort)controller.abort();
 const result=await executeProductionCognition({
  providers:{getReasoningProvider:()=>({name:'input-recorder',async generateReasoning(input:any){calls.push(input);const response={answer:calls.length===1?'REQUEST_CAPABILITY\n'+JSON.stringify({capabilityRef:SERVER_MCP_READ_TEXT_CAPABILITY_REF,request:'Read admitted evidence.'}):'COMPLETE\nRecorder done.',reasoning:'',finishReason:'stop',model:'input-recorder'};responses.push(response);return response;}})} as any,
  request:{version:'character-harness-5g.v1',kind:'NEED_COGNITION',focus:'verify'},problem:'Inspect authorized text.',runtimeAuthorizedPath:path,
  effectContext:{scope:'probe',cause:{kind:'JOURNAL_EVENT',namespace:'probe-journal',eventId:'jev1_aaaaaaaaaaaaaaaa'}},
  readTextEffects:{async execute(input:any){const r=await readAuthorizedLocalText(input.path,controller.signal);reads.push(r);return r;}} as any,
  execution:{executionId:`read-${length}-${abort}`,isCurrent:()=>true},limits:{maxReasoningRounds:3,maxCapabilityCalls:1,timeBudgetMs:60000}
 });
 return {length,abort,readResults:reads,reasoningInputs:calls,reasoningOutputs:responses,recordedModelCalls:calls.length,serializedInputCharacters:JSON.stringify(calls).length,fixtureWallTimeMs:performance.now()-started,latencyMeaning:'Local deterministic control/filesystem only; actual model cost and latency not measured',result};
}
const normal=await readCase(16000),overflow=await readCase(16001),boundedLarge=await readCase(64000),cancelled=await readCase(100,true);
assert.ok(JSON.stringify(normal.reasoningInputs[1]).includes('END_OK'));
assert.equal(overflow.readResults[0].isError,false);assert.ok(!JSON.stringify(overflow.reasoningInputs[1]).includes('END_OK'));
assert.ok(JSON.stringify(overflow.reasoningInputs[1]).includes('ERROR'));
assert.equal(boundedLarge.readResults[0].isError,false);assert.ok(!JSON.stringify(boundedLarge.reasoningInputs[1]).includes('END_OK'));
assert.equal(cancelled.readResults.length,0);
const counterfactual={description:'Information-only counterfactual bypasses observation normalization; same admitted result can be provided verbatim, no inference-quality claim',availableTextCharacters:overflow.readResults[0].content[0].text.length,tail:overflow.readResults[0].content[0].text.slice(-6)};
await rm(dir,{recursive:true,force:true});
async function socketCase(query:any){
 let handler:any;const bus=new InMemoryEventBus({development:false}),sent:any[]=[],listeners=new Map();
 const app={get(path:any,_opts:any,h:any){if(path==='/ws')handler=h;}};
 await registerWebSocketRoutes(app as any,{eventBus:bus} as any);
 const socket={OPEN:1,readyState:1,send(text:string,cb?:any){sent.push(JSON.parse(text));cb?.();},on(name:string,cb:any){listeners.set(name,cb);}};
 handler(socket,{query});await Promise.resolve();
 await bus.publish(createEvent('agent.reply',AssistantMessagePayloadSchema.parse({sessionId:'other-session',content:'OTHER_SESSION_PRIVATE_MARKER'}),{source:'probe',traceId:'foreign-trace'}));
 listeners.get('close')?.();
 return {query,frames:sent,foreignContentForwarded:JSON.stringify(sent).includes('OTHER_SESSION_PRIVATE_MARKER')};
}
const wsDefault=await socketCase({}),wsTrue=await socketCase({dashboard:'true'}),wsFalseString=await socketCase({dashboard:'false'}),wsFalseBoolean=await socketCase({dashboard:false});
assert.equal(wsDefault.foreignContentForwarded,false);assert.equal(wsTrue.foreignContentForwarded,true);assert.equal(wsFalseString.foreignContentForwarded,true);assert.equal(wsFalseBoolean.foreignContentForwarded,false);
async function pendingReplyCase(invalidPacket=false,protectExistingTrace=false){
 let handler:any,release:any,started:any;const modelStarted=new Promise<void>(r=>started=r),wait=new Promise<void>(r=>release=r),bus=new InMemoryEventBus({development:false}),sent:any[]=[],listeners=new Map(),inputs:any[]=[];
 const app={log:{info(){},error(){}},get(path:any,_opts:any,h:any){if(path==='/ws')handler=h;}};
 const context={eventBus:bus,conversationalReceiptAdmission:{async admit(){return {envelope:{journalNamespace:'probe-journal',eventId:'jev1_aaaaaaaaaaaaaaaa'}};}},runtime:{async handleUserMessage(input:any){inputs.push(input);started();await wait;await bus.publish(createEvent('agent.reply',AssistantMessagePayloadSchema.parse({sessionId:'own-session',content:'LEGITIMATE_PENDING_REPLY_MARKER'}),{traceId:'owned-active-trace'}));}}};
 await registerWebSocketRoutes(app as any,context as any);
 handler({OPEN:1,readyState:1,send(text:string,cb?:any){sent.push(JSON.parse(text));cb?.();},on(name:string,cb:any){listeners.set(name,cb);}},{query:{}});
 const valid=createEvent('user.message',{sessionId:'own-session',content:'Please finish this valid turn.'},{traceId:'owned-active-trace'});
 const pending=listeners.get('message')(Buffer.from(JSON.stringify(valid)));await modelStarted;
 if(invalidPacket){
  const saved=ActiveTraceRegistry.prototype.delete;
  if(protectExistingTrace)ActiveTraceRegistry.prototype.delete=function(id:string){if(id!=='owned-active-trace')saved.call(this,id);};
  try{await listeners.get('message')(Buffer.from(JSON.stringify(createEvent('agent.reply',{sessionId:'own-session',content:'Unsupported client packet'},{traceId:'owned-active-trace'}))));}finally{ActiveTraceRegistry.prototype.delete=saved;}
 }
 release();await pending;listeners.get('close')?.();
 return {invalidPacket,protectExistingTrace,inputs,frames:sent,replyDelivered:JSON.stringify(sent).includes('LEGITIMATE_PENDING_REPLY_MARKER')};
}
const pendingNormal=await pendingReplyCase(),pendingInvalid=await pendingReplyCase(true),pendingCounterfactual=await pendingReplyCase(true,true);
assert.equal(pendingNormal.replyDelivered,true);assert.equal(pendingInvalid.inputs.length,1);assert.equal(pendingInvalid.replyDelivered,false);assert.equal(pendingCounterfactual.replyDelivered,true);
const pendingReply={normal:pendingNormal,negative:pendingInvalid,counterfactual:pendingCounterfactual,scope:'Actual WS handler + schema/trace registry + EventBus; host Journal receipt and Runtime completion event producer injected; no quality, network deployment or durable publication assertion. Counterfactual only guards deletion of a pre-existing trace during invalid-packet handling, no production file edit.'};
const prompt=new PromptBuilder().buildPrompt({systemIdentity:'Alice',characterStyle:'Warm and precise.',userMessage:'Verify the admitted claim.'});
const port=createServerCharacterPort();
async function characterCase(disposition:string,after=false,abort=false){
 const inputs:any[]=[],outputs:any[]=[];const started=performance.now();const generateChat=async(input:any)=>{inputs.push(input);const output={message:{role:'assistant',content:JSON.stringify({disposition,...(disposition==='NEED_COGNITION'?{focus:'verification'}:{})})},finishReason:'stop',model:'input-recorder'};outputs.push(output);return output;};
 const turn:any={prompt,userMessage:'Verify the admitted claim.',generateChat,...(abort?{signal:AbortSignal.abort()}:{}),...(after?{cognitionRoundTrip:{version:'character-harness-5h.v1',request:{version:'character-harness-5g.v1',kind:'NEED_COGNITION',focus:'verification'},result:{version:'character-cognition-result.v1',status:'SUCCESS',answer:'COGNITION_ANSWER_MARKER',uncertainty:['UNCERTAINTY_MARKER'],caveats:['CAVEAT_MARKER']}}}:{})};
 let result:any,error:any;try{result=after?await port.generateAfterCognition(turn):await port.generate(turn);}catch(e:any){error={name:e.name,message:e.message,code:e.code};}
 return {disposition,after,abort,inputs,outputs,recordedModelCalls:inputs.length,serializedInputCharacters:JSON.stringify(inputs).length,fixtureWallTimeMs:performance.now()-started,actualModelCost:'UNMEASURED_NOT_A_REMOTE_CALL',result,error};
}
const respond=await characterCase('RESPOND'),silence=await characterCase('SILENCE'),need=await characterCase('NEED_COGNITION'),reentry=await characterCase('RESPOND',true),cancelCharacter=await characterCase('RESPOND',false,true);
assert.equal(respond.result.decision.reply.disposition,'RESPOND');assert.equal(silence.result.decision.reply.disposition,'SILENCE');assert.equal(need.result.cognitionHandoff.request.kind,'NEED_COGNITION');
assert.ok(JSON.stringify(reentry.inputs).includes('COGNITION_ANSWER_MARKER'));assert.ok(JSON.stringify(reentry.inputs).includes('UNCERTAINTY_MARKER'));assert.equal(cancelCharacter.inputs.length,0);
const character={respond,silence,need,reentry,cancelCharacter,counterfactual:'A direct chat request can accept free prose without this gate, whereas RESPOND requires a subsequent body consumer. Existing production Runtime consumes it (prior recorder evidence); this probe does not compare model quality.',scope:'Actual Character port/generation/reentry functions; Chat is an input recorder, no Runtime durable/publication test.'};
const child=spawn('python3',[join(dirname(new URL(import.meta.url).pathname),'dots-http-fixture.py'),process.env.AUDIT_REPO!],{stdio:['ignore','pipe','inherit']});
let localTTS:any;
try{
 const port=await new Promise<number>((res,rej)=>{child.stdout.once('data',x=>res(Number(x.toString().trim())));child.once('error',rej);child.once('exit',c=>rej(Error('Sidecar exited '+c)));});
 const p=new DotsTTSProvider({baseUrl:`http://127.0.0.1:${port}`,model:'fixture-waveform',timeoutMs:5000});
 const healthy=await p.healthCheck(),short=await p.synthesizeSpeech({text:'X'.repeat(2000)});let longError:any;
 try{await p.synthesizeSpeech({text:'X'.repeat(2001)});}catch(e:any){longError={code:e.code,statusCode:e.statusCode,effectState:e.effectState,message:e.message};}
 assert.equal(healthy.available,true);assert.equal(short.mimeType,'audio/wav');assert.equal(longError.statusCode,400);
 const cfA=await p.synthesizeSpeech({text:'X'.repeat(1001)}),cfB=await p.synthesizeSpeech({text:'X'.repeat(1000)});
 localTTS={healthy,normal:{length:2000,mimeType:short.mimeType},overflow:{length:2001,error:longError},counterfactual:{splitLengths:[1001,1000],mimeTypes:[cfA.mimeType,cfB.mimeType]},scope:'Real DotsTTSProvider over localhost HTTP to actual Python Handler/Service; waveform generator mocked, no GPU/inference quality, no complete Runtime/durable media-effect assertion'};
}finally{child.kill();}
console.log('AUDIT_RESULT='+JSON.stringify({pendingReply,character,localTTS,readText:{normal,overflow,boundedLarge,cancelled,counterfactual,scope:'Real local file reader + real production Cognition execution + real normalizer; Reasoning is a scripted input recorder, host durable effect adapter injected; not a quality or Postgres recovery experiment'},websocket:{wsDefault,wsTrue,wsFalseString,wsFalseBoolean,scope:'Actual route registration and EventBus; socket/HTTP host injected, no external network/deployment or outward durable-ledger assertion; no client sent a user message'}}));
