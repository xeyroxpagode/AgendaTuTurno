"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { EconomyWorkspace } from "@/features/economy/EconomyWorkspace";

export default function Page() {
  const params = useParams<{ staffMemberId: string }>();
  const [name, setName] = useState("Profesional");

  useEffect(() => {
    api<{ firstName: string; lastName: string | null }>(`/v1/staff/${params.staffMemberId}`)
      .then((member) => setName(`${member.firstName}${member.lastName ? ` ${member.lastName}` : ""}`))
      .catch(() => undefined);
  }, [params.staffMemberId]);

  return <EconomyWorkspace staffMemberId={params.staffMemberId} staffName={name} />;
}
