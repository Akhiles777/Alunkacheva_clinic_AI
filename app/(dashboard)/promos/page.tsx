import { headers } from "next/headers";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { getSchoolPromoView } from "@/lib/server/promos";
import { appUrl } from "@/lib/server/app-url";
import { SchoolPromoClient } from "./school-promo-client";

export const metadata = { title: "Школьный ресурс" };

/**
 * Акция у клиники одна — «Школьный check-up» (решение заказчика, 15 октября),
 * и экран один: участники, школы, условия. Всё правится руками: добавить и
 * убрать пациента, отметить «прошёл» и тем самым начислить бонус, снять бонус,
 * сменить школу. Автоматика (визит «пришёл» по услуге акции) работает рядом и
 * ручного не перетирает.
 */
export default async function PromosPage() {
  const session = await getSession();
  const [canEdit, canMessage] = await Promise.all([can(session, "EDIT_SETTINGS"), can(session, "MESSAGE_PATIENTS")]);
  if (!canEdit && !canMessage) {
    return (
      <div className="flex-1 overflow-auto px-7 py-8 max-md:px-5">
        <h1 className="text-xl leading-none font-medium tracking-[-0.015em]">Школьный ресурс</h1>
        <p className="text-text-muted mt-3 max-w-[60ch] text-sm leading-relaxed">
          Раздел доступен тем, кто ведёт переписку с пациентами или настройки клиники.
        </p>
      </div>
    );
  }
  const view = await getSchoolPromoView(session.companyId);
  // Ссылка для школы — полным адресом: относительную школе не переслать.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const base = appUrl() ?? (host ? `${proto}://${host}` : "");
  return (
    <SchoolPromoClient
      view={view}
      reportBase={base}
      canEdit={canEdit}
      canMessage={canMessage}
      canApprove={session.role === "DOCTOR" || session.role === "OWNER"}
      canReview={session.role === "ADMIN" || session.role === "OWNER"}
    />
  );
}
