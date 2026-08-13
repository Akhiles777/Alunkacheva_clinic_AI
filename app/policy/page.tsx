import type { Metadata } from "next";
import { PRIVACY_POLICY } from "@/lib/legal/documents";
import { LegalPage } from "./_document";

export const metadata: Metadata = {
  title: "Политика обработки персональных данных",
  // Документ публичный, но в поиске ему не место: это страница для пациента,
  // пришедшего по ссылке, а не материал для индексации.
  robots: { index: false, follow: false },
};

export default function PrivacyPolicyPage() {
  return (
    <LegalPage
      doc={PRIVACY_POLICY}
      other={{ href: "/policy/consent", title: "Согласие на обработку персональных данных →" }}
    />
  );
}
