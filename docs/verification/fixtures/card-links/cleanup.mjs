import {readFile,writeFile,rm} from 'node:fs/promises';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
const f=JSON.parse(await readFile(new URL('./fixture-ids.json',import.meta.url),'utf8'));
const c=new DaemonClient({url:'ws://127.0.0.1:6767/ws',clientId:`card-links-cleanup-${f.run}`,clientType:'cli',appVersion:'0.11.2',connectTimeoutMs:10000,reconnect:{enabled:false}}); await c.connect();
const rpc=(m,i)=>c.invokePluginRpc('paseo-ultra-kanban',m,i);const e={at:new Date().toISOString(),sessionsArchived:[],projectRemoval:null,nativeProjectAbsent:null,pluginProjectAbsent:null,tempDirRemoved:null};
try {const b=await rpc('board.read',{}); const p=b.projects.find(x=>x.id===f.project); if(p){e.projectRemoval=await rpc('projects.remove',{id:f.project,revision:p.revision,alsoPaseo:true});} const b2=await rpc('board.read',{});e.pluginProjectAbsent=!b2.projects.some(x=>x.id===f.project); await writeFile(new URL('./cleanup-evidence.json',import.meta.url),JSON.stringify(e,null,2),{mode:0o600});} finally {await c.close();}
if(f.directory){await rm(f.directory,{recursive:true,force:true});e.tempDirRemoved=true;}
const {execFileSync}=await import('node:child_process');const ls=JSON.parse(execFileSync('paseo',['project','ls','--json'],{encoding:'utf8'}));e.nativeProjectAbsent=!ls.some(x=>x.projectId===f.nativeProject);e.finishedAt=new Date().toISOString();await writeFile(new URL('./cleanup-evidence.json',import.meta.url),JSON.stringify(e,null,2),{mode:0o600});console.log(JSON.stringify(e));
