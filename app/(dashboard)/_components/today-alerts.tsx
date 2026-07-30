"use client";

import Link from "next/link";
import { allCourses, useDb } from "@/app/_data/store";
import { CallButton } from "./call-form";

/**
 * Живая полоса «прямо сейчас» на Сегодня: неотвеченные диалоги и выпавшие из
 * курса — из общего стора, поэтому цифры настоящие и кликаются. Плюс кнопка
 * занести звонок здесь же, на экране (§5.1).
 */
export function TodayAlerts() {
  const db = useDb();
  const unread = db.dialogs.filter((d) => d.unread && d.status !== "closed").length;
  const stalled = allCourses().filter((c) => c.stalled).length;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href="/inbox"
        className="border-border hover:bg-hover flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <span className="num text-accent-text font-medium">{unread}</span>
        <span className="text-text-muted">диалогов без ответа</span>
      </Link>
      <Link
        href="/courses"
        className="border-border hover:bg-hover flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <span className="num text-accent-text font-medium">{stalled}</span>
        <span className="text-text-muted">выпали из курса</span>
      </Link>
      <CallButton />
    </div>
  );
}
