"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

type TriggerType = "USER_SIGNUP" | "CHECKIN_POINT_GRANTED" | "RANK_UP" | "BIRTHDAY" | "GIFT_EXPIRES";
type DelayDirection = "future" | "past";
type DeliveryVisitCountSegment = "ZERO" | "ONE" | "TWO_TO_FOUR" | "FIVE_TO_NINE" | "TEN_OR_MORE";
type LineTextMessage = { type: "text"; text: string };
type LineImageMessage = { type: "image"; originalContentUrl: string; previewImageUrl: string };
type LineFlexMessage = { type: "flex"; altText: string; contents: Record<string, unknown> };
type LineMessage = LineTextMessage | LineImageMessage | LineFlexMessage;

type GiftOption = {
  id: string;
  title: string;
  imageUrl: string;
  usageGuide: string;
  previewImageUrl: string;
  lineImageUrl: string | null;
};

type Props = {
  gifts: GiftOption[];
  rankOptions: Array<{ id: string; name: string }>;
  mode?: "create" | "edit";
  triggerId?: string;
  initialValue?: {
    title: string;
    triggerType: TriggerType;
    notificationText?: string;
    messages?: unknown;
    message: string;
    targetRankIds?: string[];
    targetGender?: "male" | "female" | "other" | null;
    targetVisitCountSegments?: DeliveryVisitCountSegment[];
    delayDays?: number;
    deliveryHourJst?: number | null;
    isActive: boolean;
  };
};

function parseInitialMessages(rawMessages: unknown, fallbackMessage: string): LineMessage[] {
  if (!Array.isArray(rawMessages)) {
    return fallbackMessage.trim() ? [{ type: "text", text: fallbackMessage.trim() }] : [];
  }
  const parsed: LineMessage[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "text" && typeof row.text === "string" && row.text.trim()) {
      parsed.push({ type: "text", text: row.text });
      continue;
    }
    if (
      row.type === "image" &&
      typeof row.originalContentUrl === "string" &&
      typeof row.previewImageUrl === "string"
    ) {
      parsed.push({
        type: "image",
        originalContentUrl: row.originalContentUrl,
        previewImageUrl: row.previewImageUrl,
      });
      continue;
    }
    if (row.type === "flex" && typeof row.altText === "string" && row.contents && typeof row.contents === "object") {
      parsed.push({
        type: "flex",
        altText: row.altText,
        contents: row.contents as Record<string, unknown>,
      });
    }
  }
  return parsed;
}

export default function TriggerDeliveryEditorClient({
  gifts,
  rankOptions,
  mode = "create",
  triggerId,
  initialValue,
}: Props) {
  const initialMessages = useMemo(
    () => parseInitialMessages(initialValue?.messages, initialValue?.message ?? ""),
    [initialValue?.message, initialValue?.messages],
  );
  const initialTextMessage = initialMessages.find((item) => item.type === "text");
  const initialImageMessage = initialMessages.find((item) => item.type === "image");
  const initialFlexMessage = initialMessages.find((item) => item.type === "flex");
  const initialFlexHeroUrl =
    initialFlexMessage && typeof initialFlexMessage.contents.hero === "object" && initialFlexMessage.contents.hero
      ? (initialFlexMessage.contents.hero as { url?: unknown }).url
      : null;
  const initialGift =
    typeof initialFlexHeroUrl === "string"
      ? gifts.find((gift) => gift.lineImageUrl === initialFlexHeroUrl) ?? null
      : null;

  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [activeTab, setActiveTab] = useState<"content" | "segment">("content");
  const [triggerType, setTriggerType] = useState<TriggerType>(initialValue?.triggerType ?? "USER_SIGNUP");
  const [notificationText, setNotificationText] = useState(initialValue?.notificationText ?? "");
  const [message, setMessage] = useState(initialTextMessage?.text ?? initialValue?.message ?? "");
  const [showTextElement, setShowTextElement] = useState(Boolean(initialTextMessage || initialValue?.message));
  const [showImageElement, setShowImageElement] = useState(Boolean(initialImageMessage));
  const [showGiftElement, setShowGiftElement] = useState(Boolean(initialFlexMessage));
  const [selectedGift, setSelectedGift] = useState<GiftOption | null>(initialGift);
  const [isGiftSheetOpen, setIsGiftSheetOpen] = useState(false);
  const [selectedImageFile, setSelectedImageFile] = useState<File | null>(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(initialImageMessage?.originalContentUrl ?? null);
  const [targetRankIds, setTargetRankIds] = useState<string[]>(initialValue?.targetRankIds ?? []);
  const [targetGender, setTargetGender] = useState<"male" | "female" | "other" | null>(initialValue?.targetGender ?? null);
  const [targetVisitCountSegments, setTargetVisitCountSegments] = useState<DeliveryVisitCountSegment[]>(
    initialValue?.targetVisitCountSegments ?? [],
  );
  const [delayDirection, setDelayDirection] = useState<DelayDirection>(
    (initialValue?.delayDays ?? 0) < 0 ? "past" : "future",
  );
  const [delayDayCountInput, setDelayDayCountInput] = useState<string>(
    String(Math.max(0, Math.min(365, Math.abs(initialValue?.delayDays ?? 0)))),
  );
  const [deliveryHourJst, setDeliveryHourJst] = useState<number | null>(initialValue?.deliveryHourJst ?? null);
  const [isActive, setIsActive] = useState(initialValue?.isActive ?? true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const canSubmit = useMemo(() => {
    const hasContent = showTextElement || showImageElement || showGiftElement;
    if (!hasContent) return false;
    if (showTextElement && message.trim().length === 0) return false;
    if (showImageElement && !selectedImageFile && !uploadedImageUrl) return false;
    if (showGiftElement && !selectedGift) return false;
    return title.trim().length > 0 && !isSaving;
  }, [
    isSaving,
    message,
    selectedGift,
    selectedImageFile,
    showGiftElement,
    showImageElement,
    showTextElement,
    title,
    uploadedImageUrl,
  ]);

  const showToast = (text: string, error = false) => {
    setToast(text);
    setIsError(error);
    setTimeout(() => setToast(null), 2400);
  };

  const handleSaveDraft = () => {
    showToast("下書きを保存しました。");
  };

  const imagePreviewUrl = useMemo(
    () => (selectedImageFile ? URL.createObjectURL(selectedImageFile) : initialImageMessage?.previewImageUrl ?? null),
    [initialImageMessage?.previewImageUrl, selectedImageFile],
  );
  useEffect(
    () => () => {
      if (imagePreviewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    },
    [imagePreviewUrl],
  );
  const canUseNegativeDelay = triggerType === "BIRTHDAY" || triggerType === "GIFT_EXPIRES";
  useEffect(() => {
    if (!canUseNegativeDelay && delayDirection === "past") {
      setDelayDirection("future");
    }
  }, [canUseNegativeDelay, delayDirection]);
  const delayDays = useMemo(() => {
    const parsed = Number.parseInt(delayDayCountInput, 10);
    const dayCount = Number.isFinite(parsed) ? Math.max(0, Math.min(365, Math.abs(parsed))) : 0;
    if (!canUseNegativeDelay) {
      return dayCount;
    }
    return delayDirection === "past" ? -dayCount : dayCount;
  }, [canUseNegativeDelay, delayDayCountInput, delayDirection]);

  const openImagePicker = () => {
    setShowImageElement(true);
    imageInputRef.current?.click();
  };

  const openGiftSheet = () => {
    setShowGiftElement(true);
    setIsGiftSheetOpen(true);
  };

  const handleImageFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    setSelectedImageFile(file);
    setUploadedImageUrl(null);
  };

  const uploadSelectedImageIfNeeded = async () => {
    if (!showImageElement) return uploadedImageUrl;
    if (!selectedImageFile) return uploadedImageUrl;
    if (uploadedImageUrl) return uploadedImageUrl;

    setIsUploadingImage(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedImageFile);
      const response = await fetch("/api/admin/gifts/upload", {
        method: "POST",
        body: formData,
      });
      const json = (await response.json()) as { ok: boolean; imagePath?: string; message?: string };
      if (!response.ok || !json.ok || !json.imagePath) {
        throw new Error(json.message ?? "画像アップロードに失敗しました。");
      }
      setUploadedImageUrl(json.imagePath);
      return json.imagePath;
    } finally {
      setIsUploadingImage(false);
    }
  };

  const buildLineMessages = (imageUrl: string | null): LineMessage[] => {
    const lineMessages: LineMessage[] = [];
    if (showTextElement && message.trim()) {
      lineMessages.push({
        type: "text",
        text: message.trim(),
      });
    }
    if (showImageElement && imageUrl) {
      lineMessages.push({
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      });
    }
    if (showGiftElement && selectedGift) {
      if (!selectedGift.lineImageUrl) {
        throw new Error("選択したギフト画像はLINEから参照できません。ギフト画像を再保存してください。");
      }
      if (/\.svg(\?|$)/i.test(selectedGift.lineImageUrl)) {
        throw new Error("テンプレートSVG画像はLINE Flexで表示できません。PNG/JPEG画像のギフトを選択してください。");
      }
      const buttonUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}/?giftId=${encodeURIComponent(selectedGift.id)}`
          : `https://example.com/?giftId=${encodeURIComponent(selectedGift.id)}`;
      lineMessages.push({
        type: "flex",
        altText: selectedGift.title,
        contents: {
          type: "bubble",
          hero: {
            type: "image",
            url: selectedGift.lineImageUrl,
            size: "full",
            aspectRatio: "4:3",
            aspectMode: "cover",
          },
          body: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              {
                type: "text",
                text: selectedGift.title,
                weight: "bold",
                size: "xl",
                wrap: true,
              },
              {
                type: "text",
                text: selectedGift.usageGuide?.trim() || "タップして獲得してください",
                size: "sm",
                color: "#6b7280",
                wrap: true,
              },
            ],
          },
          footer: {
            type: "box",
            layout: "vertical",
            contents: [
              {
                type: "button",
                style: "primary",
                color: "#0f9f99",
                action: {
                  type: "uri",
                  label: "このギフトを獲得する",
                  uri: buttonUrl,
                },
              },
            ],
          },
        },
      });
    }
    return lineMessages;
  };

  const triggerTypeLabel: Record<TriggerType, string> = {
    USER_SIGNUP: "会員登録時",
    CHECKIN_POINT_GRANTED: "来店ポイント付与時",
    RANK_UP: "ランクアップ時",
    BIRTHDAY: "誕生日",
    GIFT_EXPIRES: "ギフト期限切れ",
  };
  const genderOptions: Array<{ value: "male" | "female" | "other"; label: string }> = [
    { value: "male", label: "男性" },
    { value: "female", label: "女性" },
    { value: "other", label: "その他" },
  ];
  const visitCountSegmentOptions: Array<{ value: DeliveryVisitCountSegment; label: string }> = [
    { value: "ZERO", label: "0回" },
    { value: "ONE", label: "1回" },
    { value: "TWO_TO_FOUR", label: "2〜4回" },
    { value: "FIVE_TO_NINE", label: "5〜9回" },
    { value: "TEN_OR_MORE", label: "10回以上" },
  ];

  const toggleRankTarget = (rankId: string) => {
    setTargetRankIds((prev) =>
      prev.includes(rankId) ? prev.filter((id) => id !== rankId) : [...prev, rankId],
    );
  };
  const toggleVisitCountTarget = (segment: DeliveryVisitCountSegment) => {
    setTargetVisitCountSegments((prev) =>
      prev.includes(segment) ? prev.filter((value) => value !== segment) : [...prev, segment],
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || isSaving) return;

    setIsSaving(true);
    try {
      const imageUrl = await uploadSelectedImageIfNeeded();
      const lineMessages = buildLineMessages(imageUrl ?? null);
      if (lineMessages.length === 0) {
        showToast("配信メッセージを1つ以上追加してください。", true);
        return;
      }

      const endpoint =
        mode === "edit" && triggerId
          ? `/api/admin/spot-delivery/triggers/${encodeURIComponent(triggerId)}`
          : "/api/admin/spot-delivery/triggers";
      const response = await fetch(endpoint, {
        method: mode === "edit" ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: title.trim(),
          triggerType,
          notificationText: notificationText.trim(),
          messages: lineMessages,
          targetRankIds,
          targetGender,
          targetVisitCountSegments,
          delayDays,
          deliveryHourJst,
          isActive,
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "トリガー配信の保存に失敗しました。");
      }
      showToast(mode === "edit" ? "トリガー配信を更新しました。" : "トリガー配信を保存しました。");
      setTimeout(() => {
        window.location.href = "/admin/spot-delivery";
      }, 700);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "トリガー配信の保存に失敗しました。", true);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="w-full p-4">
      <form onSubmit={handleSubmit} className="mx-auto w-[95%] overflow-hidden rounded-xl border border-[#dbe2ea] bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-[#e2e8f0] px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/admin/spot-delivery" className="text-xl leading-none text-[#334155]">
              ←
            </Link>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={mode === "edit" ? "トリガー配信タイトル" : "タイトル未設定"}
              className="w-56 rounded border border-transparent px-2 py-1 text-base font-bold outline-none focus:border-[#cbd5e1]"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveDraft}
              className="rounded-lg border border-[#cbd5e1] px-3 py-1.5 text-sm font-semibold text-[#334155]"
            >
              下書き保存
            </button>
            <button
              type="submit"
              disabled={!canSubmit || isUploadingImage}
              className="rounded-lg bg-[#0f766e] px-3 py-1.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
            >
              {isUploadingImage ? "画像アップロード中..." : isSaving ? "保存中..." : mode === "edit" ? "更新する" : "保存する"}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_320px]">
          <div className="border-r border-[#e2e8f0] p-4">
            <div className="mb-4 flex gap-4 border-b border-[#e2e8f0] text-sm font-semibold">
              <button
                type="button"
                onClick={() => setActiveTab("content")}
                className={`border-b-2 pb-2 ${
                  activeTab === "content"
                    ? "border-[#0f766e] text-[#0f172a]"
                    : "border-transparent text-[#94a3b8]"
                }`}
              >
                配信内容
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("segment")}
                className={`border-b-2 pb-2 ${
                  activeTab === "segment"
                    ? "border-[#0f766e] text-[#0f172a]"
                    : "border-transparent text-[#94a3b8]"
                }`}
              >
                セグメント
              </button>
            </div>

            {activeTab === "content" ? (
              <>
            <section className="space-y-3 rounded-lg border border-[#e2e8f0] p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-[#334155]">通知テキスト</p>
              </div>
              <input
                value={notificationText}
                onChange={(event) => setNotificationText(event.target.value)}
                placeholder="ロック画面用のテキスト"
                className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm outline-none focus:border-[#0f766e]"
              />
              <label className="block space-y-1">
                <span className="text-sm font-semibold text-[#334155]">トリガー条件</span>
                <select
                  value={triggerType}
                  onChange={(event) => setTriggerType(event.target.value as TriggerType)}
                  className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm outline-none focus:border-[#0f9f99]"
                >
                  <option value="USER_SIGNUP">会員登録時</option>
                  <option value="CHECKIN_POINT_GRANTED">来店ポイント付与時</option>
                  <option value="RANK_UP">ランクアップ時</option>
                  <option value="BIRTHDAY">誕生日</option>
                  <option value="GIFT_EXPIRES">ギフト期限切れ</option>
                </select>
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-[#475569]">
                    トリガーからの日数（負数: n日前）
                  </span>
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setDelayDirection("past")}
                        disabled={!canUseNegativeDelay}
                        className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                          delayDirection === "past"
                            ? "border-[#0f766e] bg-[#ccfbf1] text-[#0f766e]"
                            : "border-[#cbd5e1] bg-white text-[#475569]"
                        } disabled:cursor-not-allowed disabled:opacity-50`}
                      >
                        過去
                      </button>
                      <button
                        type="button"
                        onClick={() => setDelayDirection("future")}
                        className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                          delayDirection === "future"
                            ? "border-[#0f766e] bg-[#ccfbf1] text-[#0f766e]"
                            : "border-[#cbd5e1] bg-white text-[#475569]"
                        }`}
                      >
                        未来
                      </button>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={delayDayCountInput}
                      onChange={(event) => {
                        const digitsOnly = event.target.value.replace(/[^\d]/g, "");
                        setDelayDayCountInput(digitsOnly);
                      }}
                      onBlur={() => {
                        if (!delayDayCountInput) {
                          setDelayDayCountInput("0");
                          return;
                        }
                        const parsed = Number.parseInt(delayDayCountInput, 10);
                        const dayCount = Number.isFinite(parsed) ? Math.max(0, Math.min(365, Math.abs(parsed))) : 0;
                        setDelayDayCountInput(String(dayCount));
                      }}
                      placeholder="日数"
                      className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm outline-none focus:border-[#0f9f99]"
                    />
                  </div>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-[#475569]">配信時刻（JST）</span>
                  <select
                    value={deliveryHourJst === null ? "" : String(deliveryHourJst)}
                    onChange={(event) => {
                      const raw = event.target.value;
                      setDeliveryHourJst(raw === "" ? null : Number(raw));
                    }}
                    className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm outline-none focus:border-[#0f9f99]"
                  >
                    <option value="">即時配信</option>
                    {Array.from({ length: 24 }).map((_, hour) => (
                      <option key={hour} value={hour}>
                        {`${String(hour).padStart(2, "0")}:00`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-[#334155]">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                  className="h-4 w-4 rounded border-[#cbd5e1]"
                />
                このトリガー配信を有効にする
              </label>
            </section>

            {showTextElement ? (
              <section className="mt-3 rounded-lg border border-[#e2e8f0] p-3">
                <p className="text-sm font-semibold text-[#334155]">本文テキスト</p>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="配信するメッセージ本文"
                  rows={7}
                  className="mt-2 w-full resize-y rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm outline-none focus:border-[#0f9f99]"
                />
              </section>
            ) : null}

            {showImageElement ? (
              <section className="mt-3 rounded-lg border border-[#e2e8f0] p-3">
                <p className="text-sm font-semibold text-[#334155]">画像</p>
                <p className="mt-1 text-sm text-[#64748b]">画像を選択できます</p>
                <div className="mt-3 rounded-lg border border-[#e2e8f0] bg-[#fafafa] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="h-14 w-14 overflow-hidden rounded border border-[#dbe2ea] bg-white">
                        {imagePreviewUrl ? (
                          <img src={imagePreviewUrl} alt="選択画像プレビュー" className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-[#94a3b8]">画像</div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-[#64748b]">画像</p>
                        <p className="truncate text-lg font-semibold text-[#0f172a]">
                          {selectedImageFile?.name ?? (uploadedImageUrl ? "設定済み画像" : "未設定")}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={openImagePicker}
                      disabled={isUploadingImage}
                      className="rounded-lg border border-[#cbd5e1] px-4 py-2 text-sm font-semibold text-[#334155]"
                    >
                      {isUploadingImage ? "アップロード中..." : "変更"}
                    </button>
                  </div>
                </div>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageFileChange}
                />
              </section>
            ) : null}

            {showGiftElement ? (
              <section className="mt-3 rounded-lg border border-[#e2e8f0] p-3">
                <p className="text-sm font-semibold text-[#334155]">ギフト</p>
                <p className="mt-1 text-sm text-[#64748b]">配信に使用するギフトを設定できます</p>
                <div className="mt-3 rounded-lg border border-[#e2e8f0] bg-[#fafafa] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="h-14 w-14 overflow-hidden rounded border border-[#dbe2ea] bg-white">
                        {selectedGift ? (
                          <img src={selectedGift.previewImageUrl} alt={selectedGift.title} className="h-full w-full object-cover" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs text-[#94a3b8]">🎁</div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-[#64748b]">ギフト</p>
                        <p className="truncate text-lg font-semibold text-[#0f172a]">
                          {selectedGift?.title ?? "未設定"}
                        </p>
                      </div>
                    </div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedGift(null);
                            setShowGiftElement(false);
                            setIsGiftSheetOpen(false);
                          }}
                          className="rounded-lg border border-[#e2e8f0] px-3 py-2 text-sm font-semibold text-[#64748b]"
                        >
                          取り消し
                        </button>
                        <button
                          type="button"
                          onClick={openGiftSheet}
                          className="rounded-lg border border-[#cbd5e1] px-4 py-2 text-sm font-semibold text-[#334155]"
                        >
                          変更
                        </button>
                      </div>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="mt-3 rounded-lg border border-[#e2e8f0] p-3">
              <p className="text-sm font-semibold text-[#334155]">追加する要素</p>
              <div className="mt-3 grid grid-cols-5 gap-2 text-center text-xs text-[#334155]">
                <button
                  type="button"
                  onClick={() => setShowTextElement(true)}
                  className={`rounded border px-2 py-3 ${
                    showTextElement
                      ? "border-[#0f766e] bg-[#ecfeff] font-semibold text-[#0f766e]"
                      : "border-[#dbe2ea] bg-[#f8fafc]"
                  }`}
                >
                  テキスト
                </button>
                <button
                  type="button"
                  onClick={openImagePicker}
                  className={`rounded border px-2 py-3 ${
                    showImageElement
                      ? "border-[#0f766e] bg-[#ecfeff] font-semibold text-[#0f766e]"
                      : "border-[#dbe2ea] bg-[#f8fafc]"
                  }`}
                >
                  画像
                </button>
                <button
                  type="button"
                  onClick={openGiftSheet}
                  className={`rounded border px-2 py-3 ${
                    showGiftElement
                      ? "border-[#0f766e] bg-[#ecfeff] font-semibold text-[#0f766e]"
                      : "border-[#dbe2ea] bg-[#f8fafc]"
                  }`}
                >
                  ギフト
                </button>
                {["アンケート", "カード"].map((label) => (
                  <div key={label} className="rounded border border-[#dbe2ea] bg-[#f8fafc] px-2 py-3">
                    {label}
                  </div>
                ))}
              </div>
            </section>
              </>
            ) : (
              <section className="space-y-3 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-4">
                <p className="text-sm font-semibold text-[#334155]">送信対象の絞り込み</p>
                <p className="text-xs text-[#64748b]">未選択の条件は「すべて対象」になります。</p>

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-[#475569]">ランク（複数選択）</p>
                  <div className="flex flex-wrap gap-2">
                    {rankOptions.map((rank) => {
                      const checked = targetRankIds.includes(rank.id);
                      return (
                        <button
                          key={rank.id}
                          type="button"
                          onClick={() => toggleRankTarget(rank.id)}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                            checked
                              ? "border-[#0f766e] bg-[#ccfbf1] text-[#0f766e]"
                              : "border-[#cbd5e1] bg-white text-[#475569]"
                          }`}
                        >
                          {rank.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="block space-y-1">
                  <span className="text-xs font-semibold text-[#475569]">性別</span>
                  <select
                    value={targetGender ?? ""}
                    onChange={(event) => {
                      const value = event.target.value as "male" | "female" | "other" | "";
                      setTargetGender(value ? value : null);
                    }}
                    className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm outline-none focus:border-[#0f9f99]"
                  >
                    <option value="">すべて</option>
                    {genderOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="space-y-2">
                  <p className="text-xs font-semibold text-[#475569]">来店回数（複数選択）</p>
                  <div className="flex flex-wrap gap-2">
                    {visitCountSegmentOptions.map((segment) => {
                      const checked = targetVisitCountSegments.includes(segment.value);
                      return (
                        <button
                          key={segment.value}
                          type="button"
                          onClick={() => toggleVisitCountTarget(segment.value)}
                          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                            checked
                              ? "border-[#0f766e] bg-[#ccfbf1] text-[#0f766e]"
                              : "border-[#cbd5e1] bg-white text-[#475569]"
                          }`}
                        >
                          {segment.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}
          </div>

          <aside className="bg-[#9db8de] p-4">
            <div className="mx-auto w-full max-w-[320px] rounded-2xl bg-[#84a5d3] p-3 shadow-inner">
              <div className="mb-3 h-10 w-10 rounded-full bg-[#6d8fbe]" />

              {showTextElement ? (
                <div className="mb-3 w-fit max-w-[92%] rounded-2xl rounded-tl-sm bg-white px-3 py-2 shadow-sm">
                  <p className="whitespace-pre-wrap text-[15px] text-[#0f172a]">
                    {message.trim() || "配信メッセージを入力するとここに表示されます。"}
                  </p>
                  <p className="mt-2 text-[11px] font-semibold text-[#94a3b8]">
                    type: text / trigger: {triggerTypeLabel[triggerType]}
                  </p>
                </div>
              ) : null}

              {showImageElement ? (
                <div className="mb-3 w-[92%] overflow-hidden rounded-2xl bg-white shadow-sm">
                  {imagePreviewUrl ? (
                    <img src={imagePreviewUrl} alt="LINE画像メッセージプレビュー" className="h-44 w-full object-cover" />
                  ) : (
                    <div className="flex h-44 items-center justify-center text-xs text-[#94a3b8]">画像未設定</div>
                  )}
                  <div className="px-3 py-2">
                    <p className="text-[11px] font-semibold text-[#94a3b8]">type: image / trigger: {triggerTypeLabel[triggerType]}</p>
                  </div>
                </div>
              ) : null}

              {showGiftElement ? (
                <div className="mb-3 w-[92%] overflow-hidden rounded-2xl bg-white shadow-sm">
                  <div className="h-52 w-full overflow-hidden bg-[#d1fae5]">
                    {selectedGift ? (
                      <img src={selectedGift.previewImageUrl} alt={selectedGift.title} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-[#94a3b8]">ギフト画像未設定</div>
                    )}
                  </div>
                  <div className="space-y-2 p-4">
                    <p className="text-3xl font-bold leading-tight text-[#111827]">
                      {selectedGift?.title ?? "ギフト未設定"}
                    </p>
                    <p className="text-sm text-[#6b7280]">
                      {selectedGift?.usageGuide?.trim() || "タップして獲得してください"}
                    </p>
                    <button
                      type="button"
                      className="w-full rounded-lg bg-[#0f9f99] px-3 py-3 text-base font-bold text-white"
                    >
                      このギフトを獲得する
                    </button>
                    <p className="text-[11px] font-semibold text-[#94a3b8]">type: flex / trigger: {triggerTypeLabel[triggerType]}</p>
                  </div>
                </div>
              ) : null}
              <div className="text-right text-xs text-[#5f7fa8]">07:19</div>
            </div>
          </aside>
        </div>
      </form>
      {toast ? (
        <div
          className={`fixed inset-x-0 bottom-20 z-50 mx-auto w-fit rounded-full px-4 py-2 text-sm font-semibold text-white ${
            isError ? "bg-[#b91c1c]" : "bg-[#111827]"
          }`}
        >
          {toast}
        </div>
      ) : null}
      {isGiftSheetOpen ? (
        <div className="fixed inset-0 z-50 bg-black/30">
          <button
            type="button"
            aria-label="close gift sheet"
            className="absolute inset-0"
            onClick={() => setIsGiftSheetOpen(false)}
          />
          <section className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-white p-4 shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-[#cbd5e1]" />
            <p className="text-base font-bold text-[#0f172a]">ギフトを選択</p>
            <div className="mt-3 max-h-[55vh] space-y-2 overflow-y-auto pb-4">
              {gifts.length === 0 ? (
                <p className="rounded-lg border border-[#e2e8f0] px-3 py-4 text-sm text-[#64748b]">
                  利用可能なギフトがありません。
                </p>
              ) : (
                gifts.map((gift) => (
                  <button
                    key={gift.id}
                    type="button"
                    onClick={() => {
                      setSelectedGift(gift);
                      setShowGiftElement(true);
                      setIsGiftSheetOpen(false);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left ${
                      selectedGift?.id === gift.id
                        ? "border-[#0f766e] bg-[#ecfeff]"
                        : "border-[#e2e8f0] bg-white"
                    }`}
                  >
                    <div className="h-12 w-12 overflow-hidden rounded border border-[#dbe2ea] bg-white">
                      <img src={gift.previewImageUrl} alt={gift.title} className="h-full w-full object-cover" />
                    </div>
                    <p className="line-clamp-2 text-sm font-semibold text-[#0f172a]">{gift.title}</p>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
