import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root='/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const existing=JSON.parse(await readFile(`${root}/existing-cli-session.json`,'utf8'));
const marker=`${root}/reload-readiness-marker.json`;
const outputPath=`${root}/reload-readiness-receipt.json`;
try{await access(marker);throw new Error('Refusing duplicate reload-readiness actor.');}catch(e){if(e?.code!=='ENOENT')throw e;}
await writeFile(marker,JSON.stringify({reservedAt:new Date().toISOString(),taskId:existing.taskId}),{mode:0o600,flag:'wx'});
const {Client,StreamableHTTPClientTransport}=await import('/tmp/ultra-kanban-phase2-20261013/npm/node_modules/@modelcontextprotocol/client/dist/index.mjs');
let authorization='',writeInput=null,mcp=null;
const output={title:'Phase 2 MCP reload receipt Luna fixture',provider:'codex/gpt-6-luna',modeAtCreation:'full-access',taskId:existing.taskId,workspaceId:existing.workspaceId,agentId:null,portBefore:null,portAfter:null,preReloadWrite:null,unauthorizedAfterReloadStatus:null,coldReadError:null,healthAfterContext:null,recoveredRead:false,replayResult:null,eventCountAfterFirst:null,eventCountAfterReplay:null,readyAfterReload:false,error:null};
function shape(r){let d=r.structuredContent;if(!d&&r.content?.[0]?.text){try{d=JSON.parse(r.content[0].text);}catch{}}return{isError:r.isError===true,code:d?.error?.code??null,replayed:d?.replayed??null,status:d?.current?.task?.status??null,taskRevision:d?.current?.revision?.task??null};}
async function httpClient(){const c=new Client({name:'phase2-live-reload-check',version:'0.1.0'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${output.portBefore}/mcp`),{requestInit:{headers:{Authorization:authorization}}}));return c;}
try{
  const client=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`phase2-reload-setup-${randomUUID()}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}});
  const api=createPaseoApi(client);
  await client.connect();
  const prep=await client.invokePluginRpc('paseo-ultra-kanban','tools.prepare-session',{id:existing.taskId,operationId:'phase2-live-reload-replay-op-v1'});
  authorization=prep.mcp.headers.Authorization;
  output.agentId=prep.agentId;
  const discoveryBefore=JSON.parse(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/tool-endpoint.json','utf8'));
  output.portBefore=discoveryBefore.port;
  const workspace=api.workspaces.ref(existing.workspaceId);
  const agent=await workspace.agents.create({
    agentId:prep.agentId,idempotencyKey:`ultra-kanban-session:${prep.agentId}`,title:output.title,
    config:{provider:'codex/gpt-6-luna',modeId:'full-access',thinkingOptionId:'medium',systemPrompt:`${prep.instructions}\n\nSetup only. Do not call Kanban tools in this first turn. Do not edit files or use UI/CUA or create children. Report PASEO_AGENT_ID and wait.`,mcpServers:{'ultra-kanban':prep.mcp}},
    env:{ULTRA_KANBAN_CONTEXT_FILE:prep.contextFile,ULTRA_KANBAN_CLI:prep.cliPath,ULTRA_KANBAN_SKILL:prep.skillPath},
    prompt:'Setup only: report PASEO_AGENT_ID, do not invoke Kanban tools yet, then wait.'
  });
  if(agent.id!==prep.agentId)throw new Error('Reload actor preallocated ID mismatch.');
  const finish=await agent.waitForFinish(180000);
  if(finish.status!=='idle')throw new Error('Reload actor setup turn did not finish idle.');
  mcp=await httpClient();
  const snapshot=(await mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  if(!snapshot?.revision||!snapshot?.request)throw new Error('Could not read current task for replay fixture.');
  writeInput={expectedRevision:snapshot.revision,request:snapshot.request,kind:'result',note:'Persisted receipt replay verification across same-plugin reload.'};
  const first=await mcp.callTool({name:'kanban_report_progress',arguments:writeInput});
  output.preReloadWrite=shape(first);
  output.eventCountAfterFirst=(await client.invokePluginRpc('paseo-ultra-kanban','board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;
  await mcp.close();mcp=null;
  await api.dispose();await client.close();

  execFileSync('/Users/bofan.wang/.local/bin/paseo',['plugin','reload','paseo-ultra-kanban'],{encoding:'utf8',maxBuffer:1024*1024});
  const discoveryDeadline=Date.now()+15000;
  while(Date.now()<discoveryDeadline){
    try{const response=await fetch(`http://127.0.0.1:${output.portBefore}/api`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});output.unauthorizedAfterReloadStatus=response.status;if(response.status===401)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const discoveryAfter=JSON.parse(await readFile('/Users/bofan.wang/.paseo/plugin-data/paseo-ultra-kanban/tool-endpoint.json','utf8'));
  output.portAfter=discoveryAfter.port;
  mcp=await httpClient();
  const cold=await mcp.callTool({name:'kanban_get_task',arguments:{}});
  output.coldReadError=shape(cold).code;
  const wakeClient=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`phase2-reload-wake-${randomUUID()}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}});
  try{await wakeClient.connect();output.healthAfterContext=await wakeClient.invokePluginRpc('paseo-ultra-kanban','tools.health',{});}finally{await wakeClient.close();}
  output.readyAfterReload=output.healthAfterContext?.ready===true;
  const recovered=await mcp.callTool({name:'kanban_get_task',arguments:{}});
  output.recoveredRead=!recovered.isError&&recovered.structuredContent?.identity?.agentId===output.agentId;
  const replay=await mcp.callTool({name:'kanban_report_progress',arguments:writeInput});
  output.replayResult=shape(replay);
  const readClient=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`phase2-reload-evidence-${randomUUID()}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}});
  try{await readClient.connect();output.eventCountAfterReplay=(await readClient.invokePluginRpc('paseo-ultra-kanban','board.read',{})).events.filter(e=>e.taskId===existing.taskId).length;}finally{await readClient.close();}
}catch(error){output.error=String(error?.stack??error).replaceAll(authorization,'[REDACTED]');}
finally{
  await mcp?.close().catch(()=>{});
  output.portStable=output.portBefore!==null&&output.portBefore===output.portAfter;
  output.receiptReplayPassed=output.replayResult?.replayed===true&&output.eventCountAfterFirst===output.eventCountAfterReplay;
  await writeFile(outputPath,JSON.stringify(output,null,2),{mode:0o600});
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
