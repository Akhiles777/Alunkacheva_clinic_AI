import { SettingsHeader } from "../_components/ui";
import { getRooms } from "./actions";
import { RoomsClient } from "./rooms-client";

export default async function RoomsSettingsPage() {
  const initial = await getRooms();

  return (
    <>
      <SettingsHeader
        title="Кабинеты"
        description="Кабинеты клиники: название и направление — из подсказок или свои. Специалисты закрепляются по желанию. Кабинет, занятый услугой или визитами, удалить нельзя — только деактивировать."
      />
      <RoomsClient initial={initial} />
    </>
  );
}
