/**
 * Служебная проверка контраста: собирает все видимые текстовые узлы на
 * странице и считает WCAG-коэффициент по фактически отрисованным цветам.
 * Запуск: node contrast-check.mjs (нужен dev-сервер на :3000).
 */
import { chromium } from "playwright";

const pages = ["http://localhost:3000/?period=month", "http://localhost:3000/states"];

const browser = await chromium.launch();
let failures = 0;

for (const url of pages) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto(url, { waitUntil: "networkidle" });

  const report = await page.evaluate(() => {
    const toLinear = (channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]) =>
      0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    const parse = (color) => color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const alpha = (color) => {
      const parts = color.match(/\d+(\.\d+)?/g);
      return parts && parts.length > 3 ? Number(parts[3]) : 1;
    };
    const mix = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));

    const effectiveBackground = (element) => {
      let current = element;
      let result = [255, 255, 255];
      const stack = [];
      while (current) {
        const style = getComputedStyle(current);
        const a = alpha(style.backgroundColor);
        if (a > 0) stack.push([parse(style.backgroundColor), a]);
        current = current.parentElement;
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        result = mix(stack[i][0], result, stack[i][1]);
      }
      return result;
    };

    const results = [];
    for (const element of document.querySelectorAll("*")) {
      const text = [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .join("")
        .trim();
      if (!text) continue;

      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      const fg = parse(style.color);
      const bg = effectiveBackground(element);
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const ratio =
        (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = isLarge ? 3 : 4.5;

      if (ratio < required) {
        results.push({
          text: text.slice(0, 40),
          color: style.color,
          size,
          weight,
          ratio: Number(ratio.toFixed(2)),
          required,
        });
      }
    }
    return results;
  });

  console.log(`\n${url}`);
  if (report.length === 0) {
    console.log("  контраст AA: нарушений нет");
  } else {
    failures += report.length;
    for (const row of report) console.log("  ", JSON.stringify(row));
  }
  await page.close();
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
