import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AccessibilityInfo, Animated, Easing, Platform, type ViewProps } from "react-native";

export const motionDuration = { feedback: 120, forward: 220, reverse: 160 } as const;
const ReduceMotion = createContext(true);

export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", (next) => {
      changed = true;
      if (alive) setReduced(next);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((next) => {
      // An event received after the query began is newer than its result.
      if (alive && !changed) setReduced(next);
    }).catch(() => {});
    return () => {
      alive = false;
      listener.remove();
    };
  }, []);
  return <ReduceMotion.Provider value={reduced}>{children}</ReduceMotion.Provider>;
}

function timing(value: Animated.Value, toValue: number, duration: number, nativeDriver = Platform.OS !== "web") {
  return Animated.timing(value, {
    toValue,
    duration,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: nativeDriver,
    isInteraction: false,
  });
}

export function useMotionValue(target: number, duration: number = motionDuration.feedback, initial = target) {
  const reduced = useContext(ReduceMotion);
  const [value] = useState(() => new Animated.Value(initial));
  useLayoutEffect(() => {
    if (reduced) {
      value.setValue(target);
      return;
    }
    const animation = timing(value, target, duration);
    animation.start();
    return () => animation.stop();
  }, [value, target, duration, reduced]);
  return value;
}

/** Retain an inert visual shell during exit; never let an old exit remove a new target. */
export function useMotionPresence<T>(item: T | undefined | null, key: string, nativeDriver = Platform.OS !== "web") {
  const reduced = useContext(ReduceMotion);
  const held = useRef(item);
  if (item) held.current = item;
  const [retained, setRetained] = useState(!!item);
  const [progress] = useState(() => new Animated.Value(item ? 1 : 0));
  const heldKey = useRef(key);
  const generation = useRef(0);
  useLayoutEffect(() => {
    if (key) setRetained(true);
  }, [key]);
  useLayoutEffect(() => {
    const run = ++generation.current;
    let alive = true;
    if (key && key !== heldKey.current) {
      heldKey.current = key;
      progress.setValue(reduced ? 1 : 0);
    }
    const finish = () => {
      if (alive && generation.current === run && !key) {
        heldKey.current = "";
        held.current = undefined;
        setRetained(false);
      }
    };
    if (reduced) {
      progress.setValue(key ? 1 : 0);
      finish();
      return () => { alive = false; };
    }
    const animation = timing(progress, key ? 1 : 0, key ? motionDuration.forward : motionDuration.reverse, nativeDriver);
    animation.start(({ finished }) => { if (finished) finish(); });
    return () => {
      alive = false;
      animation.stop();
    };
  }, [key, reduced, progress, nativeDriver]);
  return { item: item || (retained ? held.current : undefined), active: !!item, progress };
}

/** Animate navigation identity, never streaming output or a background refetch. */
export function MotionReveal({
  transitionKey,
  direction = 1,
  distance = 18,
  children,
  style,
  ...props
}: ViewProps & { transitionKey: string; direction?: number; distance?: number }) {
  const reduced = useContext(ReduceMotion);
  const [progress] = useState(() => new Animated.Value(1));
  const previous = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (previous.current === transitionKey || reduced) {
      previous.current = transitionKey;
      progress.setValue(1);
      return;
    }
    previous.current = transitionKey;
    progress.setValue(0);
    const animation = timing(progress, 1, direction < 0 ? motionDuration.reverse : motionDuration.forward);
    animation.start();
    return () => animation.stop();
  }, [transitionKey, direction, reduced, progress]);
  return (
    <Animated.View {...props} style={[style, {
      opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }),
      transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [direction * distance, 0] }) }],
    }]}>{children}</Animated.View>
  );
}

/**
 * Slow breathing dot for "working" states. Static under Reduce Motion; the
 * loop stops on unmount or when `active` turns off.
 */
export function PulseDot({ color, size = 8, active = true }: { color: string; size?: number; active?: boolean }) {
  const reduced = useContext(ReduceMotion);
  const [value] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active || reduced) {
      value.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        timing(value, 0.35, 800),
        timing(value, 1, 800),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      value.setValue(1);
    };
  }, [active, reduced, value]);
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: value }}
    />
  );
}
