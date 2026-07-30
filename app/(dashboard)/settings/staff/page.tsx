import { SettingsHeader } from "../_components/ui";
import { getRoleMatrix } from "./actions";
import { getStaffPeople } from "./people-actions";
import { StaffClient } from "./staff-client";

export default async function StaffSettingsPage() {
  const [initialMatrix, initialPeople] = await Promise.all([getRoleMatrix(), getStaffPeople()]);

  return (
    <>
      <SettingsHeader
        title="Сотрудники"
        description="Специалисты и их кабинеты, учётные записи и роли. Всё хранится в базе: добавление, редактирование, удаление. Матрица прав определяет доступ — проверка идёт на сервере."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <StaffClient initialMatrix={initialMatrix} initialPeople={initialPeople} />
      </div>
    </>
  );
}
