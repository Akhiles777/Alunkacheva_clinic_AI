import { getInstagramReadiness } from "./actions";

/**
 * Готовность Instagram Direct.
 *
 * Половина настройки канала живёт не в базе, а в переменных окружения на
 * сервере. На экране их не было видно: токен заведён, галочка стоит, а
 * сообщения не приходят — и понять почему можно было только зайдя по ssh.
 * Здесь видно каждое условие и адрес, который вставляют в кабинете Meta.
 *
 * Значения не показываем никогда, только факт «задано» (§7).
 */
export async function InstagramBlock() {
  const state = await getInstagramReadiness();

  return (
    <section className="border-border bg-surface rounded-xl border p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Instagram Direct — готовность</h2>
        <span
          className={`rounded-md px-2 py-0.5 text-2xs font-medium ${
            state.ready ? "bg-accent-tint text-accent-text" : "bg-chip text-text-muted"
          }`}
        >
          {state.ready ? "всё задано" : "не хватает настроек"}
        </span>
      </div>

      <ul className="mt-4 flex flex-col gap-2.5">
        {state.items.map((item) => (
          <li key={item.label} className="flex gap-2.5">
            <span
              aria-hidden
              className={`mt-1.5 h-1.5 w-1.5 flex-none rounded-[2px] ${
                item.ok ? "bg-accent" : "bg-border-strong"
              }`}
            />
            <span className="min-w-0">
              <span className="text-sm">
                {item.label}
                <span className={`ml-2 text-2xs ${item.ok ? "text-accent-text" : "text-text-subtle"}`}>
                  {item.ok ? "задано" : "не задано"}
                </span>
              </span>
              <span className="text-text-subtle block text-xs">{item.hint}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="border-border-soft mt-4 border-t pt-3.5">
        <div className="text-text-subtle text-2xs">Адрес вебхука — вставляется в кабинете Meta</div>
        {state.webhookUrl ? (
          <code className="num text-text mt-1 block break-all text-xs">{state.webhookUrl}</code>
        ) : (
          <p className="text-text-muted mt-1 text-xs">
            Не задан домен (DOMAIN) на сервере — адрес собрать не из чего.
          </p>
        )}
      </div>

      {/*
        Ограничение Meta, а не наше. Знать о нём нужно до подключения: иначе
        первое же «бот молчит» будет выглядеть поломкой платформы.
      */}
      <p className="text-text-muted mt-3.5 text-xs leading-relaxed">
        Отвечать пациенту Instagram разрешает только в течение суток с его последнего сообщения.
        Позже платформа честно скажет, что окно закрылось, — писать придётся из приложения. Телефона
        в Instagram нет: карточка пациента заводится, когда он оставит номер сам.
      </p>
    </section>
  );
}
