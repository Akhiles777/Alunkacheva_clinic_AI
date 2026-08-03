import { notFound } from "next/navigation";
import { SettingsHeader } from "../../_components/ui";
import { getStaffMember } from "./actions";
import { StaffMemberClient } from "./staff-member-client";

export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const member = await getStaffMember(id);
  if (!member) notFound();

  return (
    <>
      <SettingsHeader
        title={member.name}
        description="Персональные права доступа и работа сотрудника в цифрах. Права здесь перекрывают матрицу роли: что настроено лично — то и действует."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <StaffMemberClient initial={member} />
      </div>
    </>
  );
}
