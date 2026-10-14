import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root='/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture=JSON.parse(await readFile(`${root}/fixture-index.json`,'utf8'));
const existing=JSON.parse(await readFile(`${root}/existing-cli-session.json`,'utf8'));
const reportPath=`${root}/mcp-concurrency-replay.json`;
const markerPath=`${root}/mcp-concurrency-replay-marker.json`;
try{await access(markerPath);throw new Error('Refusing duplicate concurrency/replay actors.');}catch(e){if(e?.code!=='ENOENT')throw e;}
await writeFile(markerPath,JSON.stringify({reservedAt:new Date().toISOString(),taskId:existing.taskId}),{mode:0o600,flag:'wx'});
const client=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`phase2-concurrency-${randomUUID()}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}});
const api=createPaseoApi(client), rpc=(method,input)=>client.invokePluginRpc('paseo-ultra-kanban',method,input);
const output={taskId:existing.taskId,workspaceId:existing.workspaceId,agents:[],toolsListed:[],sameRevisionStateRace:null,parallelProgress:null,replay:null,requestReuse:null,crossSessionRequest:null,humanEditConflict:null,error:null};
const mcpClients=[];
function resultShape(r){
  let detail=r.structuredContent;
  if(!detail&&r.content?.[0]?.text){try{detail=JSON.parse(r.content[0].text);}catch{}}
  return {isError:r.isError===true,code:detail?.error?.code??null,replayed:detail?.result?.replayed??detail?.replayed??null,status:detail?.result?.current?.task?.status??detail?.current?.task?.status??null,revision:detail?.result?.current?.revision??detail?.current?.revision??null};
}
async function makeActor(label){
  const operationId=`phase2-live-concurrency-${label}-v1`;
  const prep=await rpc('tools.prepare-session',{id:existing.taskId,operationId});
  const agent=await api.workspaces.ref(existing.workspaceId).agents.create({
    agentId:prep.agentId,idempotencyKey:`ultra-kanban-session:${prep.agentId}`,title:`Phase 2 concurrency actor ${label} 2026-10-13`,labels:{'ultra-kanban-task':existing.taskId},
    config:{provider:'codex/gpt-6-luna',modeId:'full-access',thinkingOptionId:'medium',systemPrompt:`${prep.instructions}\n\nSetup only. Do not edit files, use GUI/CUA, delegate or create children, or call Kanban tools in this turn. Read PASEO_AGENT_ID from your own process environment, report it, then stop.`},
    env:{ULTRA_KANBAN_CONTEXT_FILE:prep.contextFile,ULTRA_KANBAN_CLI:prep.cliPath,ULTRA_KANBAN_SKILL:prep.skillPath},
    prompt:'Setup only: report your PASEO_AGENT_ID and wait. Do not call Kanban tools or CLI yet.',
  });
  if(agent.id!==prep.agentId)throw new Error(`Preallocated session ID changed for actor ${label}.`);
  const finish=await agent.waitForFinish(180000);
  if(finish.status!=='idle')throw new Error(`Actor ${label} did not finish setup turn: ${finish.status}`);
  const {Client,StreamableHTTPClientTransport}=await import('/tmp/ultra-kanban-phase2-20261013/npm/node_modules/@modelcontextprotocol/client/dist/index.mjs');
  const mcp=new Client({name:`phase2-live-${label}`,version:'0.1.0'});
  await mcp.connect(new StreamableHTTPClientTransport(new URL(prep.mcp.url),{requestInit:{headers:{Authorization:prep.mcp.headers.Authorization}}}));
  const listing=await mcp.listTools();
  output.toolsListed.push(...listing.tools.map(t=>t.name).filter(n=>!output.toolsListed.includes(n)));
  output.agents.push({label,agentId:agent.id,modeAtCreation:'full-access',provider:'codex/gpt-6-luna',setupStatus:finish.status});
  mcpClients.push(mcp);
  return {agent,mcp};
}
try{
  await client.connect();
  const [a,b]=await Promise.all([makeActor('A'),makeActor('B')]);
  const [contextA,contextB]=await Promise.all([
    a.mcp.callTool({name:'kanban_get_task',arguments:{}}),
    b.mcp.callTool({name:'kanban_get_task',arguments:{}}),
  ]);
  const ctxA=contextA.structuredContent,ctxB=contextB.structuredContent;
  if(!ctxA?.revision||!ctxB?.revision)throw new Error('Cannot read tool contexts for concurrent sessions.');
  output.sameRevisionStateRace={inputRevisionA:ctxA.revision,inputRevisionB:ctxB.revision,results:null,successCount:null,conflictCount:null,winnerStatus:null};
  const [writeA,writeB]=await Promise.all([
    a.mcp.callTool({name:'kanban_update_status',arguments:{expectedRevision:ctxA.revision,request:ctxA.request,status:'blocked',note:'Concurrent race actor A: deterministic fixture update.'}}),
    b.mcp.callTool({name:'kanban_update_status',arguments:{expectedRevision:ctxB.revision,request:ctxB.request,status:'in_progress',note:'Concurrent race actor B: deterministic fixture update.'}}),
  ]);
  const stateResults=[resultShape(writeA),resultShape(writeB)];
  output.sameRevisionStateRace.results=stateResults;
  output.sameRevisionStateRace.successCount=stateResults.filter(r=>!r.isError).length;
  output.sameRevisionStateRace.conflictCount=stateResults.filter(r=>r.code==='REVISION_CONFLICT').length;
  const boardAfterRace=await rpc('board.read',{}),taskAfterRace=boardAfterRace.tasks.find(t=>t.id===existing.taskId);
  output.sameRevisionStateRace.winnerStatus=taskAfterRace.status;
  output.sameRevisionStateRace.taskRevisionAfterRace=taskAfterRace.revision;

  const [progressContextA,progressContextB]=await Promise.all([
    a.mcp.callTool({name:'kanban_get_task',arguments:{}}),
    b.mcp.callTool({name:'kanban_get_task',arguments:{}}),
  ]);
  const progressA=progressContextA.structuredContent,progressB=progressContextB.structuredContent;
  const beforeParallel=await rpc('board.read',{}),beforeTask=beforeParallel.tasks.find(t=>t.id===existing.taskId),beforeProgressEvents=beforeParallel.events.filter(e=>e.taskId===existing.taskId&&e.actor==='agent'&&e.action==='progress_reported').length;
  const [noteA,noteB]=await Promise.all([
    a.mcp.callTool({name:'kanban_report_progress',arguments:{expectedRevision:progressA.revision,request:progressA.request,kind:'progress',note:'Parallel progress checkpoint from actor A.'}}),
    b.mcp.callTool({name:'kanban_report_progress',arguments:{expectedRevision:progressB.revision,request:progressB.request,kind:'progress',note:'Parallel progress checkpoint from actor B.'}}),
  ]);
  const afterParallel=await rpc('board.read',{}),afterTask=afterParallel.tasks.find(t=>t.id===existing.taskId),afterProgressEvents=afterParallel.events.filter(e=>e.taskId===existing.taskId&&e.actor==='agent'&&e.action==='progress_reported').length;
  output.parallelProgress={resultA:resultShape(noteA),resultB:resultShape(noteB),revisionBefore:beforeTask.revision,revisionAfter:afterTask.revision,progressEventsBefore:beforeProgressEvents,progressEventsAfter:afterProgressEvents,passed:!noteA.isError&&!noteB.isError&&beforeTask.revision===afterTask.revision&&afterProgressEvents===beforeProgressEvents+2};

  const replayContext=(await a.mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const eventCountBefore=(await rpc('board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;
  const replayInput={expectedRevision:replayContext.revision,request:replayContext.request,kind:'result',note:'Exact request replay after simulated lost response.'};
  const firstReplay=await a.mcp.callTool({name:'kanban_report_progress',arguments:replayInput});
  const eventCountAfterFirst=(await rpc('board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;
  const replayed=await a.mcp.callTool({name:'kanban_report_progress',arguments:replayInput});
  const eventCountAfterReplay=(await rpc('board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;
  output.replay={first:resultShape(firstReplay),replay:resultShape(replayed),eventCountBefore,eventCountAfterFirst,eventCountAfterReplay,passed:!firstReplay.isError&&!replayed.isError&&resultShape(replayed).replayed===true&&eventCountAfterFirst===eventCountBefore+1&&eventCountAfterReplay===eventCountAfterFirst};
  const reused=await a.mcp.callTool({name:'kanban_report_progress',arguments:{...replayInput,note:'Changed parameters must be rejected.'}});
  const eventCountAfterReuse=(await rpc('board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;
  output.requestReuse={result:resultShape(reused),eventCountAfterReplay,eventCountAfterReuse,passed:resultShape(reused).code==='REQUEST_REUSED'&&eventCountAfterReuse===eventCountAfterReplay};

  const mismatchContext=(await a.mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const crossSession=await b.mcp.callTool({name:'kanban_report_progress',arguments:{expectedRevision:mismatchContext.revision,request:mismatchContext.request,kind:'progress',note:'This request belongs to actor A and must not be accepted by actor B.'}});
  output.crossSessionRequest={result:resultShape(crossSession),passed:resultShape(crossSession).code==='SESSION_MISMATCH'};

  const staleContext=(await a.mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const beforeHuman=await rpc('board.read',{}),taskBeforeHuman=beforeHuman.tasks.find(t=>t.id===existing.taskId);
  const human=await rpc('tasks.update',{id:existing.taskId,revision:taskBeforeHuman.revision,priority:'high',actor:'human'});
  const stale=await a.mcp.callTool({name:'kanban_report_progress',arguments:{expectedRevision:staleContext.revision,request:staleContext.request,kind:'progress',note:'This snapshot predates a human edit.'}});
  const afterHuman=await rpc('board.read',{}),taskAfterHuman=afterHuman.tasks.find(t=>t.id===existing.taskId);
  output.humanEditConflict={humanPriority:human.priority,humanRevision:human.revision,staleResult:resultShape(stale),finalRevision:taskAfterHuman.revision,finalPriority:taskAfterHuman.priority,passed:resultShape(stale).code==='REVISION_CONFLICT'&&taskAfterHuman.priority==='high'&&taskAfterHuman.revision===human.revision};
}catch(error){output.error=String(error?.stack??error);}
finally{
  for(const m of mcpClients)await m.close().catch(()=>{});
  await api.dispose().catch(()=>{});
  await client.close().catch(()=>{});
  await writeFile(reportPath,JSON.stringify(output,null,2),{mode:0o600});
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
