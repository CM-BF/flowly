import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const root='/tmp/ultra-kanban-phase2-20261013/live-acceptance-01';
const fixture=JSON.parse(await readFile(`${root}/fixture-index.json`,'utf8'));
const scopeEvidence=JSON.parse(await readFile(new URL('./evidence/scope-revision-worktree.json',import.meta.url),'utf8'));
const mcpSession=JSON.parse(await readFile(`${root}/new-mcp-session.json`,'utf8'));
const doneTaskId=fixture.task.id,cancelTaskId=scopeEvidence.checks.multiRepo.taskId,archivedTaskId=scopeEvidence.createdResources.externalTaskId;
const marker=`${root}/negative-lifecycle-marker.json`,reportPath=new URL('./evidence/negative-lifecycle.json',import.meta.url).pathname;
try{await access(marker);throw new Error('Refusing duplicate negative-lifecycle fixture actors.');}catch(e){if(e?.code!=='ENOENT')throw e;}
await writeFile(marker,JSON.stringify({reservedAt:new Date().toISOString(),taskIds:[doneTaskId,cancelTaskId,archivedTaskId]}),{mode:0o600,flag:'wx'});
const client=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`phase2-negative-${randomUUID()}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}});
const api=createPaseoApi(client),rpc=(method,input)=>client.invokePluginRpc('paseo-ultra-kanban',method,input);
const {Client,StreamableHTTPClientTransport}=await import('/tmp/ultra-kanban-phase2-20261013/npm/node_modules/@modelcontextprotocol/client/dist/index.mjs');
const mcpClients=[];
const output={tasks:{done:doneTaskId,cancelled:cancelTaskId,archived:archivedTaskId},sessions:[],finishedWrites:{},archivedWrite:null,missingAgent:null,missingWorkspace:null,incompatibleWorkspace:null,workspacePreserved:null,error:null};
function toolShape(r){let d=r.structuredContent;if(!d&&r.content?.[0]?.text){try{d=JSON.parse(r.content[0].text);}catch{}}return{isError:r.isError===true,code:d?.error?.code??null,writable:d?.writable??d?.current?.writable??null,reason:d?.reason??d?.current?.reason??null};}
async function connectAuth(prep){const c=new Client({name:'phase2-negative-case',version:'0.1.0'});await c.connect(new StreamableHTTPClientTransport(new URL(prep.mcp.url),{requestInit:{headers:{Authorization:prep.mcp.headers.Authorization}}}));mcpClients.push(c);return c;}
async function createMcpActor(taskId,label,operationId){
  const task=(await rpc('board.read',{})).tasks.find(t=>t.id===taskId);
  const prep=await rpc('tools.prepare-session',{id:taskId,operationId});
  const agent=await api.workspaces.ref(task.workspaceId).agents.create({
    agentId:prep.agentId,idempotencyKey:`ultra-kanban-session:${prep.agentId}`,title:`Phase 2 negative test actor ${label}`,labels:{'ultra-kanban-task':taskId},
    config:{provider:'codex/gpt-6-luna',modeId:'full-access',thinkingOptionId:'medium',systemPrompt:`${prep.instructions}\n\nFixture setup only; do not call Kanban tools in this turn, edit files, use UI/CUA, or create children. Report PASEO_AGENT_ID and wait.`},
    env:{ULTRA_KANBAN_CONTEXT_FILE:prep.contextFile,ULTRA_KANBAN_CLI:prep.cliPath,ULTRA_KANBAN_SKILL:prep.skillPath},
    prompt:'Setup only: report PASEO_AGENT_ID and wait. Do not call tools or CLI.',
  });
  if(agent.id!==prep.agentId)throw new Error(`Preallocated ID changed for ${label}`);
  const finish=await agent.waitForFinish(180000);
  if(finish.status!=='idle')throw new Error(`Actor ${label} did not finish setup idle.`);
  output.sessions.push({label,agentId:agent.id,taskId,provider:'codex/gpt-6-luna',modeAtCreation:'full-access'});
  return {agent,prep,mcp:await connectAuth(prep)};
}
try{
  await client.connect();
  // A human-completed card stays readable but agent status writes are rejected.
  const donePrep=await rpc('tools.prepare-existing',{id:doneTaskId,agentId:mcpSession.createdAgentId});
  const doneMcp=await connectAuth(donePrep);
  const doneContext=(await doneMcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const doneWrite=await doneMcp.callTool({name:'kanban_update_status',arguments:{expectedRevision:doneContext.revision,request:doneContext.request,status:'in_progress',note:'Finished-card negative acceptance.'}});
  output.finishedWrites.done={readWritable:doneContext.writable,write:toolShape(doneWrite)};

  const cancelActor=await createMcpActor(cancelTaskId,'cancelled-card','phase2-live-cancelled-card-actor-v1');
  const cancelTask=(await rpc('board.read',{})).tasks.find(t=>t.id===cancelTaskId);
  const cancelled=await rpc('tasks.update',{id:cancelTaskId,revision:cancelTask.revision,status:'cancelled',actor:'human'});
  const cancelContext=(await cancelActor.mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const cancelWrite=await cancelActor.mcp.callTool({name:'kanban_report_progress',arguments:{expectedRevision:cancelContext.revision,request:cancelContext.request,kind:'progress',note:'Cancelled-card negative acceptance.'}});
  output.finishedWrites.cancelled={humanStatus:cancelled.status,readWritable:cancelContext.writable,write:toolShape(cancelWrite)};

  const archivedActor=await createMcpActor(archivedTaskId,'archived-card','phase2-live-archived-card-actor-v1');
  const archivedTask=(await rpc('board.read',{})).tasks.find(t=>t.id===archivedTaskId);
  const archived=await rpc('tasks.update',{id:archivedTaskId,revision:archivedTask.revision,archived:true,actor:'human'});
  const archivedContext=(await archivedActor.mcp.callTool({name:'kanban_get_task',arguments:{}})).structuredContent;
  const archivedWrite=await archivedActor.mcp.callTool({name:'kanban_update_status',arguments:{expectedRevision:archivedContext.revision,request:archivedContext.request,status:'in_progress',note:'Archived-card negative acceptance.'}});
  const afterArchive=await api.workspaces.ref(archivedTask.workspaceId).refresh();
  output.archivedWrite={cardArchived:!!archived.archivedAt,readWritable:archivedContext.writable,write:toolShape(archivedWrite),workspaceStillExists:!!afterArchive,workspaceStillActive:!!afterArchive&&!afterArchive.archivingAt,directoryStillExists:!!afterArchive&&!!(await stat(afterArchive.workspaceDirectory).catch(()=>null))};

  // A valid preparation credential whose agent has not actually been created cannot read the card.
  const missingPrep=await rpc('tools.prepare-session',{id:cancelTaskId,operationId:'phase2-live-missing-agent-no-create-v1'});
  const missingMcp=await connectAuth(missingPrep);
  const missing=await missingMcp.callTool({name:'kanban_get_task',arguments:{}});
  output.missingAgent={preallocatedButNotCreated:true,agentId:missingPrep.agentId,result:toolShape(missing)};

  // Existing workspace lookup must reject a missing ID and a different repo even when native resources exist.
  const missingWorkspaceId='wks_0000000000000000';
  try{await rpc('tasks.create',{projectId:fixture.project.id,operationId:'phase2-live-missing-workspace-v1',title:'Missing workspace rejection',description:'',status:'todo',priority:'normal',mode:'existing',workspaceId:missingWorkspaceId,repoPaths:[]});output.missingWorkspace={rejected:false};}
  catch(error){output.missingWorkspace={rejected:true,message:String(error?.message??error)};}

  const outside=join(root,'outside-repo');await mkdir(outside,{recursive:true});
  execFileSync('/Users/bofan.wang/.local/bin/paseo',['project','create',outside,'--json'],{encoding:'utf8',maxBuffer:1024*1024});
  const native=await api.projects.list(),outsideNative=native.projects.find(p=>p.projectRootPath===outside||p.projectRootPath===`/private${outside}`);
  if(!outsideNative)throw new Error('Outside fixture native project not found.');
  const outsideWorkspace=await api.workspaces.create({title:'Phase 2 incompatible repo workspace',idempotencyKey:'phase2-live-outside-workspace-v1',source:{kind:'directory',path:outside,projectId:outsideNative.projectId}});
  try{await rpc('tasks.create',{projectId:fixture.project.id,operationId:'phase2-live-incompatible-workspace-v1',title:'Incompatible workspace rejection',description:'',status:'todo',priority:'normal',mode:'existing',workspaceId:outsideWorkspace.id,repoPaths:[]});output.incompatibleWorkspace={rejected:false,workspaceId:outsideWorkspace.id};}
  catch(error){output.incompatibleWorkspace={rejected:true,workspaceId:outsideWorkspace.id,message:String(error?.message??error)};}
  await writeFile(reportPath,JSON.stringify(output,null,2),{mode:0o600});
}catch(error){output.error=String(error?.stack??error);await writeFile(reportPath,JSON.stringify(output,null,2),{mode:0o600});}
finally{
  for(const c of mcpClients)await c.close().catch(()=>{});
  await api.dispose().catch(()=>{});await client.close().catch(()=>{});
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
}
