"use client";

export function TypingIndicator({
  userIds,
  usersById,
}: {
  userIds: string[];
  usersById: Map<string, { displayName: string; avatarUrl: string | null }>;
}) {
  if (userIds.length === 0) return <div className="h-4" aria-hidden />;
  const names = userIds.map((id) => usersById.get(id)?.displayName ?? "Someone");
  let label: string;
  if (names.length === 1) label = `${names[0]} is typing…`;
  else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing…`;
  else label = `${names.length} people are typing…`;
  return (
    <div className="h-4 px-4 text-xs text-muted-foreground italic" aria-live="polite">
      {label}
    </div>
  );
}
