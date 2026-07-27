export const metadata = { title: "Кабинеты — Мера" };

export default function SchedulePage() {
  return (
    <div className="px-7 py-8 max-md:px-5">
      <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Кабинеты</h1>
      <p className="text-text-muted mt-3 max-w-[60ch] text-sm leading-relaxed">
        Расписание по кабинетам на день и неделю — экран волны P1. Без
        горизонтальной шкалы времени: она убрана из продукта намеренно.
      </p>
    </div>
  );
}
