import { redirect } from "next/navigation";

/** Акция одна — у неё один адрес. Старые ссылки ведут туда же. */
export default function PromoRedirect() {
  redirect("/promos");
}
