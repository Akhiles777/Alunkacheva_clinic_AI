import { settingsStore } from "@/app/_data/settings";
import { SettingsHeader } from "../_components/ui";
import { getSection } from "../blob-actions";
import { getKnowledge } from "./actions";
import { getServices } from "../services/actions";
import { AssistantClient, type AssistantData } from "./assistant-client";
import { getSession } from "@/lib/server/session";
import { getKnowledgeGaps, GAP_WINDOW_DAYS } from "@/lib/server/knowledge-gaps";
import type { GapsData } from "./gaps-block";

export default async function AssistantSettingsPage() {
  // Конфигурация — из JSON-настройки, база знаний — из доменной таблицы, той
  // самой, откуда её читает агент.
  const stored = (await getSection("assistant")) as Partial<AssistantData> | null;
  const knowledge = await getKnowledge();
  /**
   * Сохранённые настройки дополняем значениями по умолчанию, а не подменяем.
   * Клиника настраивала ассистента до появления поля инструкции, и в её записи
   * этого поля просто нет: без слияния текстовое поле осталось бы без
   * значения, а React ругается на неуправляемое поле ввода.
   */
  const initial: AssistantData = {
    assistant: { ...settingsStore.assistant, ...(stored?.assistant ?? {}) },
    knowledge,
  };

  // Опции услуг для привязки записей базы знаний — из доменной таблицы Service.
  const { services } = await getServices();
  const serviceOptions = services.map((s) => ({ id: s.id, title: s.title }));

  /**
   * Пробелы: о чём спрашивали, а ответить было нечем. Считает и группирует
   * сервер (`lib/server/knowledge-gaps.ts`), экран только показывает.
   *
   * Даты отдаём строками: серверные Date через границу клиентского компонента
   * не проходят.
   */
  const session = await getSession();
  const report = await getKnowledgeGaps(session.companyId);
  const gaps: GapsData = {
    total: report.total,
    withoutQuestion: report.withoutQuestion,
    windowDays: GAP_WINDOW_DAYS,
    clusters: report.clusters.map((c) => ({
      key: c.key,
      title: c.title,
      count: c.count,
      lastAt: c.lastAt.toISOString(),
      reasons: c.reasons,
      medical: c.medical,
      questions: c.questions.map((q) => ({ id: q.id, text: q.text, at: q.at.toISOString() })),
      answers: c.answers.map((a) => ({
        text: a.text,
        at: a.at.toISOString(),
        authorName: a.authorName,
      })),
    })),
  };

  /**
   * Сколько раз каждая запись действительно составила ответ.
   *
   * Производное от журнала попыток, а не счётчик в самой записи: счётчик
   * разъедется с фактами при первом сбое пересчёта, и объяснить расхождение
   * будет нечем.
   */
  const usage: Record<string, number> = {};
  for (const u of report.usage) usage[u.entryId] = u.used;
  const usageSince = report.usageSince?.toISOString() ?? null;

  /** Утверждать медицинские справки вправе врач и владелец — см. actions.ts. */
  const canApprove = session.role === "DOCTOR" || session.role === "OWNER";

  return (
    <>
      <SettingsHeader
        title="Ассистент"
        description="Ассистент отвечает только текстами из базы знаний и не сочиняет. По умолчанию — только черновики: администратор отправляет. При стоп-словах молчит и зовёт человека."
      />
      <div className="flex-1 overflow-auto px-7 py-6 max-md:px-5">
        <AssistantClient
          initial={initial}
          serviceOptions={serviceOptions}
          gaps={gaps}
          usage={usage}
          usageSince={usageSince}
          canApprove={canApprove}
        />
      </div>
    </>
  );
}
