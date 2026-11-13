/**
 * A board row as a READER receives it.
 *
 * `ownerId` decides who may change a board without managing the project
 * (`canManageOwnBoard`). Who made each board is not something every reader of
 * the project needs — the tab strip already gets only a yes/no
 * (`ownedBoardIds`) — so the API sends the same yes/no: `ownedByMe`, true when
 * the caller made this board. The id itself stays on the server.
 */
export type BoardForReader<T> = Omit<T, "ownerId"> & { ownedByMe: boolean };

export function boardForReader<T extends { ownerId?: string | null }>(
  board: T,
  userId: string,
): BoardForReader<T> {
  const { ownerId, ...rest } = board;
  return { ...rest, ownedByMe: ownerId != null && ownerId === userId };
}
