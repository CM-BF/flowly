import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Animated, PanResponder, View } from "react-native";
import { listDropIndex, listShift } from "./geometry";
import { motionDuration, useMotionValue, useReducedMotion, lerp } from "./motion";
import { useTheme } from "./ui";

type Drag = { id: string; from: number; dy: number; to: number };

/**
 * Vertical list reordered by dragging a row with the mouse (desktop). The held
 * row follows the pointer immediately; the rows it passes slide aside. Touch
 * keeps the rows' own controls (a drag would fight the bottom sheet).
 */
export function SortableList<T extends { id: string }>({
  items,
  gap = 0,
  disabled = false,
  onMove,
  renderItem,
  handle = false,
}: {
  items: readonly T[];
  gap?: number;
  disabled?: boolean;
  onMove(id: string, to: number): void;
  /**
   * `pressable()` is false right after a drag, so the release is not a click.
   * With `handle`, spread `handleProps` on the grip: only it starts a drag
   * (rows with text fields stay selectable).
   */
  renderItem(item: T, index: number, pressable: () => boolean, handleProps: object): ReactNode;
  handle?: boolean;
}) {
  const heights = useRef<Record<string, number>>({});
  const [drag, setDragState] = useState<Drag | null>(null);
  const live = useRef<Drag | null>(null);
  const setDrag = (next: Drag | null) => {
    live.current = next;
    setDragState(next);
  };
  const suppressUntil = useRef(0);
  const pressable = () => Date.now() >= suppressUntil.current;
  const current = useRef({ items, disabled, onMove, gap });
  current.current = { items, disabled, onMove, gap };
  useEffect(() => setDrag(null), [disabled]);
  const sizes = () => current.current.items.map((i) => heights.current[i.id] || 0);
  const handlers = {
    start(id: string) {
      const from = current.current.items.findIndex((i) => i.id === id);
      if (from < 0 || current.current.disabled) return;
      setDrag({ id, from, dy: 0, to: from });
    },
    move(dy: number) {
      const d = live.current;
      if (d) setDrag({ ...d, dy, to: listDropIndex(sizes(), d.from, dy, current.current.gap) });
    },
    end(dy: number) {
      suppressUntil.current = Date.now() + 250;
      const d = live.current;
      setDrag(null);
      // Same batch as clearing the drag: the reordered list replaces the shifted one.
      if (d) {
        const to = listDropIndex(sizes(), d.from, dy, current.current.gap);
        if (to !== d.from) current.current.onMove(d.id, to);
      }
    },
    cancel() {
      setDrag(null);
    },
  };
  const size = drag ? (heights.current[drag.id] || 0) + gap : 0;
  return (
    <View style={{ gap }}>
      {items.map((item, index) => (
        <SortableRow
          key={item.id}
          id={item.id}
          held={drag?.id === item.id}
          dragging={!!drag}
          dy={drag?.id === item.id ? drag.dy : 0}
          shift={drag ? listShift(index, drag.from, drag.to, size) : 0}
          disabled={disabled || items.length < 2}
          handlers={handlers}
          onHeight={(h) => (heights.current[item.id] = h)}
          handle={handle}
          render={(handleProps) => renderItem(item, index, pressable, handleProps)}
        />
      ))}
    </View>
  );
}

function SortableRow({
  id,
  held,
  dragging,
  dy,
  shift,
  disabled,
  handlers,
  onHeight,
  handle,
  render,
}: {
  id: string;
  held: boolean;
  dragging: boolean;
  dy: number;
  shift: number;
  disabled: boolean;
  handlers: { start(id: string): void; move(dy: number): void; end(dy: number): void; cancel(): void };
  onHeight(height: number): void;
  handle: boolean;
  render(handleProps: object): ReactNode;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [slide] = useState(() => new Animated.Value(0));
  useLayoutEffect(() => {
    // Rows settle instantly when the drag ends: the new order takes their place.
    if (!dragging || reduced) {
      slide.setValue(dragging ? shift : 0);
      return;
    }
    const animation = Animated.timing(slide, { toValue: shift, duration: motionDuration.feedback, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [dragging, shift, reduced, slide]);
  const lift = useMotionValue(held ? 1 : 0);
  const mousePress = useRef(false),
    active = useRef(false);
  const current = useRef({ id, disabled, handlers });
  current.current = { id, disabled, handlers };
  useEffect(
    () => () => {
      if (active.current) current.current.handlers.cancel();
    },
    [],
  );
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) =>
        !current.current.disabled && mousePress.current && Math.abs(g.dy) >= 6,
      onPanResponderGrant: () => {
        active.current = true;
        current.current.handlers.start(current.current.id);
      },
      onPanResponderMove: (_e, g) => {
        if (active.current) current.current.handlers.move(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        mousePress.current = false;
        if (!active.current) return;
        active.current = false;
        current.current.handlers.end(g.dy);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => {
        mousePress.current = false;
        if (!active.current) return;
        active.current = false;
        current.current.handlers.cancel();
      },
    }),
  ).current;
  const dragProps = {
    ...(disabled ? {} : pan.panHandlers),
    onPointerDown: (e: { nativeEvent: { pointerType?: string; button?: number } }) => {
      mousePress.current = e.nativeEvent.pointerType === "mouse" && e.nativeEvent.button === 0;
    },
    onPointerUp: () => {
      mousePress.current = false;
    },
  };
  return (
    <Animated.View
      {...(handle ? {} : dragProps)}
      onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
      style={{
        zIndex: held ? 2 : 0,
        borderRadius: 8,
        backgroundColor: held ? colors.surface0 : "transparent",
        shadowColor: "#000",
        shadowOpacity: held ? 0.14 : 0,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        // The held row tracks the pointer immediately; the others slide.
        transform: [
          held ? { translateY: dy } : { translateY: slide },
          { scale: lerp(lift, [1, 1.01]) },
        ],
        ...(held ? ({ cursor: "grabbing" } as object) : {}),
      }}
    >
      {render(handle ? dragProps : {})}
    </Animated.View>
  );
}
