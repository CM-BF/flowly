import React, { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { motionMockState } from "./rn-motion-mock";

vi.mock("react-native", async () => ({ ...(await import("./rn-motion-mock")).createReactNativeMotionMock() }));
const rendererPath = process.env.MOTION_TEST_RENDERER;
const renderer = rendererPath ? require(rendererPath) : null;
const { act, create } = renderer || { act: (fn: () => unknown) => fn(), create: () => undefined };
const { MotionProvider, MotionReveal, useMotionPresence, useMotionValue } = await import("../../../../client/motion");

function ValueProbe({ target = 1 }: { target?: number }) {
  const value = useMotionValue(target, 120, 0);
  return <ValueSnapshot value={(value as any).current} />;
}
function ValueSnapshot({ value }: { value: number }) { return React.createElement("Probe", { value }); }
function PresenceProbe({ item }: { item: string }) {
  const state = useMotionPresence(item || undefined, item);
  return React.createElement("Shell", { active: state.active, keyValue: state.item || "none", progress: (state.progress as any).current }, state.item || "empty");
}
function DeferredPresenceProbe({ item, keyValue }: { item?: string; keyValue: string }) {
  const state = useMotionPresence(item, keyValue);
  return React.createElement("Shell", { active: state.active, keyValue: state.item || "none" }, state.item || "empty");
}
let resolvePreference!: (value: boolean) => void;
let rejectPreference!: (error: Error) => void;
function deferredPreference() {
  motionMockState.reducedQuery = new Promise<boolean>((resolve, reject) => { resolvePreference = resolve; rejectPreference = reject; });
}

beforeEach(() => {
  motionMockState.reset();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => { vi.clearAllMocks(); });

describe.skipIf(!rendererPath)("shared motion primitives (deterministic native callbacks)", () => {
  test("uses reduced-motion safe default, honors changed event over late query, and removes listener", async () => {
    deferredPreference();
    let tree: any;
    await act(async () => { tree = create(<MotionProvider><ValueProbe /></MotionProvider>); });
    expect(motionMockState.animations).toHaveLength(0);
    expect(motionMockState.listeners.size).toBe(1);
    act(() => motionMockState.emitReduceMotion(false));
    expect(motionMockState.animations).toHaveLength(1);
    expect(motionMockState.animations[0].config.duration).toBe(120);
    act(() => motionMockState.emitReduceMotion(true));
    expect(motionMockState.animations[0].stopped).toBe(true);
    await act(async () => { resolvePreference(false); await Promise.resolve(); });
    expect(motionMockState.animations).toHaveLength(1);
    act(() => tree.unmount());
    expect(motionMockState.listeners.size).toBe(0);
    expect(motionMockState.listenerRemovals).toBe(1);
  });

  test("preference query failure keeps the safe reduced state", async () => {
    deferredPreference();
    let tree: any;
    await act(async () => { tree = create(<MotionProvider><ValueProbe /></MotionProvider>); });
    await act(async () => { rejectPreference(new Error("accessibility unavailable")); await Promise.resolve(); });
    expect(motionMockState.animations).toHaveLength(0);
    act(() => tree.unmount());
    expect(motionMockState.listenerRemovals).toBe(1);
  });

  test("query result enables motion, and a later preference change interrupts the active value animation", async () => {
    deferredPreference();
    let tree: any;
    await act(async () => { tree = create(<MotionProvider><ValueProbe /></MotionProvider>); });
    await act(async () => { resolvePreference(false); await Promise.resolve(); });
    expect(motionMockState.animations).toHaveLength(1);
    expect(motionMockState.animations[0].config.easing).toBeTypeOf("function");
    act(() => motionMockState.emitReduceMotion(true));
    expect(motionMockState.animations[0].stopped).toBe(true);
    act(() => tree.unmount());
  });

  test("drawer-like presence reverses rapidly and ignores stale exit completion for a newer target", async () => {
    let tree: any;
    await act(async () => { tree = create(<MotionProvider><DeferredPresenceProbe item="task-a" keyValue="task-a" /></MotionProvider>); });
    const enterIndex = motionMockState.animations.length - 1;
    await act(async () => { tree.update(<MotionProvider><DeferredPresenceProbe keyValue="" /></MotionProvider>); });
    const exitIndex = motionMockState.animations.length - 1;
    expect(motionMockState.animations[exitIndex].config.duration).toBe(160);
    expect(tree.root.findByType("Shell").props.active).toBe(false);
    await act(async () => { tree.update(<MotionProvider><DeferredPresenceProbe item="task-b" keyValue="task-b" /></MotionProvider>); });
    expect(motionMockState.animations[exitIndex].stopped).toBe(true);
    motionMockState.finish(exitIndex, true);
    expect(tree.root.findByType("Shell").props.keyValue).toBe("task-b");
    expect(tree.root.findByType("Shell").props.active).toBe(true);
    expect(motionMockState.animations[enterIndex].stopped).toBe(true);
    act(() => tree.unmount());
  });

  test("MotionReveal is keyed to navigation identity and uses forward/reverse durations", async () => {
    let tree: any;
    await act(async () => { tree = create(<MotionProvider><MotionReveal transitionKey="task|details">details</MotionReveal></MotionProvider>); });
    await act(async () => { tree.update(<MotionProvider><MotionReveal transitionKey="task|session" direction={1}>session</MotionReveal></MotionProvider>); });
    expect(motionMockState.animations.at(-1)?.config.duration).toBe(220);
    await act(async () => { tree.update(<MotionProvider><MotionReveal transitionKey="task|details" direction={-1}>details</MotionReveal></MotionProvider>); });
    expect(motionMockState.animations.at(-1)?.config.duration).toBe(160);
    act(() => tree.unmount());
  });
});
