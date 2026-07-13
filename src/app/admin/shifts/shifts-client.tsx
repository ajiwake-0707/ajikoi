"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ShiftStatus = "UNSET" | "AVAILABLE" | "UNAVAILABLE";

type ShiftEntry = {
  day: number;
  status: ShiftStatus;
  startTime: string | null;
  endTime: string | null;
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
  startTime: string;
  endTime: string;
  memo: string | null;
};

type AutoReflectConflict = {
  id: string;
  day: number;
  candidates: ShiftAssignment[];
};

type Props = {
  month: string;
  staff: StaffShiftRow[];
  initialAssignments: ShiftAssignment[];
};

const weekdayLabels = ["日", "月", "火", "水", "木", "金", "土"];

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
  return `${entry.startTime ?? "--:--"}-${entry.endTime ?? "--:--"}`;
}

function resolveEntryClassName(entry: ShiftEntry | undefined) {
  if (!entry || entry.status === "UNSET") return "bg-[#f8fafc] text-[#64748b]";
  if (entry.status === "UNAVAILABLE") return "bg-[#fff1f2] text-[#be123c]";
  return "bg-[#ecfdf5] text-[#0f766e]";
}

function isSameAssignment(a: ShiftAssignment, b: ShiftAssignment) {
  return a.userId === b.userId && a.day === b.day && a.startTime === b.startTime && a.endTime === b.endTime;
}

function overlaps(a: ShiftAssignment, b: ShiftAssignment) {
  return a.day === b.day && a.startTime < b.endTime && b.startTime < a.endTime;
}

function buildConflictGroups(candidates: ShiftAssignment[]) {
  const nonConflicting: ShiftAssignment[] = [];
  const conflicts: AutoReflectConflict[] = [];
  const byDay = new Map<number, ShiftAssignment[]>();

  for (const candidate of candidates) {
    const rows = byDay.get(candidate.day) ?? [];
    rows.push(candidate);
    byDay.set(candidate.day, rows);
  }

  for (const [day, rows] of byDay.entries()) {
    const sorted = rows.slice().sort((a, b) => a.startTime.localeCompare(b.startTime));
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
        currentMaxEnd = row.endTime;
        continue;
      }

      const hasOverlap = currentGroup.some((item) => overlaps(item, row));
      if (hasOverlap || row.startTime < currentMaxEnd) {
        currentGroup.push(row);
        currentMaxEnd = row.endTime > currentMaxEnd ? row.endTime : currentMaxEnd;
      } else {
        flush();
        currentGroup = [row];
        currentMaxEnd = row.endTime;
      }
    }
    flush();
  }

  return { nonConflicting, conflicts };
}

export default function AdminShiftsClient({ month, staff, initialAssignments }: Props) {
  const router = useRouter();
  const [assignments, setAssignments] = useState(initialAssignments);
  const [assignmentDay, setAssignmentDay] = useState(1);
  const [assignmentUserId, setAssignmentUserId] = useState(staff[0]?.userId ?? "");
  const [assignmentStartTime, setAssignmentStartTime] = useState("18:00");
  const [assignmentEndTime, setAssignmentEndTime] = useState("23:00");
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [scheduleMessage, setScheduleMessage] = useState<string | null>(null);
  const [autoReflectConflicts, setAutoReflectConflicts] = useState<AutoReflectConflict[]>([]);
  const [activeConflictIndex, setActiveConflictIndex] = useState(0);
  const [selectedConflictCandidateIds, setSelectedConflictCandidateIds] = useState<string[]>([]);
  const days = useMemo(() => Array.from({ length: getDaysInMonth(month) }, (_, index) => index + 1), [month]);
  const submittedCount = staff.filter((row) => row.submittedAt).length;
  const totalCount = staff.length;

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
      rows.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return grouped;
  }, [assignments]);

  const handleMonthChange = (nextMonth: string) => {
    router.push(`/admin/shifts?month=${encodeURIComponent(nextMonth)}`);
  };

  const handleAddAssignment = () => {
    setScheduleMessage(null);
    if (!assignmentUserId) {
      setScheduleMessage("スタッフを選択してください。");
      return;
    }
    if (assignmentStartTime >= assignmentEndTime) {
      setScheduleMessage("終了時刻は開始時刻より後にしてください。");
      return;
    }
    setAssignments((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: assignmentUserId,
        day: assignmentDay,
        startTime: assignmentStartTime,
        endTime: assignmentEndTime,
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
    const candidates = normalizedStaff.flatMap((row) =>
      row.entries
        .filter((entry) => entry.status === "AVAILABLE" && entry.startTime && entry.endTime)
        .map((entry) => ({
          id: `auto-${row.userId}-${entry.day}-${entry.startTime}-${entry.endTime}`,
          userId: row.userId,
          day: entry.day,
          startTime: entry.startTime ?? "",
          endTime: entry.endTime ?? "",
          memo: null,
        })),
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
            startTime: assignment.startTime,
            endTime: assignment.endTime,
            memo: null,
          })),
        }),
      });
      const json = (await response.json()) as { ok?: boolean; message?: string };
      if (!response.ok || !json.ok) {
        throw new Error(json.message ?? "確定シフトの保存に失敗しました。");
      }
      setScheduleMessage("確定シフトを保存しました。");
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

      <section className="rounded-2xl bg-white p-4 shadow-sm">
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-[#334155]">対象月</span>
          <input
            type="month"
            value={month}
            onChange={(event) => handleMonthChange(event.target.value)}
            className="w-full rounded-lg border border-[#cbd5e1] px-3 py-3 text-base font-semibold outline-none focus:border-[#0f766e] sm:w-64"
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
        {normalizedStaff.length === 0 ? (
          <p className="text-sm text-[#64748b]">スタッフが登録されていません。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-max border-separate border-spacing-1 text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 min-w-36 rounded-lg bg-[#f8fafc] px-3 py-2 text-left text-xs text-[#64748b]">
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
                    <th className="sticky left-0 z-10 rounded-lg bg-white px-3 py-2 text-left align-top shadow-sm">
                      <span className="block font-bold text-[#0f172a]">{row.displayName}</span>
                      <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${
                        row.submittedAt ? "bg-[#ecfdf5] text-[#0f766e]" : "bg-[#fff1f2] text-[#be123c]"
                      }`}>
                        {row.submittedAt ? "提出済み" : "未提出"}
                      </span>
                    </th>
                    {days.map((day) => {
                      const entry = row.entryByDay.get(day);
                      return (
                        <td key={day} className="align-top">
                          <div className={`min-h-12 rounded-lg px-2 py-2 text-center text-xs font-semibold ${resolveEntryClassName(entry)}`}>
                            {resolveEntryLabel(entry)}
                          </div>
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
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSaveSchedule()}
            disabled={isSavingSchedule}
            className="rounded-lg bg-[#0f766e] px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-[#94a3b8]"
          >
            {isSavingSchedule ? "保存中..." : "確定シフトを保存"}
          </button>
        </div>
        <button
          type="button"
          onClick={handleAutoReflect}
          className="mt-4 w-full rounded-lg border border-[#0f766e] bg-[#ecfdf5] px-4 py-3 text-sm font-bold text-[#0f766e] sm:w-auto"
        >
          希望シフトを自動反映
        </button>

        <div className="mt-4 grid gap-3 md:grid-cols-[120px_1fr_120px_120px_auto]">
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
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">開始</span>
            <input
              type="time"
              value={assignmentStartTime}
              onChange={(event) => setAssignmentStartTime(event.target.value)}
              className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#64748b]">終了</span>
            <input
              type="time"
              value={assignmentEndTime}
              onChange={(event) => setAssignmentEndTime(event.target.value)}
              className="w-full rounded-lg border border-[#cbd5e1] px-3 py-2 text-sm font-semibold outline-none focus:border-[#0f766e]"
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
                                {assignment.startTime}-{assignment.endTime}
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
                        {candidate.startTime}-{candidate.endTime}
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
