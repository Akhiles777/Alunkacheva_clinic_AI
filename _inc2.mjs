import { chromium } from "playwright";
const b=await chromium.launch(); const p=await (await b.newContext()).newPage();
await p.goto("http://localhost:3000/login",{waitUntil:"networkidle"});
await p.getByRole('button',{name:'Войти как владелец'}).click(); await p.waitForTimeout(1200);
await p.goto("http://localhost:3000/settings/staff",{waitUntil:"networkidle"}); await p.waitForTimeout(700);
// add a new doctor account
await p.getByRole('button',{name:'+ Добавить сотрудника'}).click(); await p.waitForTimeout(200);
await p.getByPlaceholder('Имя сотрудника').last().fill('Тестовый Врач');
await p.getByPlaceholder('логин (почта)').last().fill('vrach@mera.clinic');
await p.locator('select[aria-label^="Роль"]').last().selectOption('DOCTOR');
await p.getByPlaceholder('пароль (не короче 6)').last().fill('vrachpass1');
await p.getByRole('button',{name:'Сохранить'}).first().click(); await p.waitForTimeout(1500);
console.log("saved new doctor:", await p.getByText('Сохранено').count()>0);
// logout + login as the new doctor
await p.getByRole('button',{name:'Выйти'}).click(); await p.waitForTimeout(1000);
await p.getByPlaceholder('you@mera.clinic').fill('vrach@mera.clinic');
await p.getByPlaceholder('••••••').fill('vrachpass1');
await p.getByRole('button',{name:'Войти',exact:true}).click(); await p.waitForTimeout(1500);
console.log("doctor login → url:", new URL(p.url()).pathname);
console.log("sidebar shows Мой кабинет (doctor nav):", await p.getByRole('link',{name:'Мой кабинет'}).count()>0);
console.log("profile name:", (await p.locator('aside').innerText()).split('\n').filter(x=>x.includes('Тестовый')||x.includes('врач')).slice(0,2));
await b.close();
