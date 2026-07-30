import { SettingsHeader } from "../_components/ui";
import { getClinicSettings } from "./actions";
import { ClinicClient } from "./clinic-client";

export default async function ClinicSettingsPage() {
  const initial = await getClinicSettings();

  return (
    <>
      <SettingsHeader
        title="Клиника"
        description="Название, часовой пояс, граница отчётных суток и рабочие часы по дням недели. Исключения — праздники, санитарные и короткие дни."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <ClinicClient initial={initial} />
      </div>
    </>
  );
}
