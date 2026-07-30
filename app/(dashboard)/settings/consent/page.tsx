import { SettingsHeader } from "../_components/ui";
import { getConsent } from "./actions";
import { ConsentClient } from "./consent-client";

export default async function ConsentSettingsPage() {
  const initial = await getConsent();

  return (
    <>
      <SettingsHeader
        title="Согласие"
        description="Текст согласия на обработку персональных данных и его версия. При смене версии согласие запрашивается у пациентов заново."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <ConsentClient initial={initial} />
      </div>
    </>
  );
}
