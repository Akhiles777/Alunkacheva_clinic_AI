"use client";

import { useEffect } from "react";
import { hydrateAppointments, hydrateDialogs, hydratePatients } from "@/app/_data/store";
import { getPatientRecords } from "../patients/actions";
import { getConversations } from "../inbox/actions";
import { getAppointmentsForStore } from "../schedule/actions";

/**
 * Разовая гидрация клиентского стора пациентами из БД при загрузке дашборда.
 * Живёт в layout, поэтому выполняется один раз и не сбрасывает правки при
 * навигации между страницами.
 */
export function StoreHydrator() {
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
  }, []);
  return null;
}
