import { SettingsHeader } from "../_components/ui";
import { getIntegrations } from "./actions";
import { IntegrationsClient } from "./integrations-client";
import { YclientsBlock } from "./yclients-block";
import { InstagramBlock } from "./instagram-block";

/**
 * Интеграции — первый серверный срез: данные читаются из БД (таблица
 * Credential), значения зашифрованы и приходят только маской. Сохранение и
 * проверка связи идут через server actions с проверкой прав и аудитом.
 */
export default async function IntegrationsSettingsPage() {
  const blocks = await getIntegrations();

  return (
    <>
      <SettingsHeader
        title="Интеграции"
        description="YCLIENTS, Instagram, WhatsApp: статус соединения и проверка связи. Все значения хранятся зашифрованными в базе и показываются маской — полностью не отображаются никогда."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <div className="flex max-w-[760px] flex-col gap-5">
          <IntegrationsClient initial={blocks} />
          <YclientsBlock />
          <InstagramBlock />
        </div>
      </div>
    </>
  );
}
