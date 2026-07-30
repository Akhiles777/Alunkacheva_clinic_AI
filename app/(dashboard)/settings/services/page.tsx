import { SettingsHeader } from "../_components/ui";
import { getServices } from "./actions";
import { ServicesClient } from "./services-client";

export default async function ServicesSettingsPage() {
  const initial = await getServices();

  return (
    <>
      <SettingsHeader
        title="Услуги"
        description="Название, направление, длительность, цена, активность. Флаг «продаётся курсом» с размером курса и порогом выпадения из графика. Кабинеты, где услуга проводится, — знаменатель загрузки по услугам. Услугу с визитами удалить нельзя — только деактивировать."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <ServicesClient initial={initial} />
      </div>
    </>
  );
}
