"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  hydrateAppointments,
  hydrateCourses,
  hydrateDialogs,
  hydratePatients,
} from "@/app/_data/store";
import { getPatientRecords } from "../patients/actions";
import { getConversations } from "../inbox/actions";
import { getAppointmentsForStore } from "../schedule/actions";
import { getCoursesForStore } from "../courses/actions";
import { reportMaybeStale } from "@/lib/client/stale-build";

/**
 * Наполнение клиентского стора данными из базы.
 *
 * Раньше это происходило ровно один раз — при загрузке дашборда. Всё, что
 * появлялось в базе позже (пациент из диалога, карточка от бота, выгрузка из
 * YCLIENTS), на экранах не показывалось до перезагрузки страницы: список
 * пациентов был неполным, а только что созданная карточка открывалась с
 * надписью «такого пациента нет».
 *
 * Потом стало обновляться при переходе между разделами — и этого всё равно
 * мало. Администратор держит «Сегодня» открытым весь день: выгрузка приносит
 * свежие записи и отметки «пришёл» каждые пятнадцать минут, а экран показывает
 * то, что было на момент открытия вкладки. Снаружи это выглядит ровно как
 * «данные не подгружаются», хотя в базе они есть.
 *
 * Поэтому перечитываем ещё и по времени, и при возврате на вкладку. Расхождение
 * между тем, что в базе, и тем, что видит человек, — худшее из зол.
 */

/** Как часто перечитываем при открытой вкладке. */
const REFRESH_MS = 60_000;

export function StoreHydrator() {
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;

    const load = () => {
      // Скрытая вкладка данных не показывает: незачем и запрашивать.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      /**
       * Курсы — после пациентов: они приклеиваются к уже загруженным
       * карточкам. Иначе первый круг раскладывал бы их по пустому списку.
       */
      getPatientRecords()
        .then((records) => {
          if (!alive) return;
          hydratePatients(records);
          return getCoursesForStore().then((courses) => {
            if (alive) hydrateCourses(courses);
          });
        })
        .catch(reportFailure);
      getConversations()
        .then((records) => {
          if (alive) hydrateDialogs(records);
        })
        .catch(reportFailure);
      getAppointmentsForStore()
        .then((appts) => {
          if (alive) hydrateAppointments(appts);
        })
        .catch(reportFailure);
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    // Вернулись на вкладку — данные нужны сразу, а не через минуту.
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [pathname]);
  return null;
}

/**
 * Неудачу видно в консоли, а не молчание.
 *
 * Здесь стояло пустое `.catch(() => {})`: если чтение перестало работать,
 * экран просто застывал на старых данных — без единого следа, по которому это
 * можно было бы понять. Тела сообщений и персональные данные сюда не попадают
 * (§7): в ошибке только адрес и причина.
 */
function reportFailure(e: unknown): void {
  console.warn("[данные] не удалось перечитать:", (e as Error)?.message ?? e);
  /**
   * Похоже на старую сборку — говорим сторожу.
   *
   * После обновления платформы открытая вкладка работает на прежнем коде, и
   * серверные действия перестают опознаваться. Здесь ошибка ловится в catch и
   * до общего обработчика не долетает: вкладка молча замирала на старых
   * данных, а человек продолжал по ним работать.
   */
  reportMaybeStale(e);
}
