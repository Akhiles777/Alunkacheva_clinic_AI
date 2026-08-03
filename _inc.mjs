import { chromium } from "playwright";
const b=await chromium.launch(); const ctx=await b.newContext(); const p=await ctx.newPage();
// owner bypass
await p.goto("http://localhost:3000/login",{waitUntil:"networkidle"});
await p.getByRole('button',{name:'Войти как владелец'}).click(); await p.waitForTimeout(1300);
console.log("sidebar: role switcher gone:", await p.locator('select[aria-label="Роль"]').count()===0);
console.log("owner nav present:", await p.getByRole('link',{name:'Владелец'}).count()>0);
console.log("profile shows роль владелец:", (await p.locator('aside').innerText()).includes('владелец'));
// settings/staff
await p.goto("http://localhost:3000/settings/staff",{waitUntil:"networkidle"}); await p.waitForTimeout(700);
console.log("Специалисты section gone:", !(await p.getByText('Добавить специалиста').count()));
console.log("Сотрудники section:", await p.getByText('Добавить сотрудника').count()>0);
// set password for Левин account (row containing Левин А. И.)
const row = p.locator('li').filter({hasText:'Левин А. И.'}).first();
await row.locator('input[type="password"]').fill('doctorpass1'); await p.waitForTimeout(200);
await p.getByRole('button',{name:'Сохранить'}).first().click(); await p.waitForTimeout(1400);
console.log("saved:", await p.getByText('Сохранено').count()>0);
// logout
await p.getByRole('button',{name:'Выйти'}).click(); await p.waitForTimeout(1000);
// login as the doctor
await p.getByPlaceholder('you@mera.clinic').fill('doctor-stf_1@mera.local');
await p.getByPlaceholder('••••••').fill('doctorpass1');
await p.getByRole('button',{name:'Войти',exact:true}).click(); await p.waitForTimeout(1500);
console.log("doctor login → url:", new URL(p.url()).pathname);
console.log("doctor cabinet shows Левин appts:", await p.getByText('Моё расписание').count()>0, "| header name:", (await p.locator('header').innerText()).replace(/\n/g,' ').slice(0,60));
await b.close();
