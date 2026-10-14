import { notFound } from "next/navigation";
import { getSession } from "@/lib/server/session";
import { can } from "@/lib/server/authz";
import {
  getPromo,
  promoServiceChoices,
  type PromoDetail,
} from "@/lib/server/promos";
import { clinicDateKey } from "@/lib/clinic-time";
import { PromoClient, type PromoView } from "./promo-client";

export const metadata = { title: "Акция" };

/**
 * Новая акция открывается заполненной данными «Школьного check-up» с макета
 * клиники. Услуги НЕ подставляются: какие строки прайса YCLIENTS засчитывать,
 * решает клиника — угадать их по цене значило бы засчитывать чужие визиты.
 */
const SCHOOL_CHECKUP: Omit<PromoView, "id"> = {
  name: "Школьный check-up",
  description:
    "Школьникам 6–14 лет, один визит: приём детского остеопата, диагностика у БОС-специалиста, " +
    "лабораторные анализы (ОАК, ферритин, витамин D, общий анализ мочи), экспертная расшифровка и рекомендации.",
  priceTotal: 6300,
  priceRegular: 9360,
  ageMin: 6,
  ageMax: 14,
  serviceIds: [],
  startsOn: clinicDateKey(),
  endsOn: "2026-11-15",
  bonusAmount: 500,
  isActive: true,
  agentEnabled: false,
};

function viewOf(p: PromoDetail): PromoView {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    priceTotal: p.priceTotal,
    priceRegular: p.priceRegular,
    ageMin: p.ageMin,
    ageMax: p.ageMax,
    serviceIds: p.serviceIds,
    startsOn: clinicDateKey(new Date(p.startsAt)),
    endsOn: clinicDateKey(new Date(p.endsAt)),
    bonusAmount: p.bonusAmount,
    isActive: p.isActive,
    agentEnabled: p.agentEnabled,
  };
}

export default async function PromoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();
  const [canEdit, canMessage] = await Promise.all([
    can(session, "EDIT_SETTINGS"),
    can(session, "MESSAGE_PATIENTS"),
  ]);
  if (!canEdit && !canMessage) notFound();
  if (id === "new" && !canEdit) notFound();

  const detail = id === "new" ? null : await getPromo(session.companyId, id);
  if (id !== "new" && !detail) notFound();
  const choices = canEdit ? await promoServiceChoices(session.companyId) : [];

  return (
    <PromoClient
      initial={detail ? viewOf(detail) : { id: null, ...SCHOOL_CHECKUP }}
      detail={detail}
      choices={choices}
      canEdit={canEdit}
    />
  );
}
