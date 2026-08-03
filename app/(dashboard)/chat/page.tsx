import { InternalStaffChat } from "./internal-staff-chat";

export const metadata = { title: "Чат сотрудников" };

export default function StaffChatPage() {
  return (
    <>
      <header className="border-border flex-none border-b px-7 py-[18px] max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Чат сотрудников</h1>
        <p className="text-text-muted mt-1 text-xs">общий канал клиники и личные диалоги</p>
      </header>

      <div className="min-h-0 flex-1 px-7 py-6 max-md:px-3 max-md:py-3">
        <InternalStaffChat />
      </div>
    </>
  );
}
