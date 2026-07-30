import { settingsStore } from "@/app/_data/settings";
import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { NotificationsClient } from "./notifications-client";

type NotificationsSettings = typeof settingsStore.notifications;

export default async function NotificationsSettingsPage() {
  const stored = (await getSection("notifications")) as NotificationsSettings | null;
  const initial = stored ?? settingsStore.notifications;

  return (
    <>
      <SettingsHeader
        title="Уведомления"
        description="Когда доставлять уведомления: сразу или копить до начала смены. По умолчанию воскресенье копится до понедельника. Ночные часы — не беспокоить."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <NotificationsClient initial={initial} />
      </div>
    </>
  );
}
