import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { listTemplates } from "@/lib/server/message-templates";
import { getSession } from "@/lib/server/session";
import { TemplatesClient, type TemplatesData } from "./templates-client";

const DEFAULT_QUICK_REPLIES = [
  "Здравствуйте! Чем можем помочь?",
  "Подскажите ваш телефон для записи.",
  "Спасибо за обращение, хорошего дня!",
];

export default async function TemplatesSettingsPage() {
  /**
   * Шаблоны — из доменной таблицы, быстрые ответы — из настройки: первые нужны
   * провайдеру и отправляются пациенту, вторые только подставляются в поле
   * ввода администратора.
   */
  const session = await getSession();
  const templates = await listTemplates(session.companyId);
  const stored = (await getSection("templates")) as { quickReplies?: string[] } | null;
  const initial: TemplatesData = {
    templates,
    quickReplies: stored?.quickReplies?.length ? stored.quickReplies : DEFAULT_QUICK_REPLIES,
  };

  return (
    <>
      <SettingsHeader
        title="Шаблоны"
        description="Шаблоны WhatsApp: вне 24-часового окна пациенту можно писать только согласованным у провайдера шаблоном. Переменные подставляются при отправке — из карточки пациента и его ближайшей записи. Быстрые ответы вставляются в поле ввода администратора."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <TemplatesClient initial={initial} />
      </div>
    </>
  );
}
