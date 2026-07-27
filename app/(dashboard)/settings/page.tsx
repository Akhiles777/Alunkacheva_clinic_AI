"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** /settings открывает первую секцию. */
export default function SettingsIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/settings/clinic");
  }, [router]);
  return null;
}
