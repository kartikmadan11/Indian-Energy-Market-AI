"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function BidsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/forecast");
  }, [router]);
  return null;
}
