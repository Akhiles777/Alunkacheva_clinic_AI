import { settingsStore } from "@/app/_data/settings";
import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { TemplatesClient, type TemplatesData } from "./templates-client";

const DEFAULT_QUICK_REPLIES = [
  "Здравствуйте! Чем можем помочь?",
  "Подскажите ваш телефон для записи.",
  "Спасибо за обращение, хорошего дня!",
];

export default async function TemplatesSettingsPage() {
  const stored = (await getSection("templates")) as TemplatesData | null;
  const initial: TemplatesData = stored ?? {
    templates: settingsStore.templates,
    quickReplies: DEFAULT_QUICK_REPLIES,
  };

  return (
    <>
      <SettingsHeader
        title="Шаблоны"
        description="Шаблоны WhatsApp: вне 24-часового окна пациенту можно писать только согласованным у провайдера шаблоном. Быстрые ответы — вставляются в поле ввода администратора."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <TemplatesClient initial={initial} />
      </div>
    </>
  );
}
