"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ShiftStatus = "UNSET" | "AVAILABLE" | "UNAVAILABLE";

type ShiftEntry = {
  day: number;
  status: ShiftStatus;
  startTime: string | null;
  endTime: string | null;
  isFree: boolean;
  memo: string | null;
};

type StaffShiftRow = {
  userId: string;
  displayName: string;
  pictureUrl: string | null;
  officialAccountId: string;
  officialAccountLabel: string;
  submittedAt: string | null;
  entries: ShiftEntry[];
};

type ShiftAssignment = {
  id: string;
  userId: string;
  day: number;
  startTime: string | null;
  endTime: string | null;
  isFree: boolean;
  memo: string | null;
};

type AutoReflectConflict = {
  id: string;
  day: number;
  candidates: ShiftAssignment[];
};

type EditingAvailability = {
  userId: string;
  displayName: string;
  day: number;
  status: ShiftStatus;
  startTime: string;
  endTime: string;
  isFree: boolean;
};

type Props = {
  month: string;
  staff: StaffShiftRow[];
  initialAssignments: ShiftAssignment[];
  initialAssignmentsSource: "confirmed" | "draft" | "empty";
  initialDraftUpdatedAt: string | null;
};

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];
const timeOptions = Array.from({ length: 96 }, (_, index) => {
  const hour = String(Math.floor(index / 4)).padStart(2, "0");
  const minute = String((index % 4) * 15).padStart(2, "0");
  return `${hour}:${minute}`;
});

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

function resolveEntryLabel(entry: ShiftEntry | undefined) {
  if (!entry || entry.status === "UNSET") return "未定";
  if (entry.status === "UNAVAILABLE") return "休";
  if (entry.isFree) return "フリー";
  return `${entry.startTime ?? "--:--"}-${entry.endTime ?? "--:--"}`;
}

function resolveAssignmentLabel(assignment: ShiftAssignment) {
  if (assignment.isFree) return "フリー";
  return `${assignment.startTime ?? "--:--"}-${assignment.endTime ?? "--:--"}`;
}

function getEndTimeOptions(startTime: string) {
  return startTime ? timeOptions.filter((time) => time > startTime) : timeOptions;
}

function resolveEntryClassName(entry: ShiftEntry | undefined) {
  if (!entry || entry.status === "UNSET") return "bg-[#f8fafc] text-[#64748b]";
  if (entry.status === "UNAVAILABLE") return "bg-[#fff1f2] text-[#be123c]";
  return "bg-[#ecfdf5] text-[#0f766e]";
}

function isSameAssignment(a: ShiftAssignment, b: ShiftAssignment) {
  return (
    a.userId === b.userId &&
    a.day === b.day &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.isFree === b.isFree
  );
}

function overlaps(a: ShiftAssignment, b: ShiftAssignment) {
  if (a.isFree || b.isFree || !a.startTime || !a.endTime || !b.startTime || !b.endTime) return false;
  return a.day === b.day && a.startTime < b.endTime && b.startTime < a.endTime;
}

function buildConflictGroups(candidates: ShiftAssignment[]) {
  const nonConflicting: ShiftAssignment[] = [];
  const conflicts: AutoReflectConflict[] = [];
  const byDay = new Map<number, ShiftAssignment[]>();

  for (const candidate of candidates) {
    if (candidate.isFree || !candidate.startTime || !candidate.endTime) {
      nonConflicting.push(candidate);
      continue;
    }
    const rows = byDay.get(candidate.day) ?? [];
    rows.push(candidate);
    byDay.set(candidate.day, rows);
  }

  for (const [day, rows] of byDay.entries()) {
    const sorted = rows.slice().sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
    let currentGroup: ShiftAssignment[] = [];
    let currentMaxEnd = "";

    const flush = () => {
      if (currentGroup.length === 0) return;
      if (currentGroup.length === 1) {
        nonConflicting.push(currentGroup[0]);
      } else {
        conflicts.push({
          id: `conflict-${day}-${conflicts.length}`,
          day,
          candidates: currentGroup,
        });
      }
    };

    for (const row of sorted) {
      if (currentGroup.length === 0) {
        currentGroup = [row];
        currentMaxEnd = row.endTime ?? "";
        continue;
      }

      const hasOverlap = currentGroup.some((item) => overlaps(item, row));
      if (hasOverlap || (row.startTime ?? "") < currentMaxEnd) {
        currentGroup.push(row);
        currentMaxEnd = (row.endTime ?? "") > currentMaxEnd ? (row.endTime ?? "") : currentMaxEnd;
      } else {
        flush();
        currentGroup = [row];
        currentMaxEnd = row.endTime ?? "";
      }
    }
    flush();
  }

  return { nonConflicting, conflicts };
}

export default function AdminShiftsClient({
  month,
  staff,
  initialAssignments,
  initialAssignmentsSource,
  initialDraftUpdatedAt,
}: Props) {
  const router = useRouter();
  const [assignments, setAssignments] = useState(initialAssignments);
  const [assignmentDay, setAssignmentDay] = useState(1);
  const [assignmentUserId, setAssignmentUserId] = useState(staff[0]?.userId ?? "");
  const [assignmentStartTime, setAssignmentStartTime] = useState("18:00");
  const [assignmentEndTime, setAssignmentEndTime] = useState("23:00");
  const [assignmentIsFree, setAssignmentIsFree] = useState(false);
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "saving" | "saved" | "error">(
    initialAssignmentsSource === "draft" ? "saved" : "idle",
  );
  const [draftUpdatedAt, setDraftUpdatedAt] = useState<string | null>(initialDraftUpdatedAt);
  const [autoReflectConflicts, setAutoReflectConflicts] = useState<AutoReflectConflict[]>([]);
  const [activeConflictIndex, setActiveConflictIndex] = useState(0);
  const [selectedConflictCandidateIds, setSelectedConflictCandidateIds] = useState<string[]>([]);
  const [editingAvailability, setEditingAvailability] = useState<EditingAvailability | null>(null);
  const [isSavingAvailability, setIsSavingAvailability] = useState(false);
  const [availabilityMessage, setAvailabilityMessage] = useState<string | null>(null);
  const [releasingSubmissionKey, setReleasingSubmissionKey] = useState<string | null>(null);
  const [isAssignmentSummaryOpen, setIsAssignmentSummaryOpen] = useState(false);
  const days = useMemo(() => Array.from({ length: getDaysInMonth(month) }, (_, index) => index + 1), [month]);
  const submittedCount = staff.filter((row) => row.submittedAt).length;
  const totalCount = staff.length;
  const didMountDraftEffectRef = useRef(false);
  const lastDraftSignatureRef = useRef(JSON.stringify(initialAssignments));

  const normalizedStaff = useMemo(
    () =>
      staff.map((row) => ({
        ...row,
        entryByDay: new Map(row.entries.map((entry) => [entry.day, entry])),
      })),
    [staff],
  );
  const staffById = useMemo(() => new Map(staff.map((row) => [row.userId, row])), [staff]);
  const assignmentsByDay = useMemo(() => {
    const grouped = new Map<number, ShiftAssignment[]>();
    for (const assignment of assignments) {
      const rows = grouped.get(assignment.day) ?? [];
      rows.push(assignment);
      grouped.set(assignment.day, rows);
    }
    for (const rows of grouped.values()) {
      rows.sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? ""));
    }
    return grouped;
  }, [assignments]);
  const assignmentSummary = useMemo(
    () =>
      staff
        .map((row) => ({
          userId: row.userId,
          displayName: row.displayName,
          count: assignments.filter((assignment) => assignment.userId === row.userId).length,
        }))
        .sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName, "ja")),
    [assignments, staff],
  );

  useEffect(() => {
    const signature = JSON.stringify(assignments);
    if (!didMountDraftEffectRef.current) {
      didMountDraftEffectRef.current = true;
      lastDraftSignatureRef.current = signature;
      return;
    }
    if (signature === lastDraftSignatureRef.current) return;

    const timeoutId = window.setTimeout(() => {
      setDraftStatus("saving");
      void fetch("/api/admin/shifts/schedule-draft", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          assignments: assignments.map((assignment) => ({
            userId: assignment.userId,
            day: assignment.day,
            startTime: assignment.isFree ? null : assignment.startTime,
            endTime: assignment.isFree ? null : assignment.endTime,
            isFree: assignment.isFree,
            memo: null,
          })),
        }),
      })
        .then(async (response) => {
          const json = (await response.json()) as { ok?: boolean; updatedAt?: string; message?: string };
          if (!response.ok || !json.ok) {
            throw new Error(json.message ?? "Draftの保存に失敗しました。");
          }
          lastDraftSignatureRef.current = signature;
          setDraftUpdatedAt(json.updatedAt ?? new Date().toISOString());
          setDraftStatus("saved");
        })
        .catch(() => {
          setDraftStatus("error");
        });
    }, 800);

    return () => window.clearTimeout(timeoutId);
  }, [assignments, month]);

  const handleMonthChange = (nextMonth: string) => {
    router.push(`/admin/shifts?month=${encodeURIComponent(nextMonth)}`);
  };

  const handleOpenAvailabilityEdit = (row: StaffShiftRow, day: number, entry: ShiftEntry | undefined) => {
    setAvailabilityMessage(null);
    setEditingAvailability({
      userId: row.userId,
      displayName: row.displayName,
      day,
      status: entry?.status ?? "UNSET",
      startTime: entry?.startTime ?? "",
      endTime: entry?.endTime ?? "",
      isFree: entry?.isFree ?? false,
    });
  };

  const updateEditingAvailability = (patch: Partial<EditingAvailability>) => {
    setEditingAvailability((prev) =>
      prev
        ? {
            ...prev,
            ...patch,
            ...(patch.status ? { startTime: "", endTime: "", isFree: false } : {}),
          }
        : prev,
    );
  };

  const updateEditingStartTime = (startTime: string) => {
    setEditingAvailability((prev) => {
      if (!prev) return prev;
      if (!startTime) return { ...prev, startTime: "", endTime: "", isFree: true };
      const endOptions = getEndTimeOptions(startTime);
      return {
        ...prev,
        startTime,
        endTime: prev.endTime && prev.endTime > startTime ? prev.endTime : (endOptions[0] ?? ""),
        isFree: false,
      };
    });
  };

  const updateEditingEndTime = (endTime: string) => {
    setEditingAvailability((prev) => (prev ? { ...prev, endTime, isFree: false } : prev));
  };

  const setEditingFreeAvailability = () => {
    setEditingAvailability((prev) =>
      prev ? { ...prev, status: "AVAILABLE", startTime: "", endTime: "", isFree: true } : prev,
    );
  };

  const handleSaveAvailability = async () => {
    if (!editingAvailability || isSavingAvailability) return;
    setIsSavingAvailability(true);
    setAvailabilityMessage(null);
    try {
      const response = await fetch("/api/admin/shifts/submission", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: editingAvailability.userId,
          month,
          day: editingAvailability.day,
          status: editingAvailability.status,
          startTime:
            editingAvailability.status === "AVAILABLE" && !editingAvailability.isFree
              ? editingAvailability.startTime || null
              : null,
          endTime:
            editingAvailability.status === "AVAILABLE" && !editingAvailability.isFree
              ? editingAvailability.endTime || null
              : null,
          isFree: editingAvailability.status === "AVAILABLE" && editingAvailability.isFree,
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "希望シフトの修正に失敗しました。");
      }
      setEditingAvailability(null);
      setAvailabilityMessage("希望シフトを修正しました。");
      router.refresh();
    } catch (error) {
      setAvailabilityMessage(error instanceof Error ? error.message : "希望シフトの修正に失敗しました。");
    } finally {
      setIsSavingAvailability(false);
    }
  };

  const handleDeleteAvailability = async () => {
    if (!editingAvailability || isSavingAvailability) return;
    setIsSavingAvailability(true);
    setAvailabilityMessage(null);
    try {
      const response = await fetch("/api/admin/shifts/submission", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: editingAvailability.userId,
          month,
          day: editingAvailability.day,
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "希望シフトの削除に失敗しました。");
      }
      setEditingAvailability(null);
      setAvailabilityMessage("希望シフトを削除しました。");
      router.refresh();
    } catch (error) {
      setAvailabilityMessage(error instanceof Error ? error.message : "希望シフトの削除に失敗しました。");
    } finally {
      setIsSavingAvailability(false);
    }
  };

  const handleReleaseSubmission = async (row: StaffShiftRow) => {
    const key = `${row.userId}:${row.officialAccountId}`;
    if (releasingSubmissionKey) return;
    setReleasingSubmissionKey(key);
    setAvailabilityMessage(null);
    try {
      const response = await fetch("/api/admin/shifts/submission", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: row.userId,
          month,
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "提出状態の解除に失敗しました。");
      }
      setAvailabilityMessage(`${row.displayName}さんの提出状態を解除しました。`);
      router.refresh();
    } catch (error) {
      setAvailabilityMessage(error instanceof Error ? error.message : "提出状態の解除に失敗しました。");
    } finally {
      setReleasingSubmissionKey(null);
    }
  };

  const handleAddAssignment = () => {
    setScheduleMessage(null);
    if (!assignmentUserId) {
      setScheduleMessage("スタッフを選択してください。");
      return;
    }
    if (!assignmentIsFree && assignmentStartTime >= assignmentEndTime) {
      setScheduleMessage("終了時刻は開始時刻より後にしてください。");
      return;
    }
    setAssignments((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: assignmentUserId,
        day: assignmentDay,
        startTime: assignmentIsFree ? null : assignmentStartTime,
        endTime: assignmentIsFree ? null : assignmentEndTime,
        isFree: assignmentIsFree,
        memo: null,
      },
    ]);
  };

  const handleDeleteAssignment = (assignmentId: string) => {
    setAssignments((prev) => prev.filter((assignment) => assignment.id !== assignmentId));
  };

  const appendAssignments = (nextAssignments: ShiftAssignment[]) => {
    if (nextAssignments.length === 0) return;
    setAssignments((prev) => {
      const merged = [...prev];
      for (const assignment of nextAssignments) {
        if (!merged.some((row) => isSameAssignment(row, assignment))) {
          merged.push(assignment);
        }
      }
      return merged;
    });
  };

  const handleAutoReflect = () => {
    setScheduleMessage(null);
    const candidates: ShiftAssignment[] = normalizedStaff.flatMap((row) =>
      row.entries.flatMap<ShiftAssignment>((entry) => {
        if (entry.status !== "AVAILABLE") return [];
        if (entry.isFree) {
          return [
            {
              id: `auto-free-${row.userId}-${entry.day}`,
              userId: row.userId,
              day: entry.day,
              startTime: null,
              endTime: null,
              isFree: true,
              memo: null,
            },
          ];
        }
        if (entry.startTime && entry.endTime) {
          if (!timeOptions.includes(entry.startTime) || !timeOptions.includes(entry.endTime)) return [];
          return [
            {
              id: `auto-${row.userId}-${entry.day}-${entry.startTime}-${entry.endTime}`,
              userId: row.userId,
              day: entry.day,
              startTime: entry.startTime,
              endTime: entry.endTime,
              isFree: false,
              memo: null,
            },
          ];
        }
        return [];
      }),
    );
    const newCandidates = candidates.filter(
      (candidate) => !assignments.some((assignment) => isSameAssignment(assignment, candidate)),
    );
    if (newCandidates.length === 0) {
      setScheduleMessage("自動反映できる新しい希望シフトはありません。");
      return;
    }

    const { nonConflicting, conflicts } = buildConflictGroups(newCandidates);
    appendAssignments(nonConflicting);
    if (conflicts.length > 0) {
      setAutoReflectConflicts(conflicts);
      setActiveConflictIndex(0);
      setSelectedConflictCandidateIds([]);
      setScheduleMessage(
        `${nonConflicting.length}件を自動反映しました。時間が重なる候補を確認してください。`,
      );
      return;
    }
    setScheduleMessage(`${nonConflicting.length}件の希望シフトを自動反映しました。`);
  };

  const closeCurrentConflict = () => {
    setSelectedConflictCandidateIds([]);
    setActiveConflictIndex((prev) => {
      const next = prev + 1;
      if (next >= autoReflectConflicts.length) {
        setAutoReflectConflicts([]);
        return 0;
      }
      return next;
    });
  };

  const handleToggleConflictCandidate = (candidateId: string) => {
    setSelectedConflictCandidateIds((prev) =>
      prev.includes(candidateId) ? prev.filter((id) => id !== candidateId) : [...prev, candidateId],
    );
  };

  const handleChooseSelectedConflict = () => {
    const conflict = autoReflectConflicts[activeConflictIndex];
    const selected = (conflict?.candidates ?? []).filter((candidate) =>
      selectedConflictCandidateIds.includes(candidate.id),
    );
    if (selected.length === 0) {
      setScheduleMessage("入れるスタッフを選択してください。");
      return;
    }
    appendAssignments(selected);
    closeCurrentConflict();
  };

  const handleChooseAllConflict = () => {
    const conflict = autoReflectConflicts[activeConflictIndex];
    appendAssignments(conflict?.candidates ?? []);
    closeCurrentConflict();
  };

  const handleChooseNoneConflict = () => {
    closeCurrentConflict();
  };

  const handleSaveSchedule = async () => {
    setIsSavingSchedule(true);
    setScheduleMessage(null);
    try {
      const response = await fetch("/api/admin/shifts/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          month,
          assignments: assignments.map((assignment) => ({
            userId: assignment.userId,
            day: assignment.day,
            startTime: assignment.isFree ? null : assignment.startTime,
            endTime: assignment.isFree ? null : assignment.endTime,
            isFree: assignment.isFree,
            memo: null,
          })),
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "確定シフトの保存に失敗しました。");
      }
      setScheduleMessage("確定シフトを保存しました。");
      setDraftStatus("idle");
      setDraftUpdatedAt(null);
      router.refresh();
    } catch (error) {
      setScheduleMessage(error instanceof Error ? error.message : "確定シフトの保存に失敗しました。");
    } finally {
      setIsSavingSchedule(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <header className="rounded-2xl bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-[#0f766e]">勤務表</p>
        <h1 className="mt-1 text-2xl font-bold">希望シフト管理</h1>
        <p className="mt-2 text-sm text-[#64748b]">
          スタッフが提出した月次希望シフトを確認できます。
        </p>
      </header>

      <section className="overflow-hidden rounded-2xl bg-white p-4 shadow-sm">
        <label className="block min-w-0 overflow-hidden">
          <span className="mb-1 block text-sm font-semibold text-[#334155]">対象月</span>
          <input
            type="month"
            value={month}
            onChange={(event) => handleMonthChange(event.target.value)}
            className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] px-2 py-0 text-center text-sm font-semibold leading-12 outline-none focus:border-[#0f766e] sm:w-64"
          />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:max-w-sm">
          <div className="rounded-lg bg-[#ecfdf5] px-3 py-2 font-semibold text-[#0f766e]">
            提出済み {submittedCount}人
          </div>
          <div className="rounded-lg bg-[#fff1f2] px-3 py-2 font-semibold text-[#be123c]">
            未提出 {Math.max(totalCount - submittedCount, 0)}人
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">日別一覧</h2>
          <div className="flex gap-2 text-xs font-semibold">
            <span className="rounded-full bg-[#ecfdf5] px-2 py-1 text-[#0f766e]">出勤可</span>
            <span className="rounded-full bg-[#fff1f2] px-2 py-1 text-[#be123c]">休み</span>
          </div>
        </div>
        {availabilityMessage ? (
          <p className="mb-3 rounded-lg bg-[#f8fafc] px-3 py-2 text-sm font-semibold text-[#334155]">
            {availabilityMessage}
          </p>
        ) : null}
        {normalizedStaff.length === 0 ? (
          <p className="text-sm text-[#64748b]">スタッフが登録されていません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-max border-separate border-spacing-1 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-36 min-w-36 rounded-lg bg-[#f8fafc] px-3 py-2 text-left text-xs text-[#64748b]">
                    スタッフ
                  </th>
                  {days.map((day) => (
                    <th key={day} className="min-w-20 rounded-lg bg-[#f8fafc] px-2 py-2 text-xs text-[#64748b]">
                      <span className="block font-bold text-[#0f172a]">{day}</span>
                      <span>{getWeekdayLabel(month, day)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {normalizedStaff.map((row) => (
                  <tr key={`${row.userId}:${row.officialAccountId}`}>
                    <th className="sticky left-0 z-10 w-36 min-w-36 rounded-lg bg-white px-3 py-2 text-left align-top shadow-sm">
                      <span className="block truncate font-bold text-[#0f172a]">{row.displayName}</span>
                      <span className="mt-1 flex items-center gap-1">
                        <span
                          className={`inline-flex h-6 items-center rounded-full px-2 text-[10px] font-semibold leading-none ${
                            row.submittedAt ? "bg-[#ecfdf5] text-[#0f766e]" : "bg-[#fff1f2] text-[#be123c]"
                          }`}
                        >
                          {row.submittedAt ? "提出済み" : "未提出"}
                        </span>
                        {row.submittedAt ? (
                          <button
                            type="button"
                            onClick={() => void handleReleaseSubmission(row)}
                            disabled={releasingSubmissionKey === `${row.userId}:${row.officialAccountId}`}
                            className="inline-flex h-6 shrink-0 items-center rounded-full border border-[#cbd5e1] px-2 text-[10px] font-bold leading-none text-[#334155] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {releasingSubmissionKey === `${row.userId}:${row.officialAccountId}` ? "解除中" : "解除"}
                          </button>
                        ) : null}
                      </span>
                    </th>
                    {days.map((day) => {
                      const entry = row.entryByDay.get(day);
                      return (
                        <td key={day} className="align-top">
                          <button
                            type="button"
                            onClick={() => handleOpenAvailabilityEdit(row, day, entry)}
                            className={`min-h-12 w-full rounded-lg px-2 py-2 text-center text-xs font-semibold transition hover:ring-2 hover:ring-[#0f766e] hover:ring-offset-1 ${resolveEntryClassName(entry)}`}
                            title={`${row.displayName} ${day}日を修正`}
                          >
                            {resolveEntryLabel(entry)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-bold">確定シフト作成</h2>
            <p className="mt-1 text-sm text-[#64748b]">
              希望を見ながら、実際に入るスタッフと時間を追加してください。
              <br/>
              修正が終われば必ず<span className="font-bold text-[#be123c]">「確定シフトを保存」</span>を押してください。
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setIsAssignmentSummaryOpen(true)}
              className="rounded-lg border border-[#cbd5e1] px-4 py-2 text-sm font-bold text-[#334155]"
            >
              回数を確認
            </button>
            <button
              type="button"
              onClick={() => void handleSaveSchedule()}
              disabled={isSavingSchedule}
              className="rounded-lg bg-[#0f766e] px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
            >
              {isSavingSchedule ? "保存中..." : "確定シフトを保存"}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={handleAutoReflect}
          className="mt-4 w-full rounded-lg border border-[#0f766e] bg-[#ecfdf5] px-4 py-3 text-sm font-bold text-[#0f766e] sm:w-auto"
        >
          希望シフトを自動反映
        </button>
        <p
          className={`mt-2 text-xs font-semibold ${
            draftStatus === "error" ? "text-[#be123c]" : "text-[#64748b]"
          }`}
        >
          {draftStatus === "saving"
            ? "Draft保存中..."
            : draftStatus === "saved"
              ? `Draft保存済み${draftUpdatedAt ? `: ${new Date(draftUpdatedAt).toLocaleTimeString("ja-JP")}` : ""}`
              : draftStatus === "error"
                ? "Draft保存に失敗しました。通信状態を確認してください。"
                : "編集するとDraftとして自動保存されます。"}
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-[110px_1fr_90px_120px_120px_auto]">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">日付</span>
            <select
              value={assignmentDay}
              onChange={(event) => setAssignmentDay(Number(event.target.value))}
              className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e]"
            >
              {days.map((day) => (
                <option key={day} value={day}>
                  {day}日({getWeekdayLabel(month, day)})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">スタッフ</span>
            <select
              value={assignmentUserId}
              onChange={(event) => setAssignmentUserId(event.target.value)}
              className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e]"
            >
              {staff.map((row) => (
                <option key={`${row.userId}:${row.officialAccountId}`} value={row.userId}>
                  {row.displayName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setAssignmentIsFree((prev) => !prev)}
            className={`self-end rounded-lg border px-4 py-2 text-sm font-bold transition ${
              assignmentIsFree
                ? "border-[#0f766e] bg-[#ecfdf5] text-[#0f766e]"
                : "border-[#cbd5e1] bg-white text-[#334155]"
            }`}
          >
            フリー
          </button>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">開始</span>
            <input
              type="time"
              value={assignmentStartTime}
              onChange={(event) => setAssignmentStartTime(event.target.value)}
              disabled={assignmentIsFree}
              className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">終了</span>
            <input
              type="time"
              value={assignmentEndTime}
              onChange={(event) => setAssignmentEndTime(event.target.value)}
              disabled={assignmentIsFree}
              className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
            />
          </label>
          <button
            type="button"
            onClick={handleAddAssignment}
            className="self-end rounded-lg border border-[#0f766e] px-4 py-2 text-sm font-bold text-[#0f766e]"
          >
            追加
          </button>
        </div>

        {scheduleMessage ? (
          <p className="mt-3 text-sm font-semibold text-[#334155]">{scheduleMessage}</p>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-max border-separate border-spacing-1 text-sm">
            <thead>
              <tr>
                {days.map((day) => (
                  <th key={day} className="min-w-36 rounded-lg bg-[#f8fafc] px-2 py-2 text-xs text-[#64748b]">
                    <span className="block font-bold text-[#0f172a]">{day}</span>
                    <span>{getWeekdayLabel(month, day)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                {days.map((day) => {
                  const dayAssignments = assignmentsByDay.get(day) ?? [];
                  return (
                    <td key={day} className="align-top">
                      <div className="min-h-24 space-y-1 rounded-lg bg-[#f8fafc] p-2">
                        {dayAssignments.length > 0 ? (
                          dayAssignments.map((assignment) => (
                            <div key={assignment.id} className="rounded-lg bg-white px-2 py-2 text-xs shadow-sm">
                              <p className="font-bold text-[#0f172a]">
                                {staffById.get(assignment.userId)?.displayName ?? assignment.userId}
                              </p>
                              <p className="mt-1 font-semibold text-[#0f766e]">
                                {resolveAssignmentLabel(assignment)}
                              </p>
                              <button
                                type="button"
                                onClick={() => handleDeleteAssignment(assignment.id)}
                                className="mt-1 text-xs font-bold text-[#be123c]"
                              >
                                削除
                              </button>
                            </div>
                          ))
                        ) : (
                          <p className="pt-7 text-center text-xs text-[#94a3b8]">未設定</p>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {editingAvailability ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#0f766e]">希望シフトを修正</p>
                <h2 className="mt-1 text-xl font-bold">
                  {editingAvailability.displayName} / {editingAvailability.day}日(
                  {getWeekdayLabel(month, editingAvailability.day)})
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setEditingAvailability(null)}
                aria-label="閉じる"
                className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f1f5f9] text-xl font-bold text-[#334155]"
              >
                ×
              </button>
            </div>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-semibold text-[#64748b]">希望</span>
              <select
                value={editingAvailability.status}
                onChange={(event) => updateEditingAvailability({ status: event.target.value as ShiftStatus })}
                className="w-full rounded-lg border border-[#cbd5e1] bg-white px-3 py-3 text-base font-semibold outline-none focus:border-[#0f766e]"
              >
                <option value="UNSET">未定</option>
                <option value="AVAILABLE">出勤可</option>
                <option value="UNAVAILABLE">休み希望</option>
              </select>
            </label>

            {editingAvailability.status === "AVAILABLE" ? (
              <div className="mt-3 space-y-3">
                <button
                  type="button"
                  onClick={setEditingFreeAvailability}
                  className={`w-full rounded-xl border px-4 py-3 text-left text-sm font-bold transition ${
                    editingAvailability.isFree
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
                      value={editingAvailability.startTime}
                      onChange={(event) => updateEditingStartTime(event.target.value)}
                      className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] bg-white px-2 py-0 text-center text-sm font-semibold leading-12 outline-none focus:border-[#0f766e]"
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
                      value={editingAvailability.endTime}
                      onChange={(event) => updateEditingEndTime(event.target.value)}
                      disabled={!editingAvailability.startTime}
                      className="block h-12 w-full min-w-0 max-w-full appearance-none rounded-lg border border-[#cbd5e1] bg-white px-2 py-0 text-center text-sm font-semibold leading-12 outline-none focus:border-[#0f766e] disabled:bg-[#f8fafc] disabled:text-[#94a3b8]"
                    >
                      {!editingAvailability.startTime ? <option value="">指定なし</option> : null}
                      {getEndTimeOptions(editingAvailability.startTime).map((time) => (
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
              onClick={() => void handleDeleteAvailability()}
              disabled={isSavingAvailability}
              className="mt-4 w-full rounded-lg border border-[#fecdd3] bg-[#fff1f2] px-4 py-3 text-sm font-bold text-[#be123c] disabled:cursor-not-allowed disabled:opacity-60"
            >
              この日の希望を削除
            </button>

            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setEditingAvailability(null)}
                className="rounded-lg border border-[#cbd5e1] px-4 py-3 text-sm font-bold text-[#334155]"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleSaveAvailability()}
                disabled={isSavingAvailability}
                className="rounded-lg bg-[#0f766e] px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
              >
                {isSavingAvailability ? "保存中..." : "保存"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {isAssignmentSummaryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <section className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-[#e2e8f0] p-5">
              <div>
                <p className="text-sm font-semibold text-[#0f766e]">シフト回数</p>
                <h2 className="mt-1 text-xl font-bold">スタッフ別の入っている回数</h2>
                <p className="mt-1 text-sm text-[#64748b]">
                  現在のDraft/確定シフト作成内容: 全{assignments.length}件
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsAssignmentSummaryOpen(false)}
                aria-label="閉じる"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f1f5f9] text-xl font-bold text-[#334155]"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <div className="space-y-2">
                {assignmentSummary.map((row, index) => (
                  <div
                    key={row.userId}
                    className={`flex items-center justify-between gap-3 rounded-xl px-4 py-3 ${
                      row.count > 0 ? "bg-[#f8fafc]" : "bg-white text-[#94a3b8]"
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-[#0f172a]">
                        {index + 1}. {row.displayName}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-3 py-1 text-sm font-bold ${
                        row.count > 0 ? "bg-[#ecfdf5] text-[#0f766e]" : "bg-[#f1f5f9] text-[#64748b]"
                      }`}
                    >
                      {row.count}回
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-[#e2e8f0] p-4">
              <button
                type="button"
                onClick={() => setIsAssignmentSummaryOpen(false)}
                className="w-full rounded-lg bg-[#0f766e] px-4 py-3 text-sm font-bold text-white"
              >
                閉じる
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {autoReflectConflicts[activeConflictIndex] ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <p className="text-sm font-semibold text-[#be123c]">時間が重なっています</p>
            <h2 className="mt-1 text-xl font-bold">
              {autoReflectConflicts[activeConflictIndex].day}日(
              {getWeekdayLabel(month, autoReflectConflicts[activeConflictIndex].day)})
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#64748b]">
              希望時間が重なっているスタッフがいます。確定シフトにどう反映するか選んでください。
            </p>

            <div className="mt-4 space-y-2">
              {autoReflectConflicts[activeConflictIndex].candidates.map((candidate) => {
                const selected = selectedConflictCandidateIds.includes(candidate.id);
                return (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => handleToggleConflictCandidate(candidate.id)}
                  className={`w-full rounded-xl border px-4 py-3 text-left hover:bg-[#f8fafc] ${
                    selected ? "border-[#0f766e] bg-[#ecfdf5]" : "border-[#dbe2ea]"
                  }`}
                >
                  <span className="flex items-start gap-3">
                    <span
                      aria-hidden="true"
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs font-bold ${
                        selected ? "border-[#0f766e] bg-[#0f766e] text-white" : "border-[#cbd5e1] bg-white"
                      }`}
                    >
                      {selected ? "✓" : ""}
                    </span>
                    <span>
                      <span className="block font-bold text-[#0f172a]">
                        {staffById.get(candidate.userId)?.displayName ?? candidate.userId}
                      </span>
                      <span className="mt-1 block text-sm font-semibold text-[#0f766e]">
                        {resolveAssignmentLabel(candidate)}
                      </span>
                    </span>
                  </span>
                </button>
                );
              })}
            </div>

            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={handleChooseSelectedConflict}
                className="rounded-lg bg-[#0f766e] px-4 py-3 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
                disabled={selectedConflictCandidateIds.length === 0}
              >
                選択したスタッフを入れる
              </button>
              <button
                type="button"
                onClick={handleChooseAllConflict}
                className="rounded-lg border border-[#0f766e] px-4 py-3 text-sm font-bold text-[#0f766e]"
              >
                全員入れる
              </button>
              <button
                type="button"
                onClick={handleChooseNoneConflict}
                className="rounded-lg border border-[#cbd5e1] px-4 py-3 text-sm font-bold text-[#334155]"
              >
                全員入れない
              </button>
            </div>

            <p className="mt-3 text-center text-xs text-[#94a3b8]">
              {activeConflictIndex + 1}/{autoReflectConflicts.length}
            </p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
