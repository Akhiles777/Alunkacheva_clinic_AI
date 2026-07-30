import { chromium } from "playwright";
const S=process.env.S;
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true});
const p=await ctx.newPage();
// patient overlay
await p.goto("http://localhost:3000/patients",{waitUntil:"networkidle"}); await p.waitForTimeout(500);
await p.locator('text=Гринберг Ирина Львовна').first().click(); await p.waitForTimeout(700);
let bw=await p.evaluate(()=>document.body.scrollWidth), ww=await p.evaluate(()=>window.innerWidth);
console.log("patient overlay scrollW:",bw, bw>ww+2?"⚠ H-SCROLL":"ok");
await p.screenshot({path:`${S}/m-patient-overlay.png`});
// call form: scroll to button then click
await p.goto("http://localhost:3000/",{waitUntil:"networkidle"}); await p.waitForTimeout(500);
const btn = p.locator('button', {hasText:'Занести звонок'}).first();
await btn.scrollIntoViewIfNeeded(); await btn.click(); await p.waitForTimeout(600);
bw=await p.evaluate(()=>document.body.scrollWidth);
console.log("call form scrollW:",bw, bw>ww+2?"⚠ H-SCROLL":"ok");
await p.screenshot({path:`${S}/m-call-form.png`});
await b.close();
