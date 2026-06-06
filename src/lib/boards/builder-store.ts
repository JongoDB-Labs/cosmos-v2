import { create } from "zustand";
import type { BuilderWidget } from "@/types/models";

const MAX_UNDO = 50;

interface BuilderState {
  widgets: BuilderWidget[];
  selectedWidgetId: string | null;
  undoStack: BuilderWidget[][];
  redoStack: BuilderWidget[][];
  isDirty: boolean;
  boardName: string;
}

interface BuilderActions {
  addWidget: (widget: BuilderWidget) => void;
  removeWidget: (id: string) => void;
  updateWidgetConfig: (id: string, config: Record<string, unknown>) => void;
  updateWidgetLayout: (
    id: string,
    layout: { x: number; y: number; w: number; h: number }
  ) => void;
  selectWidget: (id: string | null) => void;
  undo: () => void;
  redo: () => void;
  setBoardName: (name: string) => void;
  loadFromBoard: (name: string, widgets: BuilderWidget[]) => void;
  save: () => BuilderWidget[];
  markDirty: () => void;
}

function pushUndo(state: BuilderState): Pick<BuilderState, "undoStack" | "redoStack"> {
  const stack = [...state.undoStack, state.widgets];
  return {
    undoStack: stack.length > MAX_UNDO ? stack.slice(stack.length - MAX_UNDO) : stack,
    redoStack: [],
  };
}

export const useBuilderStore = create<BuilderState & BuilderActions>((set, get) => ({
  widgets: [],
  selectedWidgetId: null,
  undoStack: [],
  redoStack: [],
  isDirty: false,
  boardName: "",

  addWidget: (widget) =>
    set((state) => ({
      ...pushUndo(state),
      widgets: [...state.widgets, widget],
      selectedWidgetId: widget.id,
      isDirty: true,
    })),

  removeWidget: (id) =>
    set((state) => ({
      ...pushUndo(state),
      widgets: state.widgets.filter((w) => w.id !== id),
      selectedWidgetId: state.selectedWidgetId === id ? null : state.selectedWidgetId,
      isDirty: true,
    })),

  updateWidgetConfig: (id, config) =>
    set((state) => ({
      ...pushUndo(state),
      widgets: state.widgets.map((w) =>
        w.id === id ? { ...w, config: { ...w.config, ...config } } : w
      ),
      isDirty: true,
    })),

  updateWidgetLayout: (id, layout) =>
    set((state) => ({
      ...pushUndo(state),
      widgets: state.widgets.map((w) => (w.id === id ? { ...w, layout } : w)),
      isDirty: true,
    })),

  selectWidget: (id) => set({ selectedWidgetId: id }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const prev = state.undoStack[state.undoStack.length - 1];
      return {
        widgets: prev,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, state.widgets],
        isDirty: true,
      };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return state;
      const next = state.redoStack[state.redoStack.length - 1];
      return {
        widgets: next,
        undoStack: [...state.undoStack, state.widgets],
        redoStack: state.redoStack.slice(0, -1),
        isDirty: true,
      };
    }),

  setBoardName: (name) => set({ boardName: name, isDirty: true }),

  loadFromBoard: (name, widgets) =>
    set({
      boardName: name,
      widgets,
      selectedWidgetId: null,
      undoStack: [],
      redoStack: [],
      isDirty: false,
    }),

  save: () => {
    const widgets = get().widgets;
    set({ isDirty: false });
    return widgets;
  },
  // Re-flag as dirty after a failed save so the Save button re-enables for a
  // retry (save() optimistically cleared the flag).
  markDirty: () => set({ isDirty: true }),
}));
