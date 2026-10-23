import type { Metadata } from "next";
import { ReferenceView } from "@/components/developers/reference-view";
import { RuntimeBrandMarker } from "@/components/brand/runtime-brand-marker";

export const metadata: Metadata = { title: "API reference" };

export default function ReferencePage() {
  return (
    <div className="space-y-4">
      <RuntimeBrandMarker />
      <h1 className="text-2xl font-semibold">API reference</h1>
      <ReferenceView />
    </div>
  );
}
