import { chromium } from "playwright";
const S=process.env.S;
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true});
const p=await ctx.newPage();
await p.goto("http://localhost:3000/patients",{waitUntil:"networkidle"}); await p.waitForTimeout(500);
// click first patient row
await p.locator('text=Гринберг Ирина Львовна').first().click(); await p.waitForTimeout(700);
console.log("url:", p.url());
const bodyW=await p.evaluate(()=>document.body.scrollWidth), winW=await p.evaluate(()=>window.innerWidth);
console.log("patient detail scrollW:",bodyW,"winW:",winW, bodyW>winW+2?"⚠ H-SCROLL":"ok");
await p.screenshot({path:`${S}/m-patient-detail.png`, fullPage:false});
// open booking/call modal from home
await p.goto("http://localhost:3000/",{waitUntil:"networkidle"}); await p.waitForTimeout(500);
await p.locator('text=Занести звонок').first().click(); await p.waitForTimeout(600);
await p.screenshot({path:`${S}/m-call-form.png`});
const bw2=await p.evaluate(()=>document.body.scrollWidth);
console.log("call form scrollW:",bw2, bw2>winW+2?"⚠ H-SCROLL":"ok");
await b.close();
