"use client";

import { useParams } from "next/navigation";
import { CourseSessionsWorkspace } from "@/features/courses/CourseSessionsWorkspace";

export default function Page() {
  const params = useParams<{ id: string }>();
  return <CourseSessionsWorkspace courseId={params.id} />;
}
