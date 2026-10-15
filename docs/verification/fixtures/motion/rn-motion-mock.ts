import React from "react";

type Completion = (result: { finished: boolean }) => void;
type Animation = { config: any; completion?: Completion; stopped: boolean };

export const motionMockState = {
  reducedQuery: Promise.resolve(false) as Promise<boolean>,
  listeners: new Set<(value: boolean) => void>(),
  listenerRemovals: 0,
  animations: [] as Animation[],
  toastShow: ((..._args: any[]) => undefined) as (...args: any[]) => unknown,
  reset() {
    this.reducedQuery = Promise.resolve(false);
    this.listeners.clear();
    this.listenerRemovals = 0;
    this.animations.length = 0;
    this.toastShow = () => undefined;
  },
  emitReduceMotion(value: boolean) {
    for (const listener of [...this.listeners]) listener(value);
  },
  finish(index: number, finished = true) {
    const animation = this.animations[index];
    animation?.completion?.({ finished });
  },
};

class Value {
  current: number;
  constructor(value: number) { this.current = value; }
  setValue(value: number) { this.current = value; }
  interpolate(config: any) { return { __interpolated: true, value: this.current, config }; }
}

export function createReactNativeMotionMock() {
  const Animated = {
    Value,
    View: React.forwardRef<any, any>(({ children, ...props }, ref) =>
      React.createElement("View", { ...props, ref }, children)),
    timing(value: Value, config: any) {
      const animation: Animation = { config: { ...config, value }, stopped: false };
      motionMockState.animations.push(animation);
      return {
        start(completion?: Completion) { animation.completion = completion; },
        stop() { animation.stopped = true; },
      };
    },
    parallel(animations: any[]) { return { start: (cb?: Completion) => animations.forEach((x) => x.start(cb)), stop: () => animations.forEach((x) => x.stop()) }; },
    sequence(animations: any[]) { return { start: (cb?: Completion) => animations.forEach((x) => x.start(cb)), stop: () => animations.forEach((x) => x.stop()) }; },
  };
  return {
    Animated,
    AccessibilityInfo: {
      isReduceMotionEnabled: () => process.env.MOTION_TEST_REDUCED === "true" ? Promise.resolve(true) : motionMockState.reducedQuery,
      addEventListener: (_event: string, listener: (value: boolean) => void) => {
        motionMockState.listeners.add(listener);
        return { remove: () => { motionMockState.listenerRemovals++; motionMockState.listeners.delete(listener); } };
      },
    },
    Easing: { cubic: (value: number) => value, quad: (value: number) => value * value, out: (fn: any) => fn, in: (fn: any) => fn },
    Platform: { OS: "web" },
  };
}

export function createHostToastMock() {
  return {
    useToast: () => ({ show: (...args: any[]) => motionMockState.toastShow(...args) }),
  };
}
