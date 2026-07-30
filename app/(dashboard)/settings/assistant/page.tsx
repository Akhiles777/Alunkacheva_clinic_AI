import { settingsStore } from "@/app/_data/settings";
import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { getServices } from "../services/actions";
import { AssistantClient, type AssistantData } from "./assistant-client";

export default async function AssistantSettingsPage() {
  const stored = (await getSection("assistant")) as AssistantData | null;
  const initial: AssistantData = stored ?? {
    assistant: settingsStore.assistant,
    knowledge: settingsStore.knowledge,
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
