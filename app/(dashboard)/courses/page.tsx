export const metadata = { title: "Курсы — Мера" };

export default function CoursesPage() {
  return (
    <div className="px-7 py-8 max-md:px-5">
      <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Курсы</h1>
      <p className="text-text-muted mt-3 max-w-[60ch] text-sm leading-relaxed">
        Трекинг курсов — выпавшие из графика, на финише, активные. Экран волны P1,
        по приоритизации из IA идёт после связки «Сегодня · Диалоги · запись».
      </p>
    </div>
  );
}
