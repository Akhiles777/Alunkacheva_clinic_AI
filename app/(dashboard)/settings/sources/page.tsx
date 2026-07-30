import { SettingsHeader } from "../_components/ui";
import { getSources } from "./actions";
import { SourcesClient } from "./sources-client";

export default async function SourcesSettingsPage() {
  const initial = await getSources();

  return (
    <>
      <SettingsHeader
        title="Источники"
        description="Справочник источников обращений. Порядок — как в форме занесения звонка: самые частые сверху. Можно добавлять свои; источник с историей удалить нельзя — только деактивировать."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <SourcesClient initial={initial} />
      </div>
    </>
  );
}
