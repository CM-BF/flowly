import { useEffect, useRef, useState } from "react";
import { Animated, DeviceEventEmitter, Easing, Keyboard, Platform, StatusBar, type KeyboardEvent, type View } from "react-native";
import { keyboardOverlap } from "./geometry";

// iOS keyboard curve (approximation of UIKit's) and Android's IME insets interpolator.
const curve = () => (Platform.OS === "ios" ? Easing.bezier(0.17, 0.59, 0.4, 0.77) : Easing.bezier(0.2, 0, 0, 1));
const fallbackDuration = 250;

/**
 * Android, app-wide memory: the last keyboard top (window coordinates) for
 * focus prediction, and how much of the keyboard-controller height does not
 * cover the view (calibrated against RN's exact event; 0 = the view ends where
 * the keyboard's measured height starts).
 */
let lastKeyboardTop: number | null = null;
let controllerGap = 0;
/** keyboard-controller events seen in this app session: focus/blur prediction is then unnecessary. */
let controllerSeen = false;

type ControllerEvent = { height: number; duration?: number };

/**
 * Keeps an inline composer above the native keyboard, as close to Paseo's own
 * composer as a plugin can get without Reanimated.
 *
 * `translate` drives the composer's translateY on the native driver (UI thread,
 * no per-frame layout or JS work). `inset` is the settled amount, set once per
 * change, for padding the transcript so its end stays reachable.
 *
 * Timing: iOS follows RN's "will" events with the keyboard's own duration.
 * Android's RN events only arrive after the IME finished animating, so on
 * Android the hook listens to the "will" events that Paseo's
 * react-native-keyboard-controller (mounted by the host app) broadcasts on
 * DeviceEventEmitter when the IME animation starts, with its height and
 * duration; RN's later "did" event corrects the exact position and calibrates
 * the next prediction. Without those events it falls back to moving on input
 * focus/blur with the last keyboard height. Web: inert.
 */
export function useKeyboardInset(enabled: boolean, reduced: boolean) {
  const active = enabled && Platform.OS !== "web";
  const node = useRef<View | null>(null);
  const viewBottom = useRef<number | null>(null);
  const keyboardTop = useRef<number | null>(null);
  const controllerHeight = useRef<number | null>(null);
  const lift = useRef<Animated.Value | null>(null);
  if (!lift.current) lift.current = new Animated.Value(0);
  const value = lift.current;
  const translate = useRef<Animated.AnimatedMultiplication<number> | null>(null);
  if (!translate.current) translate.current = Animated.multiply(value, -1);
  const [inset, setInset] = useState(0);
  const target = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const animateTo = (next: number, duration?: number) => {
    if (next === target.current) return;
    target.current = next;
    animation.current?.stop();
    if (reduced || duration === 0) {
      value.setValue(next);
      setInset(next);
      return;
    }
    animation.current = Animated.timing(value, {
      toValue: next,
      duration: duration || fallbackDuration,
      easing: curve(),
      useNativeDriver: true,
    });
    // The transcript padding (a layout change and a session re-render) waits
    // for the keyboard to settle, so nothing re-lays out mid-animation.
    animation.current.start(({ finished }) => {
      if (finished && target.current === next) setInset(next);
    });
  };
  /** Exact path: a keyboard top in window coordinates (null = hidden). */
  const settle = (top: number | null, duration?: number) => {
    keyboardTop.current = top;
    if (viewBottom.current === null) return;
    animateTo(keyboardOverlap(viewBottom.current, top), duration);
  };
  const latest = useRef({ settle, animateTo });
  latest.current = { settle, animateTo };
  useEffect(() => {
    if (!active) {
      animation.current?.stop();
      keyboardTop.current = null;
      target.current = 0;
      value.setValue(0);
      setInset(0);
      return;
    }
    const iosDuration = (event: KeyboardEvent) => (Platform.OS === "ios" ? event.duration || fallbackDuration : undefined);
    const shown = (event: KeyboardEvent) => {
      // Android reports the keyboard in screen coordinates but measureInWindow
      // counts from below the status bar (the visible frame's top): convert.
      const top = event.endCoordinates.screenY - (Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0);
      const visible = event.endCoordinates.height > 0;
      if (visible) lastKeyboardTop = top;
      if (visible && controllerHeight.current !== null && viewBottom.current !== null)
        controllerGap = controllerHeight.current - keyboardOverlap(viewBottom.current, top);
      latest.current.settle(visible ? top : null, iosDuration(event));
    };
    const hidden = (event: KeyboardEvent) => latest.current.settle(null, iosDuration(event));
    const subscriptions = Platform.OS === "ios"
      ? [Keyboard.addListener("keyboardWillChangeFrame", shown), Keyboard.addListener("keyboardWillHide", hidden)]
      : [
          Keyboard.addListener("keyboardDidShow", shown),
          Keyboard.addListener("keyboardDidHide", hidden),
          // Start of the IME animation (react-native-keyboard-controller in the host app).
          DeviceEventEmitter.addListener("KeyboardController::keyboardWillShow", (event: ControllerEvent) => {
            if (!event || !(event.height > 0)) return;
            controllerSeen = true;
            controllerHeight.current = event.height;
            latest.current.animateTo(Math.max(0, Math.round(event.height - controllerGap)), event.duration);
          }),
          DeviceEventEmitter.addListener("KeyboardController::keyboardWillHide", (event: ControllerEvent) => {
            controllerSeen = true;
            controllerHeight.current = null;
            keyboardTop.current = null;
            latest.current.animateTo(0, event?.duration);
          }),
        ];
    return () => {
      subscriptions.forEach((s) => s.remove());
      animation.current?.stop();
    };
  }, [active]);
  return {
    /** Composer translateY (native driver): minus the lift. */
    translate: translate.current,
    /** Settled lift, for transcript padding. */
    inset: active ? inset : 0,
    ref: (view: View | null) => {
      node.current = view;
    },
    /** onLayout of the measured view (unaffected by the lift); the host may resize it around the keyboard. */
    onLayout: () => {
      if (!active) return;
      node.current?.measureInWindow((_x, y, _width, viewHeight) => {
        viewBottom.current = y + viewHeight;
        // Re-apply at once: a host resize is already on screen.
        if (keyboardTop.current !== null) latest.current.settle(keyboardTop.current, 0);
      });
    },
    /** Android fallback when no keyboard-controller events arrive: the IME starts opening on focus. */
    onInputFocus: () => {
      if (active && Platform.OS === "android" && !controllerSeen && lastKeyboardTop !== null && keyboardTop.current === null)
        latest.current.settle(lastKeyboardTop);
    },
    /** ...and starts closing on blur. */
    onInputBlur: () => {
      if (active && Platform.OS === "android" && !controllerSeen) latest.current.settle(null);
    },
  };
}
