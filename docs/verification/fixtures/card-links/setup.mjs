import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { execFileSync } from 'node:child_process';
const run = randomUUID();
const client = new DaemonClient({ url:'ws://127.0.0.1:6767/ws', clientId:`card-links-${run}`, clientType:'cli', appVersion:'0.11.2', connectTimeoutMs:10000, reconnect:{enabled:false} });
const api = createPaseoApi(client);
const rpc = (method,input) => client.invokePluginRpc('paseo-ultra-kanban',method,input);
const fixture={run,startedAt:new Date().toISOString(),directory:null,project:null,nativeProject:null,cards:[],sessions:[],operationIds:{project:`card-links-project-${run}`,cards:[`card-links-A-${run}`,`card-links-B-${run}`,`card-links-C-${run}`]},cleanup:{}};
await client.connect();
try {
 fixture.directory=await mkdtemp(join(tmpdir(),'paseo-kanban-card-links-'));
 execFileSync('git',['init','-q'],{cwd:fixture.directory});
 execFileSync('git',['-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','commit','--allow-empty','-m','fixture'],{cwd:fixture.directory});
 await writeFile(new URL('./fixture-plan.json',import.meta.url),JSON.stringify(fixture,null,2),{mode:0o600});
 const p=await rpc('projects.create',{title:`Card Links ${run.slice(0,8)}`,description:'Disposable card links acceptance fixture.',primaryPath:fixture.directory});
 fixture.project=p.id; fixture.nativeProject=p.paseoProjectId;
 await writeFile(new URL('./fixture-ids.json',import.meta.url),JSON.stringify(fixture,null,2),{mode:0o600});
 for (const [i,title] of ['Card Links A','Card Links B','Card Links C'].entries()) {
   const t=await rpc('tasks.create',{projectId:p.id,operationId:fixture.operationIds.cards[i],title:`${title} ${run.slice(0,8)}`,description:'Disposable card links acceptance fixture.',status:'todo',priority:'normal',mode:'directory'});
   fixture.cards.push({id:t.id,workspaceId:t.workspaceId,title:t.title});
   await writeFile(new URL('./fixture-ids.json',import.meta.url),JSON.stringify(fixture,null,2),{mode:0o600});
 }
 const b=await rpc('board.read',{});
 fixture.boardRevision=b.revision;
 await writeFile(new URL('./fixture-ids.json',import.meta.url),JSON.stringify(fixture,null,2),{mode:0o600});
 console.log(JSON.stringify({status:'ready',run,project:fixture.project,nativeProject:fixture.nativeProject,directory:fixture.directory,cards:fixture.cards}));
} catch(e) { fixture.setupError=String(e); await writeFile(new URL('./fixture-ids.json',import.meta.url),JSON.stringify(fixture,null,2),{mode:0o600}); console.log(JSON.stringify({status:'failed',error:fixture.setupError,fixture})); process.exitCode=1; }
finally { await api.dispose().catch(()=>{}); await client.close().catch(()=>{}); }
