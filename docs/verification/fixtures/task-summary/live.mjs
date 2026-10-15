import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { settingsRpc } from '@getpaseo/plugin';
const out = join(process.cwd(), 'docs/verification/fixtures/task-summary/live-evidence.json');
const dir = await mkdtemp(join(tmpdir(), 'ultra-task-summary-'));
const stamp = new Date().toISOString();
const client = new DaemonClient({ url: 'ws://127.0.0.1:6767/ws', clientId: `task-summary-test-${randomUUID()}`, clientType: 'cli', appVersion: '0.11.2', connectTimeoutMs: 10000, reconnect: { enabled: false } });
const api = createPaseoApi(client); const rpc=(m,i)=>client.invokePluginRpc('paseo-ultra-kanban',m,i);
const evidence={startedAt:stamp,fixtureDir:dir,sessionId:'dddf746d-0f5c-4a25-8ab7-ec45a17ea610',baseline:{projects:[],agents:[]},settings:{},turns:[],summarizer:[],cleanup:{}};
let project, task, noSessionTask, agent, settingRpc, originalSettings, mutatedSettings=false;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitForCount(n, timeout=180000){const started=Date.now(); while(Date.now()-started<timeout){const x=await rpc('summaries.read',{}); const entries=(await rpc('summaries.history',{taskId:task.id})); if(entries.length>=n)return {elapsedMs:Date.now()-started,overview:x,history:entries}; await delay(3000);} return {timeout:true,elapsedMs:Date.now()-started,overview:await rpc('summaries.read',{}),history:await rpc('summaries.history',{taskId:task.id})};}
try {
 await client.connect();
 evidence.baseline.projects=JSON.parse(execFileSync('paseo',['project','ls','--json'],{encoding:'utf8'}));
 evidence.baseline.agents=JSON.parse(execFileSync('paseo',['agent','ls','--json','--global'],{encoding:'utf8'}));
 evidence.baseline.board=await rpc('board.read',{});
 evidence.baseline.summaries=await rpc('summaries.read',{});
 project=await rpc('projects.create',{title:`Task summary fixture ${randomUUID().slice(0,8)}`,description:'Disposable live acceptance fixture.',primaryPath:dir}); evidence.project=project;
 task=await rpc('tasks.create',{projectId:project.id,operationId:`task-summary-${randomUUID()}`,title:'Task summary live acceptance',description:'Exercise automatic progress summary with isolated test turns.',status:'todo',priority:'normal',mode:'directory'}); evidence.task=task;
 noSessionTask=await rpc('tasks.create',{projectId:project.id,operationId:`task-summary-empty-${randomUUID()}`,title:'Task summary no-session negative test',description:'',status:'todo',priority:'low',mode:'directory'}); evidence.noSessionTask=noSessionTask;
 let refreshError='';try{await rpc('summaries.refresh',{taskId:noSessionTask.id});}catch(e){refreshError=String(e?.message||e)} evidence.noSessionRefresh={error:refreshError,expectedSubstring:'no Kanban sessions'};
 const prep=await rpc('tools.prepare-session',{id:task.id,operationId:`task-summary-prepare-${randomUUID()}`}); evidence.preparation={agentId:prep.agentId,contextFile:prep.contextFile};
 const ws=api.workspaces.ref(task.workspaceId); const descriptor=await ws.refresh(); evidence.workspace={id:descriptor?.id,workspaceDirectory:descriptor?.workspaceDirectory};
 agent=await ws.agents.create({agentId:prep.agentId,idempotencyKey:`task-summary:${prep.agentId}`,title:'Task summary acceptance worker',labels:{'ultra-kanban-task':task.id},config:{provider:'codex/gpt-6-luna',modeId:'full-access',thinkingOptionId:'low',systemPrompt:'You are an isolated acceptance test worker. Only modify files inside this fixture workspace. Do not use GUI/browser, do not spawn children, and do not access other projects.'},env:{ULTRA_KANBAN_CONTEXT_FILE:prep.contextFile,ULTRA_KANBAN_CLI:prep.cliPath,ULTRA_KANBAN_SKILL:prep.skillPath},prompt:'Setup only: report your PASEO_AGENT_ID and wait for the next instruction. Do not create or edit files yet.'});
 evidence.worker={id:agent.id,provider:'codex/gpt-6-luna',modeId:'full-access',setup:(await agent.waitForFinish(180000)).status};
 const callTurn=async(text)=>{const started=Date.now();const r=await agent.run(text,{timeoutMs:180000});return {text,status:r.status,lastMessage:r.lastMessage,elapsedMs:Date.now()-started};};
 evidence.turns.push(await callTurn('Create a file named summary-fixture.txt containing exactly two short bullet points: first say the fixture file was created; second say the next step is verification. Then explain the change in one sentence. Do only this small task.'));
 evidence.turns[0].summaries=await waitForCount(1);
 evidence.summarizerAfterFirst=JSON.parse(execFileSync('paseo',['agent','ls','--json','--all','--global','--label','ultra-kanban=summarizer'],{encoding:'utf8'}));
 evidence.summariesAfterFirst=await rpc('summaries.history',{taskId:task.id});
 evidence.turns.push(await callTurn('thanks'));
 await delay(12000); evidence.turns[1].summaries=await rpc('summaries.history',{taskId:task.id});
 evidence.turns.push(await callTurn('Append one line to summary-fixture.txt stating that the second verification pass completed. Explain the append and say what remains next.'));
 evidence.turns[2].summaries=await waitForCount(2);
 evidence.history=await rpc('summaries.history',{taskId:task.id});
 evidence.refresh=await rpc('summaries.refresh',{taskId:task.id}); evidence.refreshRun=await waitForCount(3);
 settingRpc=settingsRpc('task-summary');
 originalSettings=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.read.name,{}); evidence.settings.original=originalSettings;
 if(originalSettings.status==='ready'){
   const off=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.write.name,{revision:originalSettings.revision,values:{...originalSettings.values,summaryEnabled:false}}); evidence.settings.disabled=off; mutatedSettings=off.status==='saved';
   const before=await rpc('summaries.history',{taskId:task.id}); evidence.turns.push(await callTurn('Append a third line saying the auto-summary-off test ran.')); await delay(10000); const after=await rpc('summaries.history',{taskId:task.id}); evidence.settings.disabledTurn={before:before.length,after:after.length};
   const readOff=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.read.name,{});
   const luna=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.write.name,{revision:readOff.revision,values:{...readOff.values,summaryEnabled:true,summaryModel:'codex/gpt-6-luna'}}); evidence.settings.luna=luna;
   if(luna.status==='saved'){mutatedSettings=true;evidence.turns.push(await callTurn('Append a fourth line saying the Luna summary-model test ran.')); evidence.settings.lunaTurn=await waitForCount(after.length+1);}
 }
 evidence.summaryFiles=await readFile(join(process.env.HOME,'.paseo/plugin-data/paseo-ultra-kanban/summaries.json'),'utf8');
 evidence.summarizerAgentsAll=JSON.parse(execFileSync('paseo',['agent','ls','--json','--all','--global','--label','ultra-kanban=summarizer'],{encoding:'utf8'}));
 evidence.resourcesAfter=await rpc('resources.list',{});
} catch(e){ evidence.error=String(e?.stack||e); }
finally {
 try {if(agent){await agent.archive().catch(()=>{}); evidence.cleanup.workerArchived=!!(await api.agents.ref(agent.id).refresh())?.archivedAt;}}catch(e){evidence.cleanup.workerArchiveError=String(e)}
 try {if(mutatedSettings&&settingRpc){let cur=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.read.name,{}); const restored=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.write.name,{revision:cur.revision,values:originalSettings.values}); evidence.cleanup.settingsRestore=restored; evidence.cleanup.settingsVerified=await client.invokePluginRpc('paseo-ultra-kanban',settingRpc.read.name,{});}}catch(e){evidence.cleanup.settingsRestoreError=String(e)}
 try {if(project){const board=await rpc('board.read',{});const p=board.projects.find(x=>x.id===project.id);if(p){const res=await rpc('projects.remove',{id:p.id,revision:p.revision,alsoPaseo:true});evidence.cleanup.remove=res;}}}catch(e){evidence.cleanup.projectRemoveError=String(e)}
 try {if(project){const removed=JSON.parse(execFileSync('paseo',['project','ls','--json'],{encoding:'utf8'}));evidence.cleanup.nativeProjectStillListed=removed.some(p=>p.projectId===project.paseoProjectId);const board=await rpc('board.read',{});evidence.cleanup.boardProjectStillListed=board.projects.some(p=>p.id===project.id);evidence.cleanup.fixtureSummaryHistory=await rpc('summaries.history',{taskId:task.id}).catch(e=>({error:String(e)}));const base=join(process.env.HOME,'.paseo/plugin-data/paseo-ultra-kanban/removed');let files=[];try{files=await readdir(base)}catch{}const owned=files.filter(f=>f.startsWith(`${project.id}-`));evidence.cleanup.ownedBackups=owned;for(const f of owned)await rm(join(base,f));evidence.cleanup.backupsDeleted=owned;} }catch(e){evidence.cleanup.verifyRemoveError=String(e)}
 try {if(dir){await rm(dir,{recursive:true,force:true});evidence.cleanup.fixtureDirectoryExists=(await import('node:fs')).existsSync(dir)}}catch(e){evidence.cleanup.tempCleanupError=String(e)}
 try {evidence.cleanup.unarchivedSummarizers=JSON.parse(execFileSync('paseo',['agent','ls','--json','--global','--label','ultra-kanban=summarizer'],{encoding:'utf8'}));}catch(e){evidence.cleanup.summarizerQueryError=String(e)}
 evidence.finishedAt=new Date().toISOString(); await writeFile(out,JSON.stringify(evidence,null,2),{mode:0o600}); await api.dispose().catch(()=>{}); await client.close().catch(()=>{}); console.log(JSON.stringify({out,project:project?.id,task:task?.id,error:evidence.error,cleanup:evidence.cleanup},null,2));
}
