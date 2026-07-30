import { SettingsHeader } from "../_components/ui";
import { getAuditLog } from "./actions";
import { AuditClient } from "./audit-client";

export default async function AuditSettingsPage() {
  const rows = await getAuditLog();

  return (
    <>
      <SettingsHeader
        title="Аудит"
        description="Кто и когда открывал карточку пациента, менял настройки, отправлял сообщения. Только чтение."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <AuditClient rows={rows} />
      </div>
    </>
  );
}
