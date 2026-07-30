import { chromium } from "playwright";
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1280,height:1000}})).newPage();
// SCHEDULE now from DB (full staff names + walk-ins)
await p.goto("http://localhost:3000/schedule",{waitUntil:"networkidle"}); await p.waitForTimeout(1600);
console.log("schedule shows DB staff (Левин А. И.):", await p.getByText('Левин А. И.',{exact:false}).count()>0);
console.log("schedule shows walk-in Асташов:", await p.getByText('Асташов',{exact:false}).count()>0);
// mark a planned appt arrived (Константинопольская 15:15, planned)
const card = p.locator('.border-border-soft').filter({hasText:'Константинопольская'}).first();
await card.getByRole('button',{name:'Пришёл'}).click(); await p.waitForTimeout(1200);
// OWNER report reflects it after reload (server-backed)
await p.goto("http://localhost:3000/owner",{waitUntil:"networkidle"}); await p.waitForTimeout(1000);
const tiles = await p.locator('.readout').allInnerTexts();
console.log("owner tiles:", tiles.slice(0,7));
console.log("services table rows:", await p.locator('table').last().locator('tbody tr').count());
await b.close();
