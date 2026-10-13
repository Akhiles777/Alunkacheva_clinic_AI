/**
 * Калькулятор аналитика владельца.
 *
 * Модели запрещено считать самой (§8: она уже сложила дневные суммы и назвала
 * 300 100 ₽ там, где было 396 080 ₽). Но вопрос «сколько это в процентах» или
 * «на сколько больше» без арифметики не ответить — поэтому арифметику делает
 * код, а модель только записывает выражение. Только числа, + − × ÷, скобки и
 * проценты: ни переменных, ни функций, ни `eval`.
 */

export function calculate(expression: string): number {
  const src = expression.replace(/\s+/g, "").replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  if (!/^[\d.+\-*/()%]+$/.test(src)) throw new Error("в выражении допустимы только числа, + - * / ( ) и %");
  let i = 0;

  const peek = () => src[i];
  function number(): number {
    const m = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error(`ожидалось число на позиции ${i + 1}`);
    i += m[0].length;
    let v = Number(m[0]);
    // «15%» — пятнадцать сотых.
    if (peek() === "%") {
      i += 1;
      v /= 100;
    }
    return v;
  }
  function factor(): number {
    if (peek() === "-") {
      i += 1;
      return -factor();
    }
    if (peek() === "+") {
      i += 1;
      return factor();
    }
    if (peek() === "(") {
      i += 1;
      const v = expr();
      if (peek() !== ")") throw new Error("не закрыта скобка");
      i += 1;
      return v;
    }
    return number();
  }
  function term(): number {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++];
      const r = factor();
      if (op === "/" && r === 0) throw new Error("деление на ноль");
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  const v = expr();
  if (i !== src.length) throw new Error(`лишний символ на позиции ${i + 1}`);
  if (!Number.isFinite(v)) throw new Error("результат не число");
  return Math.round(v * 100) / 100;
}
