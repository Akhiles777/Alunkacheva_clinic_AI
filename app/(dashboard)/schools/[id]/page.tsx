import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import { getSchool } from "@/lib/server/promos";
import { absoluteUrl } from "@/lib/server/app-url";
import { SchoolClient } from "./school-client";

export const metadata = { title: "Школа-партнёр" };

/**
 * Школа-партнёр: итоги, пациенты по привязкам и ссылка отчёта. Пациенты здесь
 * поимённо — это экран клиники; школа видит только свою ссылку с итогами.
 */
export default async function SchoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const [canEdit, canMessage] = await Promise.all([can(session, "EDIT_SETTINGS"), can(session, "MESSAGE_PATIENTS")]);
  if (!canEdit && !canMessage) notFound();
  const school = await getSchool(session.companyId, id);
  if (!school) notFound();
  const path = `/partner/${school.reportToken}`;
  // Без DOMAIN (демо-стенд, локальный запуск) — адрес, по которому открыт экран:
  // относительную ссылку школе не переслать.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  const reportUrl = absoluteUrl(path) ?? (host ? `${proto}://${host}${path}` : path);
  return <SchoolClient school={school} reportUrl={reportUrl} canEdit={canEdit} />;
}
