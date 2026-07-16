"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { rpcClient } from "@/orpc/client";

type StaffUser = {
  userId: string;
  displayName: string;
  pictureUrl?: string | null;
};

type ShiftStatus = "UNSET" | "AVAILABLE" | "UNAVAILABLE";

type ShiftEntry = {
  day: number;
  status: ShiftStatus;
  startTime: string;
  endTime: string;
  isFree: boolean;
  memo: string;
};

type ConfirmedAssignment = {
  day: number;
  startTime: string | null;
  endTime: string | null;
  isFree: boolean;
  memo: string | null;
};

type AuthState = "loading" | "local-login" | "ready" | "unauthorized" | "error";

const LOCAL_STAFF_USER_ID_KEY = "ajikoi-staff-dev-user-id";
const statusLabels: Record<ShiftStatus, string> = {
  UNSET: "未定",
  AVAILABLE: "出勤可",
  UNAVAILABLE: "休み希望",
};
const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
const timeOptions = Array.from({ length: 96 }, (_, index) => {
  const hour = String(Math.floor(index / 4)).padStart(2, "0");
  const minute = String((index % 4) * 15).padStart(2, "0");
  return `${hour}:${minute}`;
});

function formatMonth(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDefaultShiftMonth() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return formatMonth(date);
}

function getMinimumShiftMonth() {
  return formatMonth(new Date());
}

function getDaysInMonth(month: string) {
  const matched = month.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return 31;
  return new Date(Number(matched[1]), Number(matched[2]), 0).getDate();
}

function getWeekdayLabel(month: string, day: number) {
  const matched = month.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return "";
  const date = new Date(Number(matched[1]), Number(matched[2]) - 1, day);
  return weekdayLabels[date.getDay()];
}

function getMonthStartWeekday(month: string) {
  const matched = month.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return 0;
  return new Date(Number(matched[1]), Number(matched[2]) - 1, 1).getDay();
}

function getAvailableTimeLabel(entry: Pick<ShiftEntry, "startTime" | "endTime" | "isFree">) {
  if (entry.isFree) return "フリー";
  return `${entry.startTime || "--:--"}-${entry.endTime || "--:--"}`;
}

function getConfirmedTimeLabel(assignment: Pick<ConfirmedAssignment, "startTime" | "endTime" | "isFree">) {
  if (assignment.isFree) return "フリー";
  return `${assignment.startTime || "--:--"}-${assignment.endTime || "--:--"}`;
}

function getEndTimeOptions(startTime: string) {
  return startTime ? timeOptions.filter((time) => time > startTime) : timeOptions;
}

function buildEmptyEntries(month: string): ShiftEntry[] {
  return Array.from({ length: getDaysInMonth(month) }, (_, index) => ({
    day: index + 1,
    status: "UNSET",
    startTime: "",
    endTime: "",
    isFree: false,
    memo: "",
  }));
}

function mergeEntries(month: string, savedEntries: Array<{
  day: number;
  status: ShiftStatus;
  startTime: string | null;
  endTime: string | null;
  isFree: boolean;
  memo: string | null;
}>) {
  const byDay = new Map(savedEntries.map((entry) => [entry.day, entry]));
  return buildEmptyEntries(month).map((entry) => {
    const saved = byDay.get(entry.day);
    if (!saved) return entry;
    return {
      day: entry.day,
      status: saved.status,
      startTime: saved.startTime ?? "",
      endTime: saved.endTime ?? "",
      isFree: saved.isFree,
      memo: saved.memo ?? "",
    };
  });
}

function isLocalHost() {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^100\.6[4-9]\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^100\.[7-9]\d\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^100\.1[01]\d\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^100\.12[0-7]\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

export default function StaffShiftsClient() {
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [staffUser, setStaffUser] = useState<StaffUser | null>(null);
  const [staffOptions, setStaffOptions] = useState<StaffUser[]>([]);
  const [selectedDevUserId, setSelectedDevUserId] = useState("");
  const [month, setMonth] = useState(getDefaultShiftMonth);
  const [selectedDay, setSelectedDay] = useState(1);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [entries, setEntries] = useState<ShiftEntry[]>(() => buildEmptyEntries(getDefaultShiftMonth()));
  const [confirmedAssignments, setConfirmedAssignments] = useState<ConfirmedAssignment[]>([]);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [isLoadingShift, setIsLoadingShift] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const minimumShiftMonth = useMemo(() => getMinimumShiftMonth(), []);

  const availableCount = useMemo(
    () => entries.filter((entry) => entry.status === "AVAILABLE").length,
    [entries],
  );
  const unavailableCount = useMemo(
    () => entries.filter((entry) => entry.status === "UNAVAILABLE").length,
    [entries],
  );
  const isSubmitted = Boolean(submittedAt);
  const isConfirmed = isSubmitted && confirmedAssignments.length > 0;
  const calendarCells = useMemo(() => {
    const blanks = Array.from({ length: getMonthStartWeekday(month) }, () => null);
    return [...blanks, ...entries];
  }, [entries, month]);
  const confirmedCalendarCells = useMemo(() => {
    const blanks = Array.from({ length: getMonthStartWeekday(month) }, () => null);
    const days = Array.from({ length: getDaysInMonth(month) }, (_, index) => index + 1);
    return [...blanks, ...days];
  }, [month]);
  const confirmedAssignmentsByDay = useMemo(() => {
    const grouped = new Map<number, ConfirmedAssignment[]>();
    for (const assignment of confirmedAssignments) {
      const rows = grouped.get(assignment.day) ?? [];
      rows.push(assignment);
      grouped.set(assignment.day, rows);
    }
    for (const rows of grouped.values()) {
      rows.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
    }
    return grouped;
  }, [confirmedAssignments]);
  const selectedEntry = entries.find((entry) => entry.day === selectedDay) ?? entries[0] ?? null;
  const selectedConfirmedAssignments = confirmedAssignmentsByDay.get(selectedDay) ?? [];
  const loadShift = useCallback(async (user: StaffUser, targetMonth: string) => {
    setIsLoadingShift(true);
    setMessage(null);
    try {
      const result = await rpcClient.user.getStaffShiftSubmission({
        userId: user.userId,
        month: targetMonth,
      });
      setEntries(mergeEntries(targetMonth, result.entries));
      setConfirmedAssignments(result.confirmedAssignments);
      setSubmittedAt(result.submittedAt);
    } catch (error) {
      setEntries(buildEmptyEntries(targetMonth));
      setConfirmedAssignments([]);
      setSubmittedAt(null);
      setMessage(error instanceof Error ? error.message : "希望シフトの取得に失敗しました。");
    } finally {
      setIsLoadingShift(false);
    }
  }, []);

  const loadLocalStaffOptions = useCallback(async () => {
    try {
      const result = await rpcClient.user.listStaffLoginOptions({});
      const options = result.staff.map((staff) => ({
        userId: staff.userId,
        displayName: staff.displayName,
        pictureUrl: staff.pictureUrl,
      }));
      setStaffOptions(options);
      const savedUserId = window.localStorage.getItem(LOCAL_STAFF_USER_ID_KEY) ?? "";
      const savedUser = options.find((option) => option.userId === savedUserId);
      if (savedUser) {
        setSelectedDevUserId(savedUser.userId);
        setStaffUser(savedUser);
        setAuthState("ready");
        return;
      }
      setAuthState("local-login");
    } catch (error) {
      setAuthState("error");
      setAuthMessage(error instanceof Error ? error.message : "スタッフ一覧の取得に失敗しました。");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      setAuthState("loading");
      setAuthMessage(null);

      if (!liffId || isLocalHost()) {
        await loadLocalStaffOptions();
        return;
      }

      try {
        const { default: liff } = await import("@line/liff");
        await liff.init({ liffId });
        if (!liff.isLoggedIn()) {
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        const syncResult = await rpcClient.user.upsertFromLiff({
          userId: profile.userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
        });
        if (cancelled) return;
        if (syncResult.role !== "staff") {
          setAuthState("unauthorized");
          return;
        }
        setStaffUser({
          userId: profile.userId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
        });
        setAuthState("ready");
      } catch (error) {
        if (!cancelled) {
          setAuthState("error");
          setAuthMessage(error instanceof Error ? error.message : "スタッフログインに失敗しました。");
        }
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [liffId, loadLocalStaffOptions]);

  useEffect(() => {
    if (authState !== "ready" || !staffUser) return;
    const timer = window.setTimeout(() => {
      void loadShift(staffUser, month);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authState, loadShift, month, staffUser]);

  const handleSelectLocalStaff = () => {
    const selected = staffOptions.find((option) => option.userId === selectedDevUserId);
    if (!selected) return;
    window.localStorage.setItem(LOCAL_STAFF_USER_ID_KEY, selected.userId);
    setStaffUser(selected);
    setAuthState("ready");
  };

  const handleCreateDevStaff = async () => {
    setAuthMessage(null);
    try {
      const result = await rpcClient.user.createDevStaffLogin({
        displayName: "ローカルスタッフ",
      });
      const nextStaff = {
        userId: result.staff.userId,
        displayName: result.staff.displayName,
        pictureUrl: result.staff.pictureUrl,
      };
      window.localStorage.setItem(LOCAL_STAFF_USER_ID_KEY, nextStaff.userId);
      setStaffOptions((prev) => [nextStaff, ...prev.filter((staff) => staff.userId !== nextStaff.userId)]);
      setSelectedDevUserId(nextStaff.userId);
      setStaffUser(nextStaff);
      setAuthState("ready");
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : "ローカルスタッフの作成に失敗しました。");
    }
  };

  const updateEntry = (day: number, patch: Partial<ShiftEntry>) => {
    if (isSubmitted || isConfirmed) return;
    setEntries((prev) =>
      prev.map((entry) =>
        entry.day === day
          ? {
              ...entry,
              ...patch,
              ...(patch.status ? { startTime: "", endTime: "", isFree: false } : {}),
            }
          : entry,
      ),
    );
  };

  const updateStartTime = (day: number, startTime: string) => {
    if (isSubmitted || isConfirmed) return;
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.day !== day) return entry;
        if (!startTime) return { ...entry, startTime: "", endTime: "", isFree: false };
        const endOptions = getEndTimeOptions(startTime);
        return {
          ...entry,
          startTime,
          endTime: entry.endTime && entry.endTime > startTime ? entry.endTime : (endOptions[0] ?? ""),
          isFree: false,
        };
      }),
    );
  };

  const updateEndTime = (day: number, endTime: string) => {
    if (isSubmitted || isConfirmed) return;
    setEntries((prev) =>
      prev.map((entry) => (entry.day === day ? { ...entry, endTime, isFree: false } : entry)),
    );
  };

  const toggleFreeAvailability = (day: number) => {
    if (isSubmitted || isConfirmed) return;
    setEntries((prev) =>
      prev.map((entry) =>
        entry.day === day
          ? {
              ...entry,
              startTime: "",
              endTime: "",
              isFree: !entry.isFree,
            }
          : entry,
      ),
    );
  };

  const handleMonthChange = (nextMonth: string) => {
    const safeMonth = nextMonth < minimumShiftMonth ? minimumShiftMonth : nextMonth;
    setMonth(safeMonth);
    setSelectedDay(1);
    setIsEditModalOpen(false);
    setEntries(buildEmptyEntries(safeMonth));
    setConfirmedAssignments([]);
    setSubmittedAt(null);
  };

  const handleSelectDay = (day: number) => {
    setSelectedDay(day);
    if (!isConfirmed) {
      setIsEditModalOpen(true);
    }
  };

  const getCalendarCellClassName = (entry: ShiftEntry) => {
    const isSelected = entry.day === selectedDay;
    const statusClass =
      entry.status === "AVAILABLE"
        ? "border-[#99f6e4] bg-[#ecfdf5] text-[#0f766e]"
        : entry.status === "UNAVAILABLE"
          ? "border-[#fecdd3] bg-[#fff1f2] text-[#be123c]"
          : "border-[#e2e8f0] bg-white text-[#334155]";
    return [
      "min-h-16 rounded-xl border p-2 text-left transition",
      statusClass,
      isSelected ? "ring-2 ring-[#0f766e] ring-offset-2" : "",
      isSubmitted ? "cursor-default" : "",
    ].join(" ");
  };

  const handleSave = async () => {
    if (!staffUser || isSavingRef.current || isSaving || isSubmitted || isConfirmed) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setMessage(null);
    try {
      const result = await rpcClient.user.saveStaffShiftSubmission({
        userId: staffUser.userId,
        month,
        entries: entries.map((entry) => ({
          day: entry.day,
          status: entry.status,
          startTime: entry.startTime || null,
          endTime: entry.endTime || null,
          isFree: entry.status === "AVAILABLE" && entry.isFree,
          memo: null,
        })),
      });
      setSubmittedAt(result.submittedAt);
      setMessage("希望シフトを提出しました。");
      setIsEditModalOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "希望シフトの保存に失敗しました。");
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  const handleLogoutLocal = () => {
    window.localStorage.removeItem(LOCAL_STAFF_USER_ID_KEY);
    setStaffUser(null);
    setAuthState("local-login");
  };

  if (authState === "loading") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center bg-[#f6f8fb] p-4 text-[#0f172a]">
        <section className="w-full rounded-2xl bg-white p-6 text-sm text-[#64748b] shadow-sm">
          スタッフ画面を読み込み中...
        </section>
      </main>
    );
  }

  if (authState === "local-login") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center bg-[#f6f8fb] p-4 text-[#0f172a]">
        <section className="w-full rounded-2xl bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-[#0f766e]">LOCAL STAFF LOGIN</p>
          <h1 className="mt-2 text-xl font-bold">スタッフとしてログイン</h1>
          <p className="mt-2 text-sm leading-6 text-[#64748b]">
            ローカル開発ではLINEログインの代わりに、開発用スタッフを選択して入れます。
          </p>

          {staffOptions.length > 0 ? (
            <div className="mt-5 space-y-3">
              <select
                value={selectedDevUserId}
                onChange={(event) => setSelectedDevUserId(event.target.value)}
                className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-3 text-sm outline-none focus:border-[#0f766e]"
              >
                <option value="">スタッフを選択</option>
                {staffOptions.map((staff) => (
                  <option key={staff.userId} value={staff.userId}>
                    {staff.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleSelectLocalStaff}
                disabled={!selectedDevUserId}
                className="w-full rounded-lg bg-[#0f766e] px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
              >
                選択したスタッフで入る
              </button>
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void handleCreateDevStaff()}
            className="mt-3 w-full rounded-lg border border-[#0f766e] px-4 py-3 text-sm font-bold text-[#0f766e]"
          >
            開発用スタッフを作成して入る
          </button>

          {authMessage ? <p className="mt-3 text-sm font-semibold text-[#b91c1c]">{authMessage}</p> : null}
        </section>
      </main>
    );
  }

  if (authState === "unauthorized") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center bg-[#f6f8fb] p-4 text-[#0f172a]">
        <section className="w-full rounded-2xl bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-bold">スタッフ権限がありません</h1>
          <p className="mt-2 text-sm text-[#64748b]">管理者にスタッフ設定を依頼してください。</p>
        </section>
      </main>
    );
  }

  if (authState === "error") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md items-center justify-center bg-[#f6f8fb] p-4 text-[#0f172a]">
        <section className="w-full rounded-2xl bg-white p-6 shadow-sm">
          <h1 className="text-xl font-bold">ログインに失敗しました</h1>
          <p className="mt-2 text-sm text-[#b91c1c]">{authMessage ?? "時間をおいて再度お試しください。"}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md bg-[#f6f8fb] px-4 pb-8 pt-5 text-[#0f172a]">
      <header className="rounded-2xl bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-[#0f766e]">
          {isConfirmed ? "スタッフ確定シフト" : "スタッフ希望シフト"}
        </p>
        <h1 className="mt-1 text-2xl font-bold">{isConfirmed ? "月次確定シフト" : "月次希望シフト提出"}</h1>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{staffUser?.displayName}</p>
            <p className="mt-1 text-xs text-[#64748b]">
              {isConfirmed
                ? "確定済み"
                : submittedAt
                  ? `提出済み: ${new Date(submittedAt).toLocaleString("ja-JP")}`
                  : "未提出"}
            </p>
            {isSubmitted && !isConfirmed ? (
              <p className="mt-1 text-xs font-semibold text-[#be123c]">提出後は修正できません。</p>
            ) : null}
          </div>
          {isLocalHost() ? (
            <button
              type="button"
              onClick={handleLogoutLocal}
              className="shrink-0 rounded-full border border-[#cbd5e1] px-3 py-1.5 text-xs font-semibold text-[#334155]"
            >
              切替
            </button>
          ) : null}
        </div>
      </header>

      <section className="mt-4 overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
        <label className="block min-w-0 overflow-hidden">
          <span className="mb-1 block text-sm font-semibold text-[#334155]">対象月</span>
          <input
            type="month"
            value={month}
            min={minimumShiftMonth}
            onChange={(event) => handleMonthChange(event.target.value)}
            className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] px-2 py-0 text-center text-sm font-semibold leading-[48px] outline-none focus:border-[#0f766e]"
          />
        </label>
        {!isConfirmed ? (
          <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm">
            <div className="rounded-lg bg-[#ecfdf5] px-3 py-2 font-semibold text-[#0f766e]">
              出勤可 {availableCount}日
            </div>
            <div className="rounded-lg bg-[#fff1f2] px-3 py-2 font-semibold text-[#be123c]">
              休み希望 {unavailableCount}日
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-3 rounded-2xl bg-white p-4 shadow-sm">
        <p className="text-sm font-semibold text-[#0f766e]">選択中の日付</p>
        <h2 className="mt-1 text-lg font-bold">
          {selectedDay}日
          <span className="ml-1 text-sm text-[#64748b]">({getWeekdayLabel(month, selectedDay)})</span>
        </h2>
        {isLoadingShift ? (
          <p className="mt-3 rounded-xl bg-[#f8fafc] px-4 py-3 text-sm text-[#64748b]">読み込み中...</p>
        ) : isConfirmed ? (
          selectedConfirmedAssignments.length > 0 ? (
            <div className="mt-3 space-y-2">
              {selectedConfirmedAssignments.map((assignment) => (
                <div
                  key={`${assignment.isFree ? "free" : `${assignment.startTime}:${assignment.endTime}`}`}
                  className="rounded-xl bg-[#ecfdf5] px-4 py-3"
                >
                  <p className="text-sm font-bold text-[#0f766e]">
                    {getConfirmedTimeLabel(assignment)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-3 rounded-xl bg-[#f8fafc] px-4 py-3 text-sm text-[#64748b]">
              この日の確定シフトはありません。
            </p>
          )
        ) : selectedEntry ? (
          <div
            className={`mt-3 rounded-xl px-4 py-3 text-sm font-semibold ${
              selectedEntry.status === "AVAILABLE"
                ? "bg-[#ecfdf5] text-[#0f766e]"
                : selectedEntry.status === "UNAVAILABLE"
                  ? "bg-[#fff1f2] text-[#be123c]"
                  : "bg-[#f8fafc] text-[#64748b]"
            }`}
          >
            {selectedEntry.status === "AVAILABLE"
              ? `出勤可 ${getAvailableTimeLabel(selectedEntry)}`
              : statusLabels[selectedEntry.status]}
          </div>
        ) : null}
      </section>

      {message ? (
        <p className="mt-3 rounded-lg bg-white px-4 py-3 text-sm font-semibold text-[#334155] shadow-sm">
          {message}
        </p>
      ) : null}

      {!isConfirmed ? (
        <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[#0f766e]">確定シフト</p>
              <h2 className="mt-1 text-lg font-bold">管理者が確定した勤務</h2>
            </div>
            <span className="rounded-full bg-[#f8fafc] px-3 py-1 text-xs font-bold text-[#64748b]">
              {confirmedAssignments.length}件
            </span>
          </div>
          <p className="mt-3 rounded-xl bg-[#f8fafc] px-4 py-4 text-sm text-[#64748b]">
            この月の確定シフトはまだありません。
          </p>
        </section>
      ) : null}

      <section className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
        {isLoadingShift ? (
          <div className="p-5 text-sm text-[#64748b]">
            {isConfirmed ? "確定シフトを読み込み中..." : "希望シフトを読み込み中..."}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-[#64748b]">
              {weekdayLabels.map((weekday) => (
                <div key={weekday} className="py-1">
                  {weekday}
                </div>
              ))}
            </div>
            {isConfirmed ? (
              <div className="mt-2 grid grid-cols-7 gap-1.5">
                {confirmedCalendarCells.map((day, index) => {
                  const dayAssignments = day ? (confirmedAssignmentsByDay.get(day) ?? []) : [];
                  return day ? (
                    <button
                      key={day}
                      type="button"
                      onClick={() => handleSelectDay(day)}
                      className={`min-h-20 rounded-xl border p-2 text-left transition ${
                        dayAssignments.length > 0
                          ? "border-[#99f6e4] bg-[#ecfdf5] text-[#0f766e]"
                          : "border-[#e2e8f0] bg-white text-[#94a3b8]"
                      } ${day === selectedDay ? "ring-2 ring-[#0f766e] ring-offset-2" : ""}`}
                      aria-pressed={day === selectedDay}
                    >
                      <span className="block text-sm font-bold">{day}</span>
                      {dayAssignments.length > 0 ? (
                        <span className="mt-1 block space-y-0.5 text-[10px] font-semibold leading-4">
                          {dayAssignments.map((assignment) => (
                            <span
                              key={`${assignment.isFree ? "free" : `${assignment.startTime}:${assignment.endTime}`}`}
                              className="block truncate"
                            >
                              {getConfirmedTimeLabel(assignment)}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <div key={`blank-${index}`} aria-hidden="true" />
                  );
                })}
              </div>
            ) : (
              <>
                <div className="mt-2 grid grid-cols-7 gap-1.5">
                  {calendarCells.map((entry, index) =>
                    entry ? (
                      <button
                        key={entry.day}
                        type="button"
                        onClick={() => handleSelectDay(entry.day)}
                        className={getCalendarCellClassName(entry)}
                        aria-pressed={entry.day === selectedDay}
                      >
                        <span className="block text-sm font-bold">{entry.day}</span>
                        <span className="mt-1 block truncate text-[10px] font-semibold">
                          {entry.status === "AVAILABLE" ? getAvailableTimeLabel(entry) : statusLabels[entry.status]}
                        </span>
                      </button>
                    ) : (
                      <div key={`blank-${index}`} aria-hidden="true" />
                    ),
                  )}
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold text-[#64748b]">
                  <span className="rounded-full bg-[#ecfdf5] px-3 py-1 text-[#0f766e]">出勤可</span>
                  <span className="rounded-full bg-[#fff1f2] px-3 py-1 text-[#be123c]">休み希望</span>
                  <span className="rounded-full bg-[#f8fafc] px-3 py-1 text-[#64748b]">未定</span>
                </div>
              </>
            )}
          </>
        )}
      </section>

      {!isConfirmed ? (
        <div className="sticky bottom-0 -mx-4 mt-4 border-t border-[#dbe2ea] bg-white/95 p-4 backdrop-blur">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || isLoadingShift || isSubmitted}
            className="w-full rounded-lg bg-[#0f766e] px-4 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
          >
            {isSubmitted ? "提出済み（修正不可）" : isSaving ? "提出中..." : "希望シフトを提出"}
          </button>
        </div>
      ) : null}

      {isEditModalOpen && selectedEntry && !isConfirmed ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 py-4 sm:items-center">
          <section className="w-[calc(100vw-32px)] max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#0f766e]">希望シフトを編集</p>
                <h2 className="mt-1 text-2xl font-bold">
                  {selectedEntry.day}日
                  <span className="ml-1 text-sm text-[#64748b]">
                    ({getWeekdayLabel(month, selectedEntry.day)})
                  </span>
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsEditModalOpen(false)}
                aria-label="閉じる"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f1f5f9] text-xl font-bold text-[#334155]"
              >
                ×
              </button>
            </div>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-semibold text-[#64748b]">希望</span>
              <select
                value={selectedEntry.status}
                onChange={(event) => updateEntry(selectedEntry.day, { status: event.target.value as ShiftStatus })}
                disabled={isSubmitted}
                className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-3 text-base font-semibold outline-none focus:border-[#0f766e]"
              >
                {(Object.keys(statusLabels) as ShiftStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
              </select>
            </label>

            {selectedEntry.status === "AVAILABLE" ? (
              <div className="mt-3 space-y-3">
                <button
                  type="button"
                  onClick={() => toggleFreeAvailability(selectedEntry.day)}
                  disabled={isSubmitted}
                  className={`w-full rounded-xl border px-4 py-3 text-left text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    selectedEntry.isFree
                      ? "border-[#0f766e] bg-[#ecfdf5] text-[#0f766e]"
                      : "border-[#cbd5e1] bg-white text-[#334155]"
                  }`}
                >
                  フリー
                  <span className="mt-1 block text-xs font-semibold text-[#64748b]">
                    時間指定なし。何時でも入れます。
                  </span>
                </button>

                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <label className="block min-w-0 overflow-hidden">
                    <span className="mb-1 block text-xs font-semibold text-[#64748b]">開始</span>
                    <select
                      value={selectedEntry.startTime}
                      onChange={(event) => updateStartTime(selectedEntry.day, event.target.value)}
                      disabled={isSubmitted || selectedEntry.isFree}
                      className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] bg-white px-2 py-0 text-center text-sm font-semibold leading-[48px] outline-none focus:border-[#0f766e] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                    >
                      <option value="">指定なし</option>
                      {timeOptions.map((time) => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block min-w-0 overflow-hidden">
                    <span className="mb-1 block text-xs font-semibold text-[#64748b]">終了</span>
                    <select
                      value={selectedEntry.endTime}
                      onChange={(event) => updateEndTime(selectedEntry.day, event.target.value)}
                      disabled={isSubmitted || selectedEntry.isFree || !selectedEntry.startTime}
                      className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] bg-white px-2 py-0 text-center text-sm font-semibold leading-[48px] outline-none focus:border-[#0f766e] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                    >
                      {!selectedEntry.startTime ? <option value="">指定なし</option> : null}
                      {getEndTimeOptions(selectedEntry.startTime).map((time) => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setIsEditModalOpen(false)}
              className="mt-4 w-full rounded-lg bg-[#0f766e] px-4 py-3 text-base font-bold text-white"
            >
              {isSubmitted ? "閉じる" : "カレンダーに反映"}
            </button>
          </section>
        </div>
      ) : null}
    </main>
  );
}
