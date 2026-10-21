"use client";
import { useRef, useState } from "react";
import type { DeliveryDraftKind, DeliveryDraftPayload } from "./delivery-draft";

export function useDeliveryDraft(kind: DeliveryDraftKind, initialId?: string, triggerId?: string) {
  const draftId = useRef(initialId);
  const saving = useRef(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  async function saveDraft(getPayload: () => Promise<DeliveryDraftPayload>) {
    if (saving.current) return;
    saving.current = true;
    setIsSavingDraft(true);
    try {
      const payload = await getPayload();
      const response = await fetch("/api/admin/spot-delivery/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draftId.current, kind, triggerId, payload }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.message ?? "下書きの保存に失敗しました。");
      draftId.current = json.id;
      const url = new URL(window.location.href);
      url.searchParams.set("draft", json.id);
      window.history.replaceState(null, "", url);
    } finally {
      saving.current = false;
      setIsSavingDraft(false);
    }
  }
  function clearDraftId() {
    draftId.current = undefined;
    const url = new URL(window.location.href);
    url.searchParams.delete("draft");
    window.history.replaceState(null, "", url);
  }
  return { draftId, isSavingDraft, saveDraft, clearDraftId };
}
