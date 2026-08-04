import { settingsStore } from "@/app/_data/settings";
import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { getKnowledge } from "./actions";
import { getServices } from "../services/actions";
import { AssistantClient, type AssistantData } from "./assistant-client";

export default async function AssistantSettingsPage() {
  // Конфигурация — из JSON-настройки, база знаний — из доменной таблицы, той
  // самой, откуда её читает агент.
  const stored = (await getSection("assistant")) as Partial<AssistantData> | null;
  const knowledge = await getKnowledge();
  const initial: AssistantData = {
    assistant: stored?.assistant ?? settingsStore.assistant,
    knowledge,
  };

  // Опции услуг для привязки записей базы знаний — из доменной таблицы Service.
  const { services } = await getServices();
  const serviceOptions = services.map((s) => ({ id: s.id, title: s.title }));

  return (
    <>
      <SettingsHeader
        title="Ассистент"
        description="Ассистент отвечает только текстами из базы знаний и не сочиняет. По умолчанию — только черновики: администратор отправляет. При стоп-словах молчит и зовёт человека."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <AssistantClient initial={initial} serviceOptions={serviceOptions} />
      </div>
    </>
  );
}
