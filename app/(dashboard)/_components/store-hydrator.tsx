"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { hydrateAppointments, hydrateDialogs, hydratePatients } from "@/app/_data/store";
import { getPatientRecords } from "../patients/actions";
import { getConversations } from "../inbox/actions";
import { getAppointmentsForStore } from "../schedule/actions";

/**
 * Наполнение клиентского стора данными из базы.
 *
 * Раньше это происходило ровно один раз — при загрузке дашборда. Всё, что
 * появлялось в базе позже (пациент из диалога, карточка от бота, выгрузка из
 * YCLIENTS), на экранах не показывалось до перезагрузки страницы: список
 * пациентов был неполным, а только что созданная карточка открывалась с
 * надписью «такого пациента нет».
 *
 * Обновляем при переходе между разделами: запросы небольшие, а расхождение
 * между тем, что в базе, и тем, что видит человек, — худшее из зол.
 */
export function StoreHydrator() {
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    getPatientRecords()
      .then((records) => {
        if (alive) hydratePatients(records);
      })
      .catch(() => {});
    getConversations()
      .then((records) => {
        if (alive) hydrateDialogs(records);
      })
      .catch(() => {});
    getAppointmentsForStore()
      .then((appts) => {
        if (alive) hydrateAppointments(appts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname]);
  return null;
}
