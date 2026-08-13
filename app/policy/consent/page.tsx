import type { Metadata } from "next";
import { CONSENT_DOCUMENT } from "@/lib/legal/documents";
import { LegalPage } from "../_document";

export const metadata: Metadata = {
  title: "Согласие на обработку персональных данных",
  robots: { index: false, follow: false },
};

export default function ConsentPage() {
  return (
    <LegalPage
      doc={CONSENT_DOCUMENT}
      other={{ href: "/policy", title: "← Политика обработки персональных данных" }}
    />
  );
}
