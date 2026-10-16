import { chromium } from '/Users/bofan.wang/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
const f=JSON.parse(await readFile(new URL('./fixture-ids.json',import.meta.url),'utf8'));
const out={startedAt:new Date().toISOString(),checks:{},errors:[],screenshots:[]};
const browser=await chromium.launch({headless:true}); const ctx=await browser.newContext({viewport:{width:1440,height:900},colorScheme:'light'}); await ctx.grantPermissions(['local-network-access'],{origin:'https://app.paseo.sh'}); const page=await ctx.newPage(); page.setDefaultTimeout(9000); page.on('console',m=>{if(m.type()==='error')out.errors.push(m.text().slice(0,300))}); page.on('pageerror',e=>out.errors.push(String(e).slice(0,300)));
const snap=async n=>{await page.screenshot({path:new URL(`../../card-links-${n}.png`,import.meta.url).pathname});out.screenshots.push(`card-links-${n}.png`)};
const txt=()=>page.locator('body').innerText();
try {
 await page.goto('https://app.paseo.sh',{waitUntil:'networkidle',timeout:45000}); await page.getByText('Ultra Kanban',{exact:true}).click(); await page.getByText(`Card Links ${f.run.slice(0,8)}`,{exact:true}).click(); await page.getByText(f.cards[0].title,{exact:true}).last().waitFor(); await snap('board-desktop-light');
 await page.getByText(f.cards[0].title,{exact:true}).last().click(); await page.getByText('Links',{exact:true}).waitFor(); await page.getByText('Links',{exact:true}).scrollIntoViewIfNeeded(); await snap('drawer-desktop-light'); out.checks.drawerInitial=(await txt()).includes('Links');
 // Open card context menu via right click
 await page.getByText(f.cards[0].title,{exact:true}).last().click({button:'right'}); await page.getByText('Link to a card…',{exact:true}).waitFor(); out.checks.menu=['Link to a card…','New follow-up task'].every(x=>txt().includes(x)); await snap('menu-desktop-light');
 await page.getByText('Link to a card…',{exact:true}).click(); await page.getByText('Blocked by',{exact:true}).waitFor(); await snap('modal-desktop-light'); out.checks.modalChoices=['Related','Blocks','Blocked by','Follow-up of'].every(x=>txt().includes(x));
 out.checks.modalText=(await txt()).slice(-2500);
} catch(e){out.failure=String(e.stack||e).slice(0,1200); try{out.pageText=(await txt()).slice(-3000)}catch{}}
finally{out.finishedAt=new Date().toISOString();await writeFile(new URL('./ui-evidence.json',import.meta.url),JSON.stringify(out,null,2),{mode:0o600});await ctx.close();await browser.close();console.log(JSON.stringify(out));}
