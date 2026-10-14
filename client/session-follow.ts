import { useRef, useState } from "react";
import type { NativeScrollEvent, ScrollView } from "react-native";

/** Preserve reading position when content grows, but yield to upward user scrolling. */
export function createTailFollower() {
  let following = true;
  let dragging = false;
  let previous = { y: 0, height: 0, viewport: 0 };
  return {
    get following() {
      return following;
    },
    resume() {
      following = true;
    },
    beginDrag() {
      dragging = true;
    },
    endDrag() {
      dragging = false;
    },
    scroll(
      event: Pick<
        NativeScrollEvent,
        "contentOffset" | "contentSize" | "layoutMeasurement"
      >,
    ) {
      const next = {
        y: event.contentOffset.y,
        height: event.contentSize.height,
        viewport: event.layoutMeasurement.height,
      };
      const nearEnd = next.height - next.viewport - next.y <= 64;
      const movedUp =
        next.y < previous.y - 1 &&
        next.height >= previous.height &&
        next.viewport === previous.viewport;
      if (nearEnd) following = true;
      else if (dragging || movedUp) following = false;
      previous = next;
      return following;
    },
  };
}

export function useSessionFollowTail() {
  const scrollRef = useRef<ScrollView>(null);
  const follower = useRef(createTailFollower());
  const [following, setFollowing] = useState(true);
  const scrollToTail = () => {
    if (follower.current.following)
      scrollRef.current?.scrollToEnd({ animated: false });
  };
  return {
    scrollRef,
    following,
    scrollToTail,
    jumpToLatest() {
      follower.current.resume();
      setFollowing(true);
      scrollToTail();
    },
    onScroll(event: { nativeEvent: NativeScrollEvent }) {
      setFollowing(follower.current.scroll(event.nativeEvent));
    },
    onScrollBeginDrag() {
      follower.current.beginDrag();
    },
    onScrollEndDrag() {
      follower.current.endDrag();
    },
  };
}

/** Throttle bursts with a guaranteed trailing refresh, cancelled with the subscription. */
export function coalescedRefresh(refresh: () => void, delay = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  return {
    trigger() {
      if (disposed || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) refresh();
      }, delay);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
