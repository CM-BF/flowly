import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';

const out = new URL('./evidence.json', import.meta.url);
const dataDir = join(process.env.HOME, '.paseo/plugin-data/paseo-ultra-kanban');
const removedDir = join(dataDir, 'removed');
const client = new DaemonClient({ url:'ws://127.0.0.1:6767/ws', clientId:`ideas-acceptance-${randomUUID()}`, clientType:'cli', appVersion:'0.11.2', connectTimeoutMs:10000, reconnect:{enabled:false} });
const api = createPaseoApi(client);
const rpc = (m,i) => client.invokePluginRpc('paseo-ultra-kanban',m,i);
const evidence = { startedAt:new Date().toISOString(), provider:'codex/gpt-6-luna', modeIdAtCreation:'full-access', baseline:{}, fixtures:{}, checks:{}, cleanup:{} };
let dir, project, cardA, derived, worker, backupPaths=[];
const delay = ms => new Promise(r=>setTimeout(r,ms));
const err = e => String(e?.message || e);
const expectError = async (fn, needle) => { try { const value=await fn(); return {error:null,value,passed:false}; } catch(e) { return {error:err(e),passed:err(e).includes(needle)}; } };
const getTask = (b,id) => b.tasks.find(x=>x.id===id);
const getIdea = (b,id) => b.ideas.find(x=>x.id===id);
async function nativeSnapshot() {
  const projects = await api.projects.list();
  const resources = await rpc('resources.list',{});
  let agents=[];
  try { agents=JSON.parse(execFileSync('paseo',['agent','ls','--json','--all','--global'],{encoding:'utf8'})); } catch(e) { agents={error:err(e)}; }
  return { nativeProjectCount:projects.projects.length, nativeProjectIds:projects.projects.map(p=>p.projectId), agentCount:Array.isArray(agents)?agents.length:null, workspaceCount:resources.workspaces.length };
}
function slimResult(r) {
  const d=r?.structuredContent;
  return {isError:r?.isError===true, code:d?.error?.code??d?.code??null, message:d?.error?.message??d?.message??r?.content?.[0]?.text??null, ideaId:d?.result?.ideaId??d?.ideaId??null, replayed:d?.result?.replayed??d?.replayed??null};
}
try {
  await client.connect();
  evidence.baseline = await nativeSnapshot();
  const baseBoard=await rpc('board.read',{});
  evidence.baseline.board={revision:baseBoard.revision,projectCount:baseBoard.projects.length,taskCount:baseBoard.tasks.length,ideaCount:baseBoard.ideas.length};
  dir=await mkdtemp(join(tmpdir(),'paseo-ultra-kanban-ideas-'));
  evidence.fixtures.directory=dir;
  project=await rpc('projects.create',{title:`Ideas acceptance ${randomUUID().slice(0,8)}`,description:'Disposable Ideas feature acceptance fixture.',primaryPath:dir});
  evidence.fixtures.project=project;
  cardA=await rpc('tasks.create',{projectId:project.id,operationId:`ideas-card-a-${randomUUID()}`,title:'Ideas acceptance source card',description:'Disposable source card for live Ideas acceptance.',status:'todo',priority:'normal',mode:'directory'});
  evidence.fixtures.cardA=cardA;
  const preparation=await rpc('tools.prepare-session',{id:cardA.id,operationId:`ideas-prepare-${randomUUID()}`});
  evidence.fixtures.preallocatedAgentId=preparation.agentId;
  const descriptor=await api.workspaces.ref(cardA.workspaceId).refresh();
  evidence.fixtures.workspace={id:descriptor?.id,path:descriptor?.workspaceDirectory};
  worker=await api.workspaces.ref(cardA.workspaceId).agents.create({agentId:preparation.agentId,idempotencyKey:`ultra-kanban-session:${preparation.agentId}`,title:'Ideas acceptance Luna worker',labels:{'ultra-kanban-task':cardA.id},config:{provider:'codex/gpt-6-luna',modeId:'full-access',thinkingOptionId:'medium',systemPrompt:preparation.instructions,mcpServers:{'ultra-kanban':preparation.mcp}},env:{ULTRA_KANBAN_CONTEXT_FILE:preparation.contextFile,ULTRA_KANBAN_CLI:preparation.cliPath,ULTRA_KANBAN_SKILL:preparation.skillPath},prompt:'Setup only: report ready and wait for the acceptance instruction. Do not edit or create any file, do not call Kanban tools yet.'});
  evidence.fixtures.worker={id:worker.id,provider:'codex/gpt-6-luna',modeId:'full-access',createdAt:new Date().toISOString()};
  const setup=await worker.waitForFinish(180000);
  evidence.fixtures.worker.setupStatus=setup.status;
  if(setup.status!=='idle') throw new Error(`Worker setup did not finish idle: ${setup.status}`);
  evidence.fixtures.mcpUrl=preparation.mcp.url;
  const prompt=`Acceptance test only. Do not edit, create, or delete any workspace files; do not change card status; do not call any tool except kanban_get_task and kanban_propose_idea, plus the explicitly requested supplied CLI fallback. Execute in this exact order, reporting results without exposing signed request values or credentials:\n1) Call kanban_get_task; keep its current expectedRevision and request. Confirm ideas is an array.\n2) Call kanban_propose_idea with that snapshot: title "Live Ideas Bugfix Alpha", detail "Repair the fixture behavior and verify the edge case.", rationale "The acceptance run found a reproducible bug.", context "File: src/example.ts; branch: ideas-fixture; reproduce with the documented fixture input.", type "bugfix", priority "high".\n3) Call kanban_get_task again for fresh request/revision, then propose title "Live Ideas Minimal Beta", detail "Document the next investigation step.", rationale "The follow-up is useful to the user." and omit context/type/priority.\n4) Call kanban_get_task again and propose title "  live ideas bugfix alpha  " with different detail/rationale. Expect IDEA_DUPLICATE; report code/message.\n5) Call kanban_get_task again and report its returned ideas array (IDs/titles/status only).\n6) CLI fallback: run the supplied CLI's current --save-request <private file inside /tmp>, then run idea --request-file <that file> --title "Live Ideas CLI Gamma" --detail "Add a focused regression check." --rationale "The live acceptance path should stay protected." Do not pass optional fields. Report success and remove only your own private snapshot file.\nReturn concise JSON with each MCP tool result success/error code and the final get_task ideas array. Never print request/signature fields. No other actions.`;
  const started=Date.now();
  const turn=await worker.run(prompt,{timeoutMs:300000});
  evidence.fixtures.worker.turn={status:turn.status,lastMessage:turn.lastMessage,elapsedMs:Date.now()-started};
  evidence.fixtures.worker.timeline=(await worker.timeline.refetch({limit:120})).entries.map(e=>{const i=e.item; return i.type==='tool_call'?{type:i.type,name:i.name,status:i.status,detail:i.detail?.command?{command:i.detail.command.replace(/--request-file\s+\S+/g,'--request-file [snapshot]').replace(/--save-request\s+\S+/g,'--save-request [snapshot]')}:undefined}:undefined}).filter(Boolean);
  let b=await rpc('board.read',{}); let a=getTask(b,cardA.id);
  const ideasA=b.ideas.filter(i=>i.taskId===cardA.id);
  const eventTypes=b.events.filter(e=>e.taskId===cardA.id).map(e=>e.action);
  const rawPersistedBoard=JSON.parse(await readFile(join(dataDir,'board.json'),'utf8'));
  const receipts=(rawPersistedBoard.agentReceipts||[]).filter(r=>r.taskId===cardA.id);
  const reportMatch=evidence.fixtures.worker.turn.lastMessage.match(/\{[\s\S]*\}/); let workerReport=null; try { workerReport=reportMatch?JSON.parse(reportMatch[0]):null; } catch {}
  evidence.fixtures.worker.report=workerReport;
  const duplicateAttempt=(workerReport?.mcp_results||[]).find(x=>x.step===4)||(workerReport?.steps||[]).find(x=>x.step==='propose_duplicate')||workerReport?.step4_propose_idea||(workerReport?.mcp||[]).find(x=>x.tool==='kanban_propose_idea'&&x.step===4);
  const duplicateCode=duplicateAttempt?.errorCode||duplicateAttempt?.error_code||duplicateAttempt?.code;
  const expected=[{title:'Live Ideas Bugfix Alpha',detail:'Repair the fixture behavior and verify the edge case.',rationale:'The acceptance run found a reproducible bug.',context:'File: src/example.ts; branch: ideas-fixture; reproduce with the documented fixture input.',type:'bugfix',priority:'high'},{title:'Live Ideas Minimal Beta',detail:'Document the next investigation step.',rationale:'The follow-up is useful to the user.'},{title:'Live Ideas CLI Gamma',detail:'Add a focused regression check.',rationale:'The live acceptance path should stay protected.'}];
  const fieldsMatch=ideasA.length===3&&ideasA.every((idea,index)=>Object.entries(expected[index]).every(([k,v])=>idea[k]===v))&&ideasA[1].context===''&&!ideasA[1].type&&!ideasA[1].priority&&ideasA[2].context===''&&!ideasA[2].type&&!ideasA[2].priority;
  evidence.checks.proposals={ideas:ideasA,ideaCount:ideasA.length,events:b.events.filter(e=>e.taskId===cardA.id&&e.action==='idea_proposed'),receipts:receipts.filter(r=>r.action==='idea').map(r=>({action:r.action,status:r.status,agentId:r.agentId})),task:{status:a?.status,revision:a?.revision},taskBefore:{status:cardA.status,revision:cardA.revision},expectedFields:expected,fieldsMatch,duplicateAttempt:duplicateAttempt??null,cliFallback:workerReport?.cli_fallback??workerReport?.step6_cli??(workerReport?.mcp&&workerReport?.cli?{success:workerReport.cli.idea==='success',snapshotRemoved:workerReport.cli.snapshotRemoved}:null),passed:fieldsMatch&&eventTypes.filter(x=>x==='idea_proposed').length===3&&receipts.filter(r=>r.action==='idea').length===3&&receipts.filter(r=>r.action==='idea').every(r=>r.status===cardA.status)&&a?.status===cardA.status&&a?.revision===cardA.revision&&duplicateCode==='IDEA_DUPLICATE'};
  const [alpha,beta,gamma]=ideasA;
  if(alpha&&beta&&gamma){
    const dismiss1=await rpc('ideas.update',{id:beta.id,status:'dismissed'});
    const restore=await rpc('ideas.update',{id:beta.id,status:'open'});
    const dismiss2=await rpc('ideas.update',{id:beta.id,status:'dismissed'});
    b=await rpc('board.read',{});
    evidence.checks.ideaTransitions={results:[dismiss1,restore,dismiss2],events:b.events.filter(e=>e.taskId===cardA.id&&['idea_dismissed','idea_restored'].includes(e.action)),finalStatus:getIdea(b,beta.id)?.status,passed:b.events.some(e=>e.taskId===cardA.id&&e.action==='idea_dismissed')&&b.events.some(e=>e.taskId===cardA.id&&e.action==='idea_restored')&&getIdea(b,beta.id)?.status==='dismissed'};
    derived=await rpc('tasks.create',{projectId:project.id,operationId:`ideas-derived-${randomUUID()}`,title:alpha.title,description:'Repair the fixture behavior and verify the edge case.\n\nWhy: The acceptance run found a reproducible bug.\n\nContext:\nFile: src/example.ts; branch: ideas-fixture; reproduce with the documented fixture input.\n\nFrom card: Ideas acceptance source card ('+cardA.id+')',status:'todo',priority:'high',type:'bugfix',mode:'directory',ideaId:alpha.id});
    evidence.fixtures.derived=derived;
    const workspaceCountAfterAccepted=(await rpc('resources.list',{})).workspaces.length;
    b=await rpc('board.read',{});
    const derivedContext=await rpc('tasks.context',{id:derived.id});
    const workspaceCountAfter=(await rpc('resources.list',{})).workspaces.length;
    const secondCreate=await expectError(()=>rpc('tasks.create',{projectId:project.id,operationId:`ideas-reuse-${randomUUID()}`,title:'Should not create',description:'',status:'todo',priority:'normal',mode:'directory',ideaId:alpha.id}),'This idea is no longer open.');
    const acceptedUpdate=await expectError(()=>rpc('ideas.update',{id:alpha.id,status:'dismissed'}),'already became a card');
    b=await rpc('board.read',{});
    evidence.checks.acceptanceAndCreate={origin:getTask(b,derived.id)?.origin,idea:getIdea(b,alpha.id),acceptedEvents:b.events.filter(e=>e.taskId===cardA.id&&e.action==='idea_accepted'),derivedContext:derivedContext.context,taskContextHasDerivedLine:derivedContext.context.includes(`Derived from card: ${cardA.title} (${cardA.id})`),workspaceCountAfterAccepted,workspaceCountAfterRejected:workspaceCountAfter,secondCreate:{error:secondCreate.error,passed:secondCreate.passed},acceptedUpdate:{error:acceptedUpdate.error,passed:acceptedUpdate.passed},passed:getTask(b,derived.id)?.origin?.ideaId===alpha.id&&getIdea(b,alpha.id)?.status==='accepted'&&getIdea(b,alpha.id)?.acceptedTaskId===derived.id&&b.events.some(e=>e.taskId===cardA.id&&e.action==='idea_accepted')&&derivedContext.context.includes(`Derived from card: ${cardA.title} (${cardA.id})`)&&workspaceCountAfterAccepted===workspaceCountAfter&&secondCreate.passed&&acceptedUpdate.passed};
  }
  const beforeDelete=await rpc('board.read',{});
  const fixtureDirectoryEntries=await readdir(dir);
  evidence.checks.noWorkspaceFileEdits={directory:dir,entries:fixtureDirectoryEntries,passed:fixtureDirectoryEntries.length===0};
  const currentA=getTask(beforeDelete,cardA.id);
  const deleteResult=await rpc('tasks.delete',{id:cardA.id,revision:currentA.revision,archive:false});
  backupPaths.push(deleteResult.backup);
  const backup=JSON.parse(await readFile(deleteResult.backup,'utf8'));
  b=await rpc('board.read',{});
  evidence.checks.deleteSource={deleteResult,backupPath:deleteResult.backup,backupIdeas:backup.ideas,boardSourceIdeas:b.ideas.filter(i=>i.taskId===cardA.id),derivedOrigin:getTask(b,derived?.id)?.origin,passed:backup.ideas.length===3&&b.ideas.every(i=>i.taskId!==cardA.id)&&getTask(b,derived?.id)?.origin?.taskId===cardA.id};
  evidence.fixtures.nativeBeforeCleanup=await nativeSnapshot();
} catch(e) { evidence.error=String(e?.stack||e); }
finally {
  try { if(worker) { await worker.archive(); evidence.cleanup.workerArchived=Boolean((await api.agents.ref(worker.id).refresh())?.agent?.archivedAt); } } catch(e) { evidence.cleanup.workerArchiveError=err(e); }
  try { if(project) { const b=await rpc('board.read',{}); const p=b.projects.find(x=>x.id===project.id); if(p) { evidence.cleanup.removeProject=await rpc('projects.remove',{id:p.id,revision:p.revision,alsoPaseo:true}); if(evidence.cleanup.removeProject?.backup) backupPaths.push(evidence.cleanup.removeProject.backup); } } } catch(e) { evidence.cleanup.projectRemoveError=err(e); }
  try { evidence.cleanup.nativeAfter=await nativeSnapshot(); evidence.cleanup.nativeProjectStillListed=project?evidence.cleanup.nativeAfter.nativeProjectIds.includes(project.paseoProjectId):null; const b=await rpc('board.read',{}); evidence.cleanup.boardProjectStillListed=project?b.projects.some(p=>p.id===project.id):null; evidence.cleanup.derivedCardStillListed=derived?b.tasks.some(t=>t.id===derived.id):null; } catch(e) { evidence.cleanup.verifyError=err(e); }
  try { for(const file of backupPaths) { await rm(file,{force:true}); } evidence.cleanup.ownedBackupsRemoved=backupPaths.every(f=>!existsSync(f)); } catch(e) { evidence.cleanup.backupCleanupError=err(e); }
  try { if(dir) await rm(dir,{recursive:true,force:true}); evidence.cleanup.tempDirectoryExists=dir?existsSync(dir):false; } catch(e) { evidence.cleanup.tempCleanupError=err(e); }
  evidence.finishedAt=new Date().toISOString();
  await mkdir(new URL('.',out),{recursive:true}).catch(()=>{});
  await writeFile(out,JSON.stringify(evidence,null,2),{mode:0o600});
  await api.dispose().catch(()=>{}); await client.close().catch(()=>{});
  console.log(JSON.stringify({out:String(out),fixtures:evidence.fixtures,checks:Object.fromEntries(Object.entries(evidence.checks).map(([k,v])=>[k,v?.passed])),cleanup:evidence.cleanup,error:evidence.error},null,2));
}
