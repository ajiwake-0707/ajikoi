"use client";

import Link from "next/link";
import { useState } from "react";

type DeliveryHistory = {
  id: string;
  title: string;
  sentAt: string;
  sent: number;
  failed: number;
};
type TriggerSetting = {
  id: string;
  title: string;
  triggerType: "USER_SIGNUP" | "CHECKIN_POINT_GRANTED" | "RANK_UP" | "BIRTHDAY" | "GIFT_EXPIRES";
  notificationText: string;
  messages: unknown;
  message: string;
  targetRankIds: string[];
  targetGender: string | null;
  targetVisitCountSegments: Array<"ZERO" | "ONE" | "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_OR_MORE">;
  delayDays: number;
  deliveryHourJst: number | null;
  isActive: boolean;
  updatedAt: string;
};

type DraftRow = {
  id: string;
  kind: "SPOT" | "TRIGGER";
  title: string;
  triggerId: string | null;
  updatedAt: string;
};

type Props = {
  drafts: DraftRow[];
  deliveryHistory: DeliveryHistory[];
  triggerSettings: TriggerSetting[];
  monthlyLimit: number;
  monthlyUsed: number;
  monthlyRemaining: number;
};

function formatDeliveryDate(iso: string) {
  const date = new Date(iso);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function resolveStatus(sent: number, failed: number) {
  if (sent === 0 && failed > 0) {
    return { label: "配信失敗", color: "bg-[#fee2e2] text-[#b91c1c]" };
  }
  if (sent > 0 && failed > 0) {
    return { label: "一部失敗", color: "bg-[#fef3c7] text-[#b45309]" };
  }
  return { label: "配信済", color: "bg-[#ccfbf1] text-[#0f766e]" };
}

function formatTriggerType(triggerType: TriggerSetting["triggerType"]) {
  if (triggerType === "USER_SIGNUP") return "会員登録時";
  if (triggerType === "CHECKIN_POINT_GRANTED") return "来店ポイント付与時";
  if (triggerType === "RANK_UP") return "ランクアップ時";
  if (triggerType === "BIRTHDAY") return "誕生日";
  return "ギフト期限切れ";
}

export default function SpotDeliveryClient({
  drafts,
  deliveryHistory,
  triggerSettings,
  monthlyLimit,
  monthlyUsed,
  monthlyRemaining,
}: Props) {
  const [draftRows, setDraftRows] = useState(drafts);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const deleteDraft = async (id: string) => {
    if (!window.confirm("この下書きを削除しますか？")) return;
    setDeletingDraftId(id);
    setDraftError(null);
    try {
      const response = await fetch(`/api/admin/spot-delivery/drafts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.message ?? "下書きを削除できませんでした。");
      setDraftRows((rows) => rows.filter((row) => row.id !== id));
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "下書きを削除できませんでした。");
    } finally {
      setDeletingDraftId(null);
    }
  };
  const [activeTab, setActiveTab] = useState<"spot" | "trigger">("spot");
  const visibleDrafts = draftRows.filter((draft) => draft.kind === (activeTab === "spot" ? "SPOT" : "TRIGGER"));
  const [triggerRows, setTriggerRows] = useState(triggerSettings);
  const [updatingTriggerId, setUpdatingTriggerId] = useState<string | null>(null);

  const toggleTriggerActive = async (row: TriggerSetting) => {
    setUpdatingTriggerId(row.id);
    try {
      const response = await fetch(`/api/admin/spot-delivery/triggers/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: row.title,
          triggerType: row.triggerType,
          notificationText: row.notificationText ?? "",
          messages: Array.isArray(row.messages)
            ? row.messages
            : [{ type: "text", text: row.message ?? "" }],
          targetRankIds: row.targetRankIds,
          targetGender: row.targetGender,
          targetVisitCountSegments: row.targetVisitCountSegments,
          delayDays: row.delayDays,
          deliveryHourJst: row.deliveryHourJst,
          isActive: !row.isActive,
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "有効状態の切り替えに失敗しました。");
      }
      setTriggerRows((prev) =>
        prev.map((item) =>
          item.id === row.id
            ? { ...item, isActive: !item.isActive, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "有効状態の切り替えに失敗しました。");
    } finally {
      setUpdatingTriggerId(null);
    }
  };

  const deleteTrigger = async (row: TriggerSetting) => {
    if (!window.confirm(`「${row.title}」を削除しますか？`)) {
      return;
    }
    setUpdatingTriggerId(row.id);
    try {
      const response = await fetch(`/api/admin/spot-delivery/triggers/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "削除に失敗しました。");
      }
      setTriggerRows((prev) => prev.filter((item) => item.id !== row.id));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "削除に失敗しました。");
    } finally {
      setUpdatingTriggerId(null);
    }
  };

  return (
    <div className="w-full min-w-0 space-y-4 px-3 py-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="shrink-0 whitespace-nowrap text-xl font-bold">LINE配信</h1>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-[#64748b]">
          <span className="whitespace-nowrap">残り配信可能数 <strong className="font-semibold text-[#334155]">{monthlyRemaining}/{monthlyLimit}</strong></span>
          <span className="whitespace-nowrap">今月送信 {monthlyUsed}通</span>
        </p>
      </div>
      <section className="mx-auto w-full max-w-6xl rounded-xl border border-[#dbe2ea] bg-white shadow-sm">
        <div className="border-b border-[#e2e8f0] px-4 pt-3">
          <div className="grid grid-cols-2 gap-4 sm:flex">
            <button
              type="button"
              onClick={() => setActiveTab("spot")}
              className={`min-h-11 border-b-2 px-3 pb-2 text-sm font-semibold ${
                activeTab === "spot"
                  ? "border-[#0f766e] text-[#0f172a]"
                  : "border-transparent text-[#94a3b8]"
              }`}
            >
              スポット
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("trigger")}
              className={`min-h-11 border-b-2 px-3 pb-2 text-sm font-semibold ${
                activeTab === "trigger"
                  ? "border-[#0f766e] text-[#0f172a]"
                  : "border-transparent text-[#94a3b8]"
              }`}
            >
              トリガー
            </button>
          </div>
        </div>

        <section className="m-3 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-3 sm:m-4 sm:p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold">下書き <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-[#64748b]">{visibleDrafts.length}件</span></h2>
          <p className="mt-1 text-xs leading-5 text-[#64748b]">保存した内容から再開できます。下書きは配信されません。</p>
          {draftError && <p role="alert" className="mt-2 text-sm text-red-700">{draftError}</p>}
          {visibleDrafts.length === 0 ? <p className="mt-3 text-sm text-[#64748b]">保存した下書きはありません。</p> : (
            <ul className="mt-3 divide-y divide-[#e2e8f0]">
              {visibleDrafts.map((draft) => {
                const path = draft.kind === "SPOT" ? "/admin/spot-delivery/new"
                  : draft.triggerId ? `/admin/spot-delivery/triggers/${encodeURIComponent(draft.triggerId)}`
                  : "/admin/spot-delivery/triggers/new";
                return (
                  <li key={draft.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 sm:flex-1">
                      <p className="break-words text-sm font-semibold leading-6 [overflow-wrap:anywhere]">{draft.title.trim() || "タイトル未設定"}</p>
                      <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs leading-5 text-[#64748b]"><span>{draft.triggerId ? "既存設定の編集" : "新規作成"}</span><span className="whitespace-nowrap">更新 {formatDeliveryDate(draft.updatedAt)}</span></p>
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2 sm:flex sm:shrink-0">
                      <Link href={`${path}?draft=${encodeURIComponent(draft.id)}`} className="flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[#0f766e] px-4 py-2 text-sm font-semibold text-white">編集を再開</Link>
                      <button type="button" disabled={deletingDraftId !== null} onClick={() => void deleteDraft(draft.id)} className="min-h-11 whitespace-nowrap rounded-lg border border-[#fecaca] px-4 py-2 text-sm text-[#b91c1c] disabled:opacity-50">{deletingDraftId === draft.id ? "削除中..." : "削除"}</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {activeTab === "spot" ? (
          <div className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Link
                href="/admin/spot-delivery/new"
                className="flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[#0f9f99] px-3 py-3 text-sm font-bold text-white sm:px-4"
              >
                + スポット配信を作成する
              </Link>
              <p className="shrink-0 text-xs text-[#64748b] sm:text-sm">配信履歴 {deliveryHistory.length}件</p>
            </div>

            <div className="overflow-hidden rounded-lg border border-[#e2e8f0]">
              {deliveryHistory.length === 0 ? (
                <p className="px-4 py-6 text-sm text-[#64748b]">配信履歴がありません。</p>
              ) : (
                <ul>
                  {deliveryHistory.map((row) => {
                    const status = resolveStatus(row.sent, row.failed);
                    return (
                      <li
                        key={row.id}
                        className="flex flex-col gap-3 border-b border-[#f1f5f9] px-3 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-4"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#0f172a]">{row.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-[#64748b]">
                            <span className={`rounded px-2 py-0.5 font-semibold ${status.color}`}>{status.label}</span>
                            <span>配信日時 {formatDeliveryDate(row.sentAt)}</span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Link
                href="/admin/spot-delivery/triggers/new"
                className="flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg bg-[#0f9f99] px-3 py-3 text-sm font-bold text-white sm:px-4"
              >
                + トリガー配信を作成する
              </Link>
              <p className="shrink-0 text-xs text-[#64748b] sm:text-sm">設定一覧 {triggerRows.length}件</p>
            </div>
            <div className="overflow-hidden rounded-lg border border-[#e2e8f0]">
              {triggerRows.length === 0 ? (
                <p className="px-4 py-6 text-sm text-[#64748b]">トリガー配信の設定がありません。</p>
              ) : (
                <ul>
                  {triggerRows.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-col gap-3 border-b border-[#f1f5f9] px-3 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:px-4"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#0f172a]">{row.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5 text-[#64748b]">
                          <span
                            className={`rounded px-2 py-0.5 font-semibold ${
                              row.isActive ? "bg-[#ccfbf1] text-[#0f766e]" : "bg-[#f1f5f9] text-[#64748b]"
                            }`}
                          >
                            {row.isActive ? "有効" : "無効"}
                          </span>
                          <span>{formatTriggerType(row.triggerType)}</span>
                          <span>更新 {formatDeliveryDate(row.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 sm:flex sm:shrink-0">
                        <Link
                          href={`/admin/spot-delivery/triggers/${row.id}`}
                          className="flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-[#cbd5e1] px-3 py-2 text-xs font-semibold text-[#334155]"
                        >
                          編集
                        </Link>
                        <button
                          type="button"
                          disabled={updatingTriggerId === row.id}
                          onClick={() => void toggleTriggerActive(row)}
                          className="flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-[#cbd5e1] px-3 py-2 text-xs font-semibold text-[#334155] disabled:opacity-50"
                        >
                          {row.isActive ? "無効化" : "有効化"}
                        </button>
                        <button
                          type="button"
                          disabled={updatingTriggerId === row.id}
                          onClick={() => void deleteTrigger(row)}
                          className="min-h-11 whitespace-nowrap rounded-lg border border-[#fecaca] px-3 py-2 text-xs font-semibold text-[#b91c1c] disabled:opacity-50"
                        >
                          削除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
