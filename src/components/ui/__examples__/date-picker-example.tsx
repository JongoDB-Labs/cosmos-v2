"use client";
import { useState } from "react";
import { DatePicker } from "../date-picker";

export function DatePickerBasic() {
  const [value, setValue] = useState("");
  return (
    <div className="max-w-xs">
      <DatePicker
        value={value}
        onValueChange={setValue}
        aria-label="Due date"
      />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Selected: {value || "(none)"}
      </p>
    </div>
  );
}

export function DatePickerPreset() {
  const [value, setValue] = useState("2026-06-15");
  return (
    <div className="max-w-xs">
      <DatePicker
        value={value}
        onValueChange={setValue}
        placeholder="Pick a date"
        aria-label="Start date"
      />
    </div>
  );
}
